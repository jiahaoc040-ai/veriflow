//! # VeriFlow agent escrow
//!
//! The seller guard's payout rule, enforced by the chain: **a payment can only ever reach the on-chain `agentWallet`
//! of an Active agent in the CIS-8004 Agent Registry.** No seller-supplied address is ever paid.
//!
//! * **pay** (payable, accounts only): the buyer names a CIS-8004 token id and a dispute window. The contract reads
//!   `agentOf` from the registry in the same transaction and rejects the payment if the agent does not exist, is not
//!   Active, has no `agentWallet`, or that wallet is the buyer itself. Otherwise the CCD is held.
//! * **release** (buyer, any time): reads `agentOf` again and pays the wallet recorded at payment, **only if the registry
//!   still names that same wallet** for an Active agent. An agent revoked, re-pointed to another wallet, or no longer
//!   readable since the payment is refused, and the buyer can take the money back.
//! * **claim** (the recorded wallet, after the dispute window): the same checks, then payment.
//! * **refund** (buyer): during the dispute window; afterwards whenever the payout is not possible (agent missing,
//!   Revoked, wallet changed or gone, registry unreadable); and in any case 30 days after the window, so held CCD
//!   can never be stuck.
//! * **escrow** / **view**: read-only.
//!
//! Every rule failure is a rejected transaction with its own error code, visible on CCDScan. There is no owner,
//! no upgrade, no fee and no way to move held CCD except the three paths above. The registry address is fixed at init.
#![cfg_attr(target_arch = "wasm32", no_std)]

use concordium_std::*;

/// Longest dispute window a buyer may set: 30 days.
pub const MAX_WINDOW_MINUTES: u32 = 30 * 24 * 60;
pub const MAX_MEMO_LEN: usize = 64;
/// After the dispute window the agent's wallet has this long to claim; then the buyer may refund in any case.
pub const CLAIM_PERIOD_MINUTES: u64 = 30 * 24 * 60;

#[derive(Serialize, SchemaType, Clone, Copy, PartialEq, Eq, Debug)]
pub enum EscrowState {
    Held,
    Released,
    Claimed,
    Refunded,
}

#[derive(Serialize, SchemaType, Clone, PartialEq, Eq, Debug)]
pub struct Escrow {
    pub buyer: AccountAddress,
    pub token_id: u64,
    pub amount: Amount,
    pub paid_at: Timestamp,
    /// Before this time the buyer may refund; from this time the agent's wallet may claim.
    pub claim_after: Timestamp,
    /// The agentWallet when the payment was made: the only account this escrow can ever pay (and only while the
    /// registry still names it).
    pub wallet_at_pay: AccountAddress,
    pub memo: String,
    pub state: EscrowState,
    /// Who received the CCD (the agent's wallet, or the buyer on refund).
    pub paid_to: Option<AccountAddress>,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S: HasStateApi = StateApi> {
    pub registry: ContractAddress,
    pub next_id: u64,
    pub escrows: StateMap<u64, Escrow, S>,
}

#[derive(Serialize, SchemaType)]
pub struct InitParams {
    /// The CIS-8004 Agent Registry (testnet <12802,0>, mainnet <10082,0>).
    pub registry: ContractAddress,
}

#[derive(Serialize, SchemaType)]
pub struct PayParams {
    pub token_id: u64,
    /// Minutes during which the buyer may still refund; afterwards the agent's wallet may claim. 1 to 43,200.
    pub window_minutes: u32,
    /// Free text for the buyer's own reference (an order or request id), at most 64 bytes.
    pub memo: String,
}

#[derive(Serialize, SchemaType)]
pub struct View {
    pub registry: ContractAddress,
    pub next_id: u64,
}

/// Events (logged in this order of variants: tags 0..3).
#[derive(Serialize, SchemaType, Debug, PartialEq, Eq)]
pub enum Event {
    Paid { id: u64, buyer: AccountAddress, token_id: u64, amount: Amount, wallet: AccountAddress, claim_after: Timestamp },
    Released { id: u64, to: AccountAddress, amount: Amount },
    Claimed { id: u64, to: AccountAddress, amount: Amount },
    Refunded { id: u64, to: AccountAddress, amount: Amount },
}

/// Rejection codes: the first variant is -1, the next -2, and so on (shown on CCDScan).
#[derive(Serialize, SchemaType, Debug, PartialEq, Eq, Reject)]
pub enum Error {
    /// -1
    #[from(ParseError)]
    ParseParams,
    /// -2: no agent with this token id in the registry
    AgentNotFound,
    /// -3: the agent is Revoked
    AgentNotActive,
    /// -4: the agent has no agentWallet bound on-chain
    AgentHasNoWallet,
    /// -5: only accounts may pay, release, claim or refund (not contracts)
    OnlyAccount,
    /// -6
    ZeroAmount,
    /// -7: only the buyer may release or refund
    NotBuyer,
    /// -8: the escrow is no longer held
    NotHeld,
    /// -9: claim before the dispute window has passed
    TooEarly,
    /// -10: refund after the dispute window while the agent is still payable
    TooLate,
    /// -11: claim by an account that is not the agent's current agentWallet
    NotAgentWallet,
    /// -12
    UnknownEscrow,
    /// -13: the registry call itself failed
    RegistryCallFailed,
    /// -14: the registry returned something this contract does not understand
    BadAgentRecord,
    /// -15: window_minutes outside 1..=43,200
    BadWindow,
    /// -16
    MemoTooLong,
    /// -17
    TransferFailed,
    /// -18
    LogFull,
    /// -19: the buyer is the agent's own wallet
    SelfPayment,
    /// -20: the registry returned a different agent than asked for
    WrongAgent,
    /// -21: no CCD may be sent with release, claim or refund
    NotPayable,
    /// -22: the registry now names a different wallet than at payment; the buyer may refund
    WalletChanged,
    /// -23: the agent's wallet is not an account on this chain
    WalletNotAnAccount,
}

impl From<LogError> for Error {
    fn from(_: LogError) -> Self {
        Error::LogFull
    }
}

/// The parts of a CIS-8004 agent record this contract needs.
#[derive(Debug, PartialEq, Eq, Clone)]
pub struct AgentRecord {
    pub token_id: u64,
    pub owner: AccountAddress,
    pub wallet: Option<AccountAddress>,
    pub active: bool,
}

/// The CIS-8004 token id as `agentOf` takes it: one length byte (8), then a little-endian u64.
pub struct TokenIdParam(pub u64);

impl Serial for TokenIdParam {
    fn serial<W: Write>(&self, out: &mut W) -> Result<(), W::Err> {
        8u8.serial(out)?;
        self.0.serial(out)
    }
}

fn read_bytes<R: Read>(r: &mut R, n: usize) -> Result<(), Error> {
    let mut buf = [0u8; 64];
    let mut left = n;
    while left > 0 {
        let k = if left > 64 { 64 } else { left };
        r.read_exact(&mut buf[..k]).map_err(|_| Error::BadAgentRecord)?;
        left -= k;
    }
    Ok(())
}

fn read_tag<R: Read>(r: &mut R) -> Result<bool, Error> {
    match u8::deserial(r).map_err(|_| Error::BadAgentRecord)? {
        0 => Ok(false),
        1 => Ok(true),
        _ => Err(Error::BadAgentRecord),
    }
}

fn read_len_prefixed<R: Read>(r: &mut R, max: u32) -> Result<(), Error> {
    let n = u32::deserial(r).map_err(|_| Error::BadAgentRecord)?;
    if n > max {
        return Err(Error::BadAgentRecord);
    }
    read_bytes(r, n as usize)
}

/// Parse the return value of `CIS-8004.agentOf` strictly (the same layout the buyer's guard decodes):
/// `Option<{ token_id: TokenIdU64, owner: AccountAddress, agent_uri: Option<String>, metadata_hash: Option<[u8;32]>,
/// external_reference: Option<{ contract, kind 0, namespace, key_type, public_key }>, agent_wallet: Option<AccountAddress>,
/// status: Active | Revoked }>`. Anything unexpected is BadAgentRecord, so the payment is refused.
pub fn parse_agent_of<R: Read>(r: &mut R) -> Result<Option<AgentRecord>, Error> {
    if !read_tag(r)? {
        return Ok(None);
    }
    if u8::deserial(r).map_err(|_| Error::BadAgentRecord)? != 8 {
        return Err(Error::BadAgentRecord);
    }
    let token_id = u64::deserial(r).map_err(|_| Error::BadAgentRecord)?;
    let owner = AccountAddress::deserial(r).map_err(|_| Error::BadAgentRecord)?;
    if read_tag(r)? {
        read_len_prefixed(r, 4096)?; // agent_uri
    }
    if read_tag(r)? {
        read_bytes(r, 32)?; // metadata_hash
    }
    if read_tag(r)? {
        read_bytes(r, 16)?; // CIS-8 contract address
        if u8::deserial(r).map_err(|_| Error::BadAgentRecord)? != 0 {
            return Err(Error::BadAgentRecord);
        }
        read_len_prefixed(r, 4096)?; // namespace
        read_len_prefixed(r, 4096)?; // key type
        read_len_prefixed(r, 4096)?; // public key
    }
    let wallet = if read_tag(r)? { Some(AccountAddress::deserial(r).map_err(|_| Error::BadAgentRecord)?) } else { None };
    let active = match u8::deserial(r).map_err(|_| Error::BadAgentRecord)? {
        0 => true,
        1 => false,
        _ => return Err(Error::BadAgentRecord),
    };
    Ok(Some(AgentRecord { token_id, owner, wallet, active }))
}

/// Who may be paid for this agent right now, or why nobody may.
pub fn payable_wallet(rec: Option<&AgentRecord>, token_id: u64) -> Result<AccountAddress, Error> {
    let rec = rec.ok_or(Error::AgentNotFound)?;
    if rec.token_id != token_id {
        return Err(Error::WrongAgent);
    }
    if !rec.active {
        return Err(Error::AgentNotActive);
    }
    rec.wallet.ok_or(Error::AgentHasNoWallet)
}

/// Same account, aliases included (they share the first 29 bytes).
pub fn same_account(a: &AccountAddress, b: &AccountAddress) -> bool {
    a.0[..29] == b.0[..29]
}

fn read_agent(host: &Host<State>, token_id: u64) -> Result<Option<AgentRecord>, Error> {
    let registry = host.state().registry;
    let rv = host
        .invoke_contract_read_only(&registry, &TokenIdParam(token_id), EntrypointName::new_unchecked("agentOf"), Amount::zero())
        .map_err(|_| Error::RegistryCallFailed)?
        .ok_or(Error::RegistryCallFailed)?;
    let mut rv = rv;
    parse_agent_of(&mut rv)
}

fn sender_account(ctx: &ReceiveContext) -> Result<AccountAddress, Error> {
    match ctx.sender() {
        Address::Account(a) => Ok(a),
        Address::Contract(_) => Err(Error::OnlyAccount),
    }
}

#[init(contract = "veriflow_escrow", parameter = "InitParams")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    let p: InitParams = ctx.parameter_cursor().get()?;
    Ok(State { registry: p.registry, next_id: 0, escrows: state_builder.new_map() })
}

#[receive(contract = "veriflow_escrow", name = "pay", parameter = "PayParams", error = "Error", mutable, payable, enable_logger)]
fn pay(ctx: &ReceiveContext, host: &mut Host<State>, amount: Amount, logger: &mut Logger) -> Result<u64, Error> {
    let buyer = sender_account(ctx)?;
    let p: PayParams = ctx.parameter_cursor().get()?;
    if amount == Amount::zero() {
        return Err(Error::ZeroAmount);
    }
    if p.window_minutes == 0 || p.window_minutes > MAX_WINDOW_MINUTES {
        return Err(Error::BadWindow);
    }
    if p.memo.len() > MAX_MEMO_LEN {
        return Err(Error::MemoTooLong);
    }
    let rec = read_agent(host, p.token_id)?;
    let wallet = payable_wallet(rec.as_ref(), p.token_id)?;
    if host.account_balance(wallet).is_err() {
        return Err(Error::WalletNotAnAccount);
    }
    if same_account(&wallet, &buyer) {
        return Err(Error::SelfPayment);
    }
    let now = ctx.metadata().slot_time();
    let claim_after = now.checked_add(Duration::from_minutes(p.window_minutes as u64)).ok_or(Error::BadWindow)?;
    let id = host.state().next_id;
    host.state_mut().next_id = id + 1;
    let _ = host.state_mut().escrows.insert(
        id,
        Escrow { buyer, token_id: p.token_id, amount, paid_at: now, claim_after, wallet_at_pay: wallet, memo: p.memo, state: EscrowState::Held, paid_to: None },
    );
    logger.log(&Event::Paid { id, buyer, token_id: p.token_id, amount, wallet, claim_after })?;
    Ok(id)
}

fn held(host: &Host<State>, id: u64) -> Result<Escrow, Error> {
    let e = host.state().escrows.get(&id).ok_or(Error::UnknownEscrow)?.clone();
    if e.state != EscrowState::Held {
        return Err(Error::NotHeld);
    }
    Ok(e)
}

fn settle(host: &mut Host<State>, id: u64, to: AccountAddress, amount: Amount, state: EscrowState) -> Result<(), Error> {
    // State first, then the transfer: a failed transfer rejects the whole transaction, state included
    if let Some(mut e) = host.state_mut().escrows.get_mut(&id) {
        e.state = state;
        e.paid_to = Some(to);
    }
    host.invoke_transfer(&to, amount).map_err(|_| Error::TransferFailed)
}

/// May this escrow be paid out now? Only to the wallet recorded at payment, only while the registry still names that
/// wallet for an Active agent, and only if it is an account on this chain.
fn payout_check(host: &Host<State>, e: &Escrow) -> Result<AccountAddress, Error> {
    let rec = read_agent(host, e.token_id)?;
    let now_wallet = payable_wallet(rec.as_ref(), e.token_id)?;
    if !same_account(&now_wallet, &e.wallet_at_pay) {
        return Err(Error::WalletChanged);
    }
    if host.account_balance(e.wallet_at_pay).is_err() {
        return Err(Error::WalletNotAnAccount);
    }
    Ok(e.wallet_at_pay)
}

#[receive(contract = "veriflow_escrow", name = "release", parameter = "u64", error = "Error", mutable, payable, enable_logger)]
fn release(ctx: &ReceiveContext, host: &mut Host<State>, sent: Amount, logger: &mut Logger) -> Result<(), Error> {
    if sent != Amount::zero() {
        return Err(Error::NotPayable);
    }
    let who = sender_account(ctx)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    let e = held(host, id)?;
    if !same_account(&who, &e.buyer) {
        return Err(Error::NotBuyer);
    }
    let wallet = payout_check(host, &e)?;
    settle(host, id, wallet, e.amount, EscrowState::Released)?;
    logger.log(&Event::Released { id, to: wallet, amount: e.amount })?;
    Ok(())
}

#[receive(contract = "veriflow_escrow", name = "claim", parameter = "u64", error = "Error", mutable, payable, enable_logger)]
fn claim(ctx: &ReceiveContext, host: &mut Host<State>, sent: Amount, logger: &mut Logger) -> Result<(), Error> {
    if sent != Amount::zero() {
        return Err(Error::NotPayable);
    }
    let who = sender_account(ctx)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    let e = held(host, id)?;
    if ctx.metadata().slot_time() < e.claim_after {
        return Err(Error::TooEarly);
    }
    if !same_account(&who, &e.wallet_at_pay) {
        return Err(Error::NotAgentWallet);
    }
    let wallet = payout_check(host, &e)?;
    settle(host, id, wallet, e.amount, EscrowState::Claimed)?;
    logger.log(&Event::Claimed { id, to: wallet, amount: e.amount })?;
    Ok(())
}

#[receive(contract = "veriflow_escrow", name = "refund", parameter = "u64", error = "Error", mutable, payable, enable_logger)]
fn refund(ctx: &ReceiveContext, host: &mut Host<State>, sent: Amount, logger: &mut Logger) -> Result<(), Error> {
    if sent != Amount::zero() {
        return Err(Error::NotPayable);
    }
    let who = sender_account(ctx)?;
    let id: u64 = ctx.parameter_cursor().get()?;
    let e = held(host, id)?;
    if !same_account(&who, &e.buyer) {
        return Err(Error::NotBuyer);
    }
    let now = ctx.metadata().slot_time();
    let claim_closes = e.claim_after.checked_add(Duration::from_minutes(CLAIM_PERIOD_MINUTES)).unwrap_or(e.claim_after);
    // After the window, while the agent can still be paid exactly as agreed, the money is the agent's to claim:
    // the buyer may take it back only once the claim period has run out. Any failure of the payout check
    // (registry unreadable, agent gone, wallet changed) leaves the refund open, so nothing can be stuck.
    if now >= e.claim_after && now < claim_closes && payout_check(host, &e).is_ok() {
        return Err(Error::TooLate);
    }
    settle(host, id, e.buyer, e.amount, EscrowState::Refunded)?;
    logger.log(&Event::Refunded { id, to: e.buyer, amount: e.amount })?;
    Ok(())
}

#[receive(contract = "veriflow_escrow", name = "escrow", parameter = "u64", return_value = "Option<Escrow>", error = "Error")]
fn escrow(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<Escrow>, Error> {
    let id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().escrows.get(&id).map(|e| e.clone()))
}

#[receive(contract = "veriflow_escrow", name = "view", return_value = "View", error = "Error")]
fn view(_ctx: &ReceiveContext, host: &Host<State>) -> Result<View, Error> {
    Ok(View { registry: host.state().registry, next_id: host.state().next_id })
}

#[cfg(test)]
mod unit {
    use super::*;

    fn record(tag: Option<(u64, Option<[u8; 32]>, u8)>, uri: bool, hash: bool, ext: bool) -> Vec<u8> {
        let mut v = Vec::new();
        match tag {
            None => v.push(0),
            Some((id, wallet, status)) => {
                v.push(1);
                v.push(8);
                v.extend_from_slice(&id.to_le_bytes());
                v.extend_from_slice(&[7u8; 32]); // owner
                if uri {
                    v.push(1);
                    v.extend_from_slice(&5u32.to_le_bytes());
                    v.extend_from_slice(b"https");
                } else {
                    v.push(0);
                }
                if hash {
                    v.push(1);
                    v.extend_from_slice(&[9u8; 32]);
                } else {
                    v.push(0);
                }
                if ext {
                    v.push(1);
                    v.extend_from_slice(&[0u8; 16]);
                    v.push(0);
                    for s in [&b"eip155:8453"[..], &b"secp256k1-compressed"[..], &[2u8; 33][..]] {
                        v.extend_from_slice(&(s.len() as u32).to_le_bytes());
                        v.extend_from_slice(s);
                    }
                } else {
                    v.push(0);
                }
                match wallet {
                    Some(w) => {
                        v.push(1);
                        v.extend_from_slice(&w);
                    }
                    None => v.push(0),
                }
                v.push(status);
            }
        }
        v
    }

    fn parse(v: &[u8]) -> Result<Option<AgentRecord>, Error> {
        parse_agent_of(&mut Cursor::new(v))
    }

    #[test]
    fn parses_every_optional_field() {
        let r = parse(&record(Some((1313, Some([5; 32]), 0)), true, true, true)).unwrap().unwrap();
        assert_eq!(r, AgentRecord { token_id: 1313, owner: AccountAddress([7; 32]), wallet: Some(AccountAddress([5; 32])), active: true });
        let r = parse(&record(Some((5, None, 1)), false, false, false)).unwrap().unwrap();
        assert_eq!(r.wallet, None);
        assert!(!r.active);
        assert_eq!(parse(&record(None, false, false, false)).unwrap(), None);
    }

    #[test]
    fn refuses_anything_unexpected() {
        let mut bad_status = record(Some((1, Some([5; 32]), 0)), false, false, false);
        *bad_status.last_mut().unwrap() = 2;
        assert_eq!(parse(&bad_status), Err(Error::BadAgentRecord));
        let mut bad_tag = record(Some((1, Some([5; 32]), 0)), false, false, false);
        bad_tag[0] = 2;
        assert_eq!(parse(&bad_tag), Err(Error::BadAgentRecord));
        let mut bad_len = record(Some((1, Some([5; 32]), 0)), false, false, false);
        bad_len[1] = 4;
        assert_eq!(parse(&bad_len), Err(Error::BadAgentRecord));
        let full = record(Some((1, Some([5; 32]), 0)), true, true, true);
        assert_eq!(parse(&full[..full.len() - 3]), Err(Error::BadAgentRecord), "truncated");
    }

    #[test]
    fn who_may_be_paid() {
        let ok = AgentRecord { token_id: 1, owner: AccountAddress([7; 32]), wallet: Some(AccountAddress([5; 32])), active: true };
        assert_eq!(payable_wallet(Some(&ok), 1), Ok(AccountAddress([5; 32])));
        assert_eq!(payable_wallet(None, 1), Err(Error::AgentNotFound));
        assert_eq!(payable_wallet(Some(&ok), 2), Err(Error::WrongAgent));
        assert_eq!(payable_wallet(Some(&AgentRecord { active: false, ..ok.clone() }), 1), Err(Error::AgentNotActive));
        assert_eq!(payable_wallet(Some(&AgentRecord { wallet: None, ..ok.clone() }), 1), Err(Error::AgentHasNoWallet));
    }

    #[test]
    fn aliases_are_the_same_account() {
        let mut b = [5u8; 32];
        b[31] = 9;
        assert!(same_account(&AccountAddress([5; 32]), &AccountAddress(b)));
        b[0] = 1;
        assert!(!same_account(&AccountAddress([5; 32]), &AccountAddress(b)));
    }

    #[test]
    fn token_id_param_layout() {
        let mut out = Vec::new();
        TokenIdParam(1313).serial(&mut out).unwrap();
        assert_eq!(out, [8, 0x21, 0x05, 0, 0, 0, 0, 0, 0]);
    }
}
