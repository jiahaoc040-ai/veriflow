//! # VeriFlow signal registry v2
//!
//! One call per asset and day, enforced by the chain.
//!
//! * **Slots, not hashes.** A commitment is stored under the key `(asset, as_of)`. A second commit for
//!   the same key is rejected, so the seller cannot commit both outcomes for one day.
//! * **Time window.** A commit for data close `as_of` is accepted only while the block time is in
//!   `[as_of + 1 day, as_of + 2 days)` UTC: after that close, and at most a day later.
//! * **Fixed assets and horizon.** `BTC` and `ETH` only, 7-day horizon. Both are constants, not init
//!   parameters. There is no upgrade, delete or replace entrypoint.
//! * **Roles.** The owner (the account that initialised the contract, kept cold) appoints one
//!   committer. The committer is replaced, never appended, and it can never be the owner. Only the
//!   committer can commit; the owner cannot. The check is on the invoking account, and the call must
//!   come from that account directly.
//! * **Reveal.** After the horizon anyone may reveal. The contract hashes the text, finds the slot by
//!   hash, parses a fixed schema, and requires `asset` and `as_of` to equal the slot key byte for byte
//!   and `signal` to follow the rule: `RISK_ON` exactly when `momentum_e6 > 0`.
//!
//! Canonical schema (keys sorted, no spaces; what Python's
//! `json.dumps(sort_keys=True, separators=(",", ":"))` produces):
//! `{"as_of":"YYYY-MM-DD","asset":"BTC","momentum_e6":-12345,"nonce":"<32 hex>","signal":"RISK_OFF"}`
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

pub const DAY_MS: u64 = 86_400_000;
/// Calls resolve 7 days after the commit's block day.
pub const HORIZON_MS: u64 = 7 * DAY_MS;
pub const ASSETS: [&str; 2] = ["BTC", "ETH"];
pub const MAX_CANONICAL_LEN: usize = 512;
/// |momentum_e6| must stay below this (a 1,000,000x move).
pub const MAX_MOMENTUM_E6: i64 = 1_000_000_000_000;

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signal {
    RiskOn,
    RiskOff,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Reveal {
    pub signal: Signal,
    pub revealed_at: Timestamp,
    pub canonical: String,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct SlotRecord {
    pub commitment: HashSha2256,
    pub committed_at: Timestamp,
    pub reveal: Option<Reveal>,
}

/// Storage key: asset index into `ASSETS`, and days since 1970-01-01 of `as_of`.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
pub struct SlotKey {
    pub asset: u8,
    pub day: u32,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    owner: AccountAddress,
    committer: Option<AccountAddress>,
    init_time: Timestamp,
    slots: StateMap<SlotKey, SlotRecord, S>,
    by_hash: StateMap<HashSha2256, SlotKey, S>,
    issued: u64,
    revealed: u64,
}

#[derive(Serialize, SchemaType)]
pub struct CommitParams {
    pub asset: String,
    pub as_of: String,
    pub commitment: HashSha2256,
}

#[derive(Serialize, SchemaType)]
pub struct SlotParams {
    pub asset: String,
    pub as_of: String,
}

#[derive(Serialize, SchemaType)]
pub struct RevealParams {
    pub canonical: String,
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq)]
pub struct Summary {
    pub owner: AccountAddress,
    pub committer: Option<AccountAddress>,
    pub horizon_ms: u64,
    pub init_time: Timestamp,
    pub issued: u64,
    pub revealed: u64,
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq)]
pub enum Event {
    Committed { asset: String, as_of: String, commitment: HashSha2256, committed_at: Timestamp },
    Revealed { asset: String, as_of: String, commitment: HashSha2256, signal: Signal, revealed_at: Timestamp },
    CommitterSet { committer: Option<AccountAddress> },
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum Error {
    #[from(ParseError)]
    ParseParams,
    #[from(LogError)]
    Log,
    NotOwner,
    NotCommitter,
    NotDirectCall,
    NoCommitter,
    OwnerCannotCommit,
    UnknownAsset,
    BadDate,
    OutsideCommitWindow,
    SlotTaken,
    HashTaken,
    UnknownCommitment,
    AlreadyRevealed,
    TooEarly,
    ContentTooLong,
    BadSchema,
    KeyMismatch,
    SignalContradictsMomentum,
    Overflow,
}

// ── pure helpers (unit-tested) ─────────────────────────────────────────────

pub fn asset_index(s: &str) -> Option<u8> {
    ASSETS.iter().position(|a| *a == s).map(|i| i as u8)
}

fn digits(b: &[u8]) -> Option<u32> {
    let mut v: u32 = 0;
    for &c in b {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + (c - b'0') as u32;
    }
    Some(v)
}

/// `YYYY-MM-DD` (exactly ten bytes, a real calendar date from 2000 to 2099) → days since 1970-01-01.
pub fn day_of(s: &str) -> Option<u32> {
    let b = s.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, m, d) = (digits(&b[0..4])?, digits(&b[5..7])?, digits(&b[8..10])?);
    if !(2000..=2099).contains(&y) || !(1..=12).contains(&m) {
        return None;
    }
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let dim = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][(m - 1) as usize];
    if d < 1 || d > dim {
        return None;
    }
    // days_from_civil (Howard Hinnant), valid for these years
    let (y, m) = (y as i64 - if m <= 2 { 1 } else { 0 }, m as i64);
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some((era * 146_097 + doe - 719_468) as u32)
}

/// Commit is allowed when the block time is in `[as_of + 1 day, as_of + 2 days)`.
pub fn in_commit_window(day: u32, now_ms: u64) -> bool {
    let open = (day as u64 + 1) * DAY_MS;
    now_ms >= open && now_ms < open + DAY_MS
}

#[derive(Debug, PartialEq, Eq)]
pub struct Parsed<'a> {
    pub as_of: &'a str,
    pub asset: &'a str,
    pub momentum_e6: i64,
    pub signal: Signal,
}

fn take<'a>(s: &'a str, lit: &str) -> Option<&'a str> {
    s.strip_prefix(lit)
}

/// Parse the fixed canonical schema. Anything else, including extra keys, spaces, a leading zero or
/// a `-0`, is rejected.
pub fn parse_canonical(s: &str) -> Option<Parsed<'_>> {
    let r = take(s, "{\"as_of\":\"")?;
    let (as_of, r) = (r.get(..10)?, r.get(10..)?);
    day_of(as_of)?;
    let r = take(r, "\",\"asset\":\"")?;
    let (asset, r) = if let Some(r) = r.strip_prefix("BTC") {
        ("BTC", r)
    } else if let Some(r) = r.strip_prefix("ETH") {
        ("ETH", r)
    } else {
        return None;
    };
    let r = take(r, "\",\"momentum_e6\":")?;
    let end = r.find(',')?;
    let (num, r) = (&r[..end], &r[end..]);
    let (neg, body) = match num.strip_prefix('-') {
        Some(b) => (true, b),
        None => (false, num),
    };
    if body.is_empty() || body.len() > 13 || !body.bytes().all(|c| c.is_ascii_digit()) {
        return None;
    }
    if body.len() > 1 && body.starts_with('0') {
        return None;
    }
    if neg && body == "0" {
        return None;
    }
    let mut v: i64 = 0;
    for c in body.bytes() {
        v = v * 10 + (c - b'0') as i64;
    }
    if v >= MAX_MOMENTUM_E6 {
        return None;
    }
    let momentum_e6 = if neg { -v } else { v };
    let r = take(r, ",\"nonce\":\"")?;
    let (nonce, r) = (r.get(..32)?, r.get(32..)?);
    if !nonce.bytes().all(|c| matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
        return None;
    }
    let r = take(r, "\",\"signal\":\"")?;
    let (signal, r) = if let Some(r) = r.strip_prefix("RISK_ON") {
        (Signal::RiskOn, r)
    } else if let Some(r) = r.strip_prefix("RISK_OFF") {
        (Signal::RiskOff, r)
    } else {
        return None;
    };
    if r != "\"}" {
        return None;
    }
    Some(Parsed { as_of, asset, momentum_e6, signal })
}

/// The published rule: `RISK_ON` exactly when `momentum_e6 > 0`.
pub fn rule(momentum_e6: i64) -> Signal {
    if momentum_e6 > 0 {
        Signal::RiskOn
    } else {
        Signal::RiskOff
    }
}

fn direct_account(ctx: &ReceiveContext) -> Result<AccountAddress, Error> {
    let invoker = ctx.invoker();
    ensure!(ctx.sender().matches_account(&invoker), Error::NotDirectCall);
    Ok(invoker)
}

fn key_of(asset: &str, as_of: &str) -> Result<SlotKey, Error> {
    let a = asset_index(asset).ok_or(Error::UnknownAsset)?;
    let day = day_of(as_of).ok_or(Error::BadDate)?;
    Ok(SlotKey { asset: a, day })
}

// ── entrypoints ────────────────────────────────────────────────────────────

#[init(contract = "veriflow_registry_v2")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    Ok(State {
        owner: ctx.init_origin(),
        committer: None,
        init_time: ctx.metadata().slot_time(),
        slots: state_builder.new_map(),
        by_hash: state_builder.new_map(),
        issued: 0,
        revealed: 0,
    })
}

/// Owner only: appoint the committer (replaces any previous one). The owner cannot appoint itself.
#[receive(contract = "veriflow_registry_v2", name = "set_committer", parameter = "AccountAddress", error = "Error", mutable, enable_logger)]
fn set_committer(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let who = direct_account(ctx)?;
    ensure!(who == host.state().owner, Error::NotOwner);
    let committer: AccountAddress = ctx.parameter_cursor().get()?;
    ensure!(committer != host.state().owner, Error::OwnerCannotCommit);
    host.state_mut().committer = Some(committer);
    logger.log(&Event::CommitterSet { committer: Some(committer) })?;
    Ok(())
}

/// Owner only: remove the committer. Nobody can commit until a new one is appointed.
#[receive(contract = "veriflow_registry_v2", name = "revoke_committer", error = "Error", mutable, enable_logger)]
fn revoke_committer(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let who = direct_account(ctx)?;
    ensure!(who == host.state().owner, Error::NotOwner);
    host.state_mut().committer = None;
    logger.log(&Event::CommitterSet { committer: None })?;
    Ok(())
}

/// Committer only: commit the SHA-256 of the call for `(asset, as_of)`.
#[receive(contract = "veriflow_registry_v2", name = "commit", parameter = "CommitParams", error = "Error", mutable, enable_logger)]
fn commit(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let who = direct_account(ctx)?;
    let committer = host.state().committer.ok_or(Error::NoCommitter)?;
    ensure!(who != host.state().owner, Error::OwnerCannotCommit);
    ensure!(who == committer, Error::NotCommitter);
    let p: CommitParams = ctx.parameter_cursor().get()?;
    let key = key_of(&p.asset, &p.as_of)?;
    let now = ctx.metadata().slot_time();
    ensure!(in_commit_window(key.day, now.timestamp_millis()), Error::OutsideCommitWindow);

    let state = host.state_mut();
    ensure!(state.slots.get(&key).is_none(), Error::SlotTaken);
    ensure!(state.by_hash.get(&p.commitment).is_none(), Error::HashTaken);
    let _ = state.slots.insert(key, SlotRecord { commitment: p.commitment, committed_at: now, reveal: None });
    let _ = state.by_hash.insert(p.commitment, key);
    state.issued = state.issued.checked_add(1).ok_or(Error::Overflow)?;
    logger.log(&Event::Committed { asset: p.asset, as_of: p.as_of, commitment: p.commitment, committed_at: now })?;
    Ok(())
}

/// Anyone, after the horizon: publish the call. The chain hashes it and checks the schema, the key and
/// the rule.
#[receive(
    contract = "veriflow_registry_v2",
    name = "reveal",
    parameter = "RevealParams",
    error = "Error",
    mutable,
    enable_logger,
    crypto_primitives
)]
fn reveal(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger, crypto: &CryptoPrimitives) -> Result<(), Error> {
    let p: RevealParams = ctx.parameter_cursor().get()?;
    ensure!(p.canonical.len() <= MAX_CANONICAL_LEN, Error::ContentTooLong);
    let commitment = crypto.hash_sha2_256(p.canonical.as_bytes());
    let now = ctx.metadata().slot_time();
    let key = *host.state().by_hash.get(&commitment).ok_or(Error::UnknownCommitment)?;
    let parsed = parse_canonical(&p.canonical).ok_or(Error::BadSchema)?;
    ensure!(key_of(parsed.asset, parsed.as_of)? == key, Error::KeyMismatch);
    ensure!(parsed.signal == rule(parsed.momentum_e6), Error::SignalContradictsMomentum);
    let (asset, as_of, signal) = (String::from(parsed.asset), String::from(parsed.as_of), parsed.signal);

    let state = host.state_mut();
    {
        let mut rec = state.slots.get_mut(&key).ok_or(Error::UnknownCommitment)?;
        ensure!(rec.reveal.is_none(), Error::AlreadyRevealed);
        let open = rec.committed_at.timestamp_millis().checked_add(HORIZON_MS).ok_or(Error::Overflow)?;
        ensure!(now.timestamp_millis() >= open, Error::TooEarly);
        rec.reveal = Some(Reveal { signal, revealed_at: now, canonical: p.canonical });
    }
    state.revealed = state.revealed.checked_add(1).ok_or(Error::Overflow)?;
    logger.log(&Event::Revealed { asset, as_of, commitment, signal, revealed_at: now })?;
    Ok(())
}

/// The record for one `(asset, as_of)`, or none.
#[receive(contract = "veriflow_registry_v2", name = "slot", parameter = "SlotParams", return_value = "Option<SlotRecord>", error = "Error")]
fn view_slot(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<SlotRecord>, Error> {
    let p: SlotParams = ctx.parameter_cursor().get()?;
    let key = key_of(&p.asset, &p.as_of)?;
    Ok(host.state().slots.get(&key).map(|r| r.clone()))
}

#[receive(contract = "veriflow_registry_v2", name = "view", return_value = "Summary", error = "Error")]
fn view(_ctx: &ReceiveContext, host: &Host<State>) -> Result<Summary, Error> {
    let s = host.state();
    Ok(Summary {
        owner: s.owner,
        committer: s.committer,
        horizon_ms: HORIZON_MS,
        init_time: s.init_time,
        issued: s.issued,
        revealed: s.revealed,
    })
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(day_of("1970-01-01"), None); // outside 2000..2099
        assert_eq!(day_of("2026-11-23"), Some(20_780));
        assert_eq!(day_of("2028-02-29"), Some(day_of("2028-02-28").unwrap() + 1));
        assert_eq!(day_of("2026-02-29"), None);
        assert_eq!(day_of("2026-11-23T00:00:00Z"), None);
        assert_eq!(day_of("2026-1-230"), None);
        assert_eq!(day_of("2026-13-01"), None);
    }

    #[test]
    fn window() {
        let d = day_of("2026-11-23").unwrap();
        let open = (d as u64 + 1) * DAY_MS;
        assert!(!in_commit_window(d, open - 1));
        assert!(in_commit_window(d, open));
        assert!(in_commit_window(d, open + DAY_MS - 1));
        assert!(!in_commit_window(d, open + DAY_MS));
    }

    const OK: &str = r#"{"as_of":"2026-11-23","asset":"BTC","momentum_e6":-12345,"nonce":"0123456789abcdef0123456789abcdef","signal":"RISK_OFF"}"#;

    #[test]
    fn schema() {
        let p = parse_canonical(OK).unwrap();
        assert_eq!((p.as_of, p.asset, p.momentum_e6, p.signal), ("2026-11-23", "BTC", -12345, Signal::RiskOff));
        for bad in [
            OK.replace("-12345", "-012345"),
            OK.replace("-12345", "-0"),
            OK.replace("-12345", "12.5"),
            OK.replace("-12345", "1e5"),
            OK.replace("BTC", "SOL"),
            OK.replace("2026-11-23", "2026-11-31"),
            OK.replace("0123456789abcdef0123456789abcdef", "0123456789ABCDEF0123456789abcdef"),
            OK.replace("\"}", "\",\"x\":1}"),
            OK.replace("{\"as_of\"", "{ \"as_of\""),
            OK.replace(",\"nonce\"", ",\"close\":1,\"nonce\""),
        ] {
            assert!(parse_canonical(&bad).is_none(), "accepted {bad}");
        }
        assert_eq!(rule(1), Signal::RiskOn);
        assert_eq!(rule(0), Signal::RiskOff);
        assert_eq!(rule(-1), Signal::RiskOff);
    }
}
