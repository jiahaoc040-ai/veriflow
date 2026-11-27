//! The escrow running in a simulated chain against a CIS-8004 test double. Build first: ./build.sh
use concordium_smart_contract_testing::*;
use concordium_std::Serial;
use veriflow_escrow::*;

const BUYER: AccountAddress = AccountAddress([1; 32]);
const WALLET: AccountAddress = AccountAddress([2; 32]);
const OWNER: AccountAddress = AccountAddress([3; 32]);
const STRANGER: AccountAddress = AccountAddress([4; 32]);
const ENERGY: Energy = Energy { energy: 200_000 };
const T0: u64 = 1_795_000_000_000;

#[derive(Serial)]
struct SetParams {
    token_id: u64,
    raw: Vec<u8>,
}

/// An agentOf record in the registry's layout: owner, no uri/hash/external ref, optional wallet, status
fn record(id: u64, wallet: Option<AccountAddress>, active: bool) -> Vec<u8> {
    let mut v = vec![1, 8];
    v.extend_from_slice(&id.to_le_bytes());
    v.extend_from_slice(&OWNER.0);
    v.extend_from_slice(&[1, 5, 0, 0, 0]);
    v.extend_from_slice(b"https");
    v.extend_from_slice(&[0, 0]);
    match wallet {
        Some(w) => {
            v.push(1);
            v.extend_from_slice(&w.0);
        }
        None => v.push(0),
    }
    v.push(if active { 0 } else { 1 });
    v
}

struct World {
    chain: Chain,
    registry: ContractAddress,
    escrow: ContractAddress,
}

fn setup() -> World {
    let mut chain = Chain::new_with_time(Timestamp::from_timestamp_millis(T0));
    for a in [BUYER, WALLET, OWNER, STRANGER] {
        chain.create_account(Account::new(a, Amount::from_ccd(1000)));
    }
    let mock = module_load_v1("mock-registry/concordium-out/mock.wasm.v1").expect("run ./build.sh first");
    let mock = chain.module_deploy_v1(Signer::with_one_key(), OWNER, mock).unwrap().module_reference;
    let registry = chain
        .contract_init(Signer::with_one_key(), OWNER, ENERGY, InitContractPayload { amount: Amount::zero(), mod_ref: mock, init_name: OwnedContractName::new_unchecked("init_mock_cis8004".into()), param: OwnedParameter::empty() })
        .unwrap()
        .contract_address;
    let m = module_load_v1("concordium-out/module.wasm.v1").expect("run ./build.sh first");
    let m = chain.module_deploy_v1(Signer::with_one_key(), OWNER, m).unwrap().module_reference;
    let escrow = chain
        .contract_init(
            Signer::with_one_key(),
            OWNER,
            ENERGY,
            InitContractPayload { amount: Amount::zero(), mod_ref: m, init_name: OwnedContractName::new_unchecked("init_veriflow_escrow".into()), param: OwnedParameter::from_serial(&InitParams { registry }).unwrap() },
        )
        .unwrap()
        .contract_address;
    let mut w = World { chain, registry, escrow };
    set_agent(&mut w, 1313, Some(WALLET), true);
    w
}

fn set_agent(w: &mut World, id: u64, wallet: Option<AccountAddress>, active: bool) {
    w.chain
        .contract_update(
            Signer::with_one_key(),
            OWNER,
            Address::Account(OWNER),
            ENERGY,
            UpdateContractPayload { amount: Amount::zero(), address: w.registry, receive_name: OwnedReceiveName::new_unchecked("mock_cis8004.set".into()), message: OwnedParameter::from_serial(&SetParams { token_id: id, raw: record(id, wallet, active) }).unwrap() },
        )
        .unwrap();
}

fn call<P: Serial>(w: &mut World, who: AccountAddress, entry: &str, amount: Amount, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    w.chain.contract_update(
        Signer::with_one_key(),
        who,
        Address::Account(who),
        ENERGY,
        UpdateContractPayload { amount, address: w.escrow, receive_name: OwnedReceiveName::new_unchecked(format!("veriflow_escrow.{entry}")), message: OwnedParameter::from_serial(p).unwrap() },
    )
}

fn err(r: Result<ContractInvokeSuccess, ContractInvokeError>) -> Error {
    r.expect_err("should be rejected").parse_return_value::<Error>().expect("a contract error")
}

fn pay(w: &mut World, who: AccountAddress, id: u64, ccd: u64, minutes: u32) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    call(w, who, "pay", Amount::from_ccd(ccd), &PayParams { token_id: id, window_minutes: minutes, memo: "order-1".into() })
}

fn escrow_of(w: &World, id: u64) -> Escrow {
    let r = w
        .chain
        .contract_invoke(BUYER, Address::Account(BUYER), ENERGY, UpdateContractPayload { amount: Amount::zero(), address: w.escrow, receive_name: OwnedReceiveName::new_unchecked("veriflow_escrow.escrow".into()), message: OwnedParameter::from_serial(&id).unwrap() })
        .unwrap();
    r.parse_return_value::<Option<Escrow>>().unwrap().expect("escrow exists")
}

fn balance(w: &World, a: AccountAddress) -> Amount {
    w.chain.account_balance_available(a).unwrap()
}

#[test]
fn pay_then_release_goes_to_the_registered_wallet_only() {
    let mut w = setup();
    let id: u64 = pay(&mut w, BUYER, 1313, 5, 60).unwrap().parse_return_value().unwrap();
    assert_eq!(id, 0);
    let e = escrow_of(&w, 0);
    assert_eq!((e.state, e.amount, e.wallet_at_pay), (EscrowState::Held, Amount::from_ccd(5), WALLET));
    assert_eq!(w.chain.contract_balance(w.escrow), Some(Amount::from_ccd(5)));
    let before = balance(&w, WALLET);
    assert_eq!(err(call(&mut w, STRANGER, "release", Amount::zero(), &0u64)), Error::NotBuyer);
    call(&mut w, BUYER, "release", Amount::zero(), &0u64).unwrap();
    assert_eq!(balance(&w, WALLET), before + Amount::from_ccd(5));
    assert_eq!(escrow_of(&w, 0).state, EscrowState::Released);
    assert_eq!(escrow_of(&w, 0).paid_to, Some(WALLET));
    assert_eq!(err(call(&mut w, BUYER, "release", Amount::zero(), &0u64)), Error::NotHeld);
}

#[test]
fn payment_to_an_agent_that_cannot_be_paid_is_rejected_on_chain() {
    let mut w = setup();
    assert_eq!(err(pay(&mut w, BUYER, 999, 1, 60)), Error::AgentNotFound);
    set_agent(&mut w, 7, None, true);
    assert_eq!(err(pay(&mut w, BUYER, 7, 1, 60)), Error::AgentHasNoWallet);
    set_agent(&mut w, 8, Some(WALLET), false);
    assert_eq!(err(pay(&mut w, BUYER, 8, 1, 60)), Error::AgentNotActive);
    assert_eq!(err(pay(&mut w, WALLET, 1313, 1, 60)), Error::SelfPayment);
    assert_eq!(err(pay(&mut w, BUYER, 1313, 0, 60)), Error::ZeroAmount);
    assert_eq!(err(pay(&mut w, BUYER, 1313, 1, 0)), Error::BadWindow);
    assert_eq!(err(pay(&mut w, BUYER, 1313, 1, MAX_WINDOW_MINUTES + 1)), Error::BadWindow);
    assert_eq!(w.chain.contract_balance(w.escrow), Some(Amount::zero()), "nothing is held after a rejection");
}

#[test]
fn the_payout_follows_the_registry_at_payout_time() {
    let mut w = setup();
    pay(&mut w, BUYER, 1313, 3, 60).unwrap();
    // The agent is revoked after the payment: release is refused, the buyer takes the money back
    set_agent(&mut w, 1313, Some(WALLET), false);
    assert_eq!(err(call(&mut w, BUYER, "release", Amount::zero(), &0u64)), Error::AgentNotActive);
    w.chain.tick_block_time(Duration::from_minutes(120)).unwrap();
    let before = balance(&w, BUYER);
    call(&mut w, BUYER, "refund", Amount::zero(), &0u64).unwrap();
    assert!(balance(&w, BUYER) > before);
    assert_eq!(escrow_of(&w, 0).state, EscrowState::Refunded);
}

#[test]
fn a_changed_wallet_is_never_paid_and_the_buyer_gets_the_money_back() {
    let mut w = setup();
    pay(&mut w, BUYER, 1313, 2, 60).unwrap();
    // The owner re-points the agent to another wallet after the payment
    set_agent(&mut w, 1313, Some(STRANGER), true);
    assert_eq!(err(call(&mut w, BUYER, "release", Amount::zero(), &0u64)), Error::WalletChanged);
    w.chain.tick_block_time(Duration::from_minutes(61)).unwrap();
    assert_eq!(err(call(&mut w, STRANGER, "claim", Amount::zero(), &0u64)), Error::NotAgentWallet);
    assert_eq!(err(call(&mut w, WALLET, "claim", Amount::zero(), &0u64)), Error::WalletChanged);
    let before = balance(&w, STRANGER);
    call(&mut w, BUYER, "refund", Amount::zero(), &0u64).unwrap();
    assert_eq!(balance(&w, STRANGER), before, "the new wallet got nothing");
    assert_eq!(escrow_of(&w, 0).state, EscrowState::Refunded);
}

#[test]
fn an_unreadable_registry_answer_after_payment_leaves_the_refund_open() {
    let mut w = setup();
    pay(&mut w, BUYER, 1313, 2, 60).unwrap();
    w.chain
        .contract_update(
            Signer::with_one_key(),
            OWNER,
            Address::Account(OWNER),
            ENERGY,
            UpdateContractPayload { amount: Amount::zero(), address: w.registry, receive_name: OwnedReceiveName::new_unchecked("mock_cis8004.set".into()), message: OwnedParameter::from_serial(&SetParams { token_id: 1313, raw: vec![1, 8, 0] }).unwrap() },
        )
        .unwrap();
    w.chain.tick_block_time(Duration::from_minutes(61)).unwrap();
    assert_eq!(err(call(&mut w, WALLET, "claim", Amount::zero(), &0u64)), Error::BadAgentRecord);
    call(&mut w, BUYER, "refund", Amount::zero(), &0u64).unwrap();
}

#[test]
fn an_unclaimed_payment_returns_to_the_buyer_after_the_claim_period() {
    let mut w = setup();
    pay(&mut w, BUYER, 1313, 2, 60).unwrap();
    w.chain.tick_block_time(Duration::from_minutes(61)).unwrap();
    assert_eq!(err(call(&mut w, BUYER, "refund", Amount::zero(), &0u64)), Error::TooLate);
    w.chain.tick_block_time(Duration::from_minutes(CLAIM_PERIOD_MINUTES)).unwrap();
    call(&mut w, BUYER, "refund", Amount::zero(), &0u64).unwrap();
}

#[test]
fn a_wallet_that_is_not_an_account_is_refused() {
    let mut w = setup();
    set_agent(&mut w, 9, Some(AccountAddress([9; 32])), true);
    assert_eq!(err(pay(&mut w, BUYER, 9, 1, 60)), Error::WalletNotAnAccount);
}

#[test]
fn dispute_window_buyer_refunds_before_seller_claims_after() {
    let mut w = setup();
    pay(&mut w, BUYER, 1313, 4, 60).unwrap();
    pay(&mut w, BUYER, 1313, 4, 60).unwrap();
    assert_eq!(err(call(&mut w, WALLET, "claim", Amount::zero(), &0u64)), Error::TooEarly);
    call(&mut w, BUYER, "refund", Amount::zero(), &0u64).unwrap();
    w.chain.tick_block_time(Duration::from_minutes(61)).unwrap();
    assert_eq!(err(call(&mut w, BUYER, "refund", Amount::zero(), &1u64)), Error::TooLate);
    assert_eq!(err(call(&mut w, STRANGER, "claim", Amount::zero(), &1u64)), Error::NotAgentWallet);
    let before = balance(&w, WALLET);
    call(&mut w, WALLET, "claim", Amount::zero(), &1u64).unwrap();
    assert!(balance(&w, WALLET) > before);
    assert_eq!(escrow_of(&w, 1).state, EscrowState::Claimed);
    assert_eq!(err(call(&mut w, BUYER, "release", Amount::from_ccd(1), &1u64)), Error::NotPayable);
    assert_eq!(err(call(&mut w, BUYER, "release", Amount::zero(), &9u64)), Error::UnknownEscrow);
}

#[test]
fn a_malformed_registry_answer_refuses_the_payment() {
    let mut w = setup();
    w.chain
        .contract_update(
            Signer::with_one_key(),
            OWNER,
            Address::Account(OWNER),
            ENERGY,
            UpdateContractPayload { amount: Amount::zero(), address: w.registry, receive_name: OwnedReceiveName::new_unchecked("mock_cis8004.set".into()), message: OwnedParameter::from_serial(&SetParams { token_id: 5, raw: vec![1, 8, 5, 0] }).unwrap() },
        )
        .unwrap();
    assert_eq!(err(pay(&mut w, BUYER, 5, 1, 60)), Error::BadAgentRecord);
}
