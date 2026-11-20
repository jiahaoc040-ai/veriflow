//! # VeriFlow signal registry
//!
//! A commit–reveal registry for trading signals on Concordium.
//!
//! * **commit** — only the registry owner (the signal seller) can commit the
//!   SHA-256 hash of a signal. The block time of the commit is recorded, so it
//!   is provable that the signal existed *before* its outcome.
//! * **reveal** — after the horizon (7 days in production) **anyone** can
//!   publish the full canonical signal. The contract hashes it on-chain and
//!   only accepts it if it matches a commitment, so the seller cannot swap,
//!   edit or cherry-pick history. Revealing before the horizon is refused, so
//!   a paid signal cannot be leaked on-chain for free.
//! * **views** — anyone can read a commitment, its reveal and the totals.
//!
//! The off-chain service keeps working with plain register-data anchors; this
//! contract makes the same guarantees enforceable by the chain itself.
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

/// Longest asset symbol accepted, e.g. "BTC".
pub const MAX_ASSET_LEN: usize = 16;
/// Longest canonical signal accepted for reveal.
pub const MAX_CANONICAL_LEN: usize = 1024;

/// The two signal values VeriFlow issues.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum Signal {
    RiskOn,
    RiskOff,
}

/// A revealed signal.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Reveal {
    pub signal: Signal,
    pub revealed_at: Timestamp,
    /// The exact canonical JSON whose SHA-256 is the commitment.
    pub canonical: String,
}

/// One committed signal.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct CommitmentRecord {
    pub asset: String,
    pub committed_at: Timestamp,
    pub reveal: Option<Reveal>,
}

/// Contract state.
#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    owner: AccountAddress,
    horizon: Duration,
    commitments: StateMap<HashSha2256, CommitmentRecord, S>,
    issued: u64,
    revealed: u64,
}

/// Parameter for `init`.
#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub struct InitParams {
    /// Minimum time between commit and public reveal, in milliseconds.
    pub horizon_ms: u64,
}

/// Parameter for `commit`.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct CommitParams {
    pub commitment: HashSha2256,
    pub asset: String,
}

/// Parameter for `reveal`: the exact canonical JSON of the signal.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct RevealParams {
    pub canonical: String,
}

/// Return value of `view`.
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Summary {
    pub owner: AccountAddress,
    pub horizon_ms: u64,
    pub issued: u64,
    pub revealed: u64,
}

/// Events logged by the contract (tag 0 = Committed, 1 = Revealed).
#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub enum Event {
    Committed {
        commitment: HashSha2256,
        asset: String,
        committed_at: Timestamp,
    },
    Revealed {
        commitment: HashSha2256,
        signal: Signal,
        revealed_at: Timestamp,
    },
}

#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum Error {
    #[from(ParseError)]
    ParseParams,
    /// Only the owner (the seller) may commit.
    Unauthorized,
    AlreadyCommitted,
    UnknownCommitment,
    AlreadyRevealed,
    /// Public reveal is only allowed once the horizon has passed.
    TooEarly,
    /// The content does not contain `"signal":"RISK_ON"` or `"signal":"RISK_OFF"`.
    NoSignalInContent,
    AssetTooLong,
    ContentTooLong,
    #[from(LogError)]
    LogFull,
    Overflow,
}

/// Reads the signal value out of VeriFlow's canonical JSON (sorted keys,
/// compact separators). Kept as plain byte matching so it is cheap on-chain.
pub fn signal_of(canonical: &str) -> Option<Signal> {
    let on = canonical.contains("\"signal\":\"RISK_ON\"");
    let off = canonical.contains("\"signal\":\"RISK_OFF\"");
    match (on, off) {
        (true, false) => Some(Signal::RiskOn),
        (false, true) => Some(Signal::RiskOff),
        _ => None, // missing, or ambiguous
    }
}

/// True when a public reveal is allowed.
pub fn horizon_passed(committed_at: Timestamp, horizon: Duration, now: Timestamp) -> bool {
    match committed_at.checked_add(horizon) {
        Some(open) => now >= open,
        None => false,
    }
}

#[init(contract = "veriflow_registry", parameter = "InitParams")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let params: InitParams = ctx.parameter_cursor().get()?;
    Ok(State {
        owner: ctx.init_origin(),
        horizon: Duration::from_millis(params.horizon_ms),
        commitments: state_builder.new_map(),
        issued: 0,
        revealed: 0,
    })
}

/// Commit the SHA-256 of a signal. Owner only.
#[receive(
    contract = "veriflow_registry",
    name = "commit",
    parameter = "CommitParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn commit(ctx: &ReceiveContext, host: &mut Host<State>, logger: &mut Logger) -> Result<(), Error> {
    let params: CommitParams = ctx.parameter_cursor().get()?;
    let owner = host.state().owner;
    ensure!(ctx.sender().matches_account(&owner), Error::Unauthorized);
    ensure!(params.asset.len() <= MAX_ASSET_LEN, Error::AssetTooLong);

    let now = ctx.metadata().slot_time();
    let record = CommitmentRecord {
        asset: params.asset.clone(),
        committed_at: now,
        reveal: None,
    };
    let state = host.state_mut();
    ensure!(state.commitments.get(&params.commitment).is_none(), Error::AlreadyCommitted);
    let _ = state.commitments.insert(params.commitment, record);
    state.issued = state.issued.checked_add(1).ok_or(Error::Overflow)?;

    logger.log(&Event::Committed {
        commitment: params.commitment,
        asset: params.asset,
        committed_at: now,
    })?;
    Ok(())
}

/// Publish a signal after its horizon. Anyone may call this; the chain checks
/// that the content hashes to an existing commitment.
#[receive(
    contract = "veriflow_registry",
    name = "reveal",
    parameter = "RevealParams",
    error = "Error",
    mutable,
    enable_logger,
    crypto_primitives
)]
fn reveal(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
    crypto_primitives: &CryptoPrimitives,
) -> Result<(), Error> {
    let params: RevealParams = ctx.parameter_cursor().get()?;
    ensure!(params.canonical.len() <= MAX_CANONICAL_LEN, Error::ContentTooLong);
    let commitment = crypto_primitives.hash_sha2_256(params.canonical.as_bytes());
    let signal = signal_of(&params.canonical).ok_or(Error::NoSignalInContent)?;
    let now = ctx.metadata().slot_time();

    let state = host.state_mut();
    let horizon = state.horizon;
    {
        let mut record = state
            .commitments
            .get_mut(&commitment)
            .ok_or(Error::UnknownCommitment)?;
        ensure!(record.reveal.is_none(), Error::AlreadyRevealed);
        ensure!(horizon_passed(record.committed_at, horizon, now), Error::TooEarly);
        record.reveal = Some(Reveal {
            signal,
            revealed_at: now,
            canonical: params.canonical,
        });
    }
    state.revealed = state.revealed.checked_add(1).ok_or(Error::Overflow)?;

    logger.log(&Event::Revealed {
        commitment,
        signal,
        revealed_at: now,
    })?;
    Ok(())
}

/// Look up one commitment.
#[receive(
    contract = "veriflow_registry",
    name = "commitment",
    parameter = "HashSha2256",
    return_value = "Option<CommitmentRecord>",
    error = "Error"
)]
fn view_commitment(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<CommitmentRecord>, Error> {
    let c: HashSha2256 = ctx.parameter_cursor().get()?;
    Ok(host.state().commitments.get(&c).map(|r| r.clone()))
}

/// Registry totals.
#[receive(contract = "veriflow_registry", name = "view", return_value = "Summary", error = "Error")]
fn view(_ctx: &ReceiveContext, host: &Host<State>) -> Result<Summary, Error> {
    let s = host.state();
    Ok(Summary {
        owner: s.owner,
        horizon_ms: s.horizon.millis(),
        issued: s.issued,
        revealed: s.revealed,
    })
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn reads_signal_from_canonical_json() {
        let on = r#"{"as_of":"2026-11-17","asset":"BTC","signal":"RISK_ON"}"#;
        let off = r#"{"as_of":"2026-11-17","asset":"BTC","nonce":"ab","signal":"RISK_OFF"}"#;
        assert_eq!(signal_of(on), Some(Signal::RiskOn));
        assert_eq!(signal_of(off), Some(Signal::RiskOff));
        assert_eq!(signal_of(r#"{"asset":"BTC"}"#), None);
        // a value can't spoof the field: inside a JSON string the quotes are escaped
        assert_eq!(signal_of(r#"{"signal":"RISK_ON","x":"\"signal\":\"RISK_OFF\""}"#), Some(Signal::RiskOn));
        // two real fields is ambiguous and refused
        assert_eq!(signal_of(r#"{"a":{"signal":"RISK_OFF"},"signal":"RISK_ON"}"#), None);
        // pretty-printed JSON is not VeriFlow's canonical form
        assert_eq!(signal_of(r#"{"signal": "RISK_ON"}"#), None);
    }

    #[test]
    fn horizon_math() {
        let t0 = Timestamp::from_timestamp_millis(1_000);
        let week = Duration::from_millis(7 * 24 * 3600 * 1000);
        let open = t0.checked_add(week).unwrap();
        assert!(!horizon_passed(t0, week, t0));
        assert!(!horizon_passed(t0, week, Timestamp::from_timestamp_millis(open.timestamp_millis() - 1)));
        assert!(horizon_passed(t0, week, open));
        assert!(!horizon_passed(Timestamp::from_timestamp_millis(u64::MAX), week, open));
    }
}
