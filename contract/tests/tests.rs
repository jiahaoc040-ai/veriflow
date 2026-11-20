//! End-to-end tests: the compiled Wasm module runs inside a simulated chain.
//! Build first: `cargo concordium build --out concordium-out/module.wasm.v1`
use concordium_smart_contract_testing::*;
use concordium_std::{HashSha2256, Serial};
use veriflow_registry::*;

const SELLER: AccountAddress = AccountAddress([1; 32]);
const STRANGER: AccountAddress = AccountAddress([2; 32]);
const WEEK_MS: u64 = 7 * 24 * 3600 * 1000;
const ENERGY: Energy = Energy { energy: 100_000 };

const CANON: &str = r#"{"as_of":"2026-11-17","asset":"BTC","close":64947.35,"issued_at":"2026-11-18T15:52:23+00:00","liquidity_z":-1.377582,"momentum":-0.209078,"nonce":"f5be8dc8e05171eaa143931fd3d7b1bf","signal":"RISK_OFF"}"#;

fn sha256(s: &str) -> HashSha2256 {
    // Same hash the off-chain service and the contract use.
    use sha2::{Digest, Sha256};
    HashSha2256(Sha256::digest(s.as_bytes()).into())
}

fn setup() -> (Chain, ContractAddress) {
    let mut chain = Chain::new_with_time(Timestamp::from_timestamp_millis(1_763_000_000_000));
    chain.create_account(Account::new(SELLER, Amount::from_ccd(1000)));
    chain.create_account(Account::new(STRANGER, Amount::from_ccd(1000)));
    let module = module_load_v1("concordium-out/module.wasm.v1").expect("build the module first");
    let deployed = chain.module_deploy_v1(Signer::with_one_key(), SELLER, module).expect("deploy");
    let init = chain
        .contract_init(
            Signer::with_one_key(),
            SELLER,
            ENERGY,
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref: deployed.module_reference,
                init_name: OwnedContractName::new_unchecked("init_veriflow_registry".into()),
                param: OwnedParameter::from_serial(&InitParams { horizon_ms: WEEK_MS }).unwrap(),
            },
        )
        .expect("init");
    (chain, init.contract_address)
}

fn update<P: Serial>(
    chain: &mut Chain,
    contract: ContractAddress,
    who: AccountAddress,
    entry: &str,
    param: &P,
) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(
        Signer::with_one_key(),
        who,
        Address::Account(who),
        ENERGY,
        UpdateContractPayload {
            amount: Amount::zero(),
            address: contract,
            receive_name: OwnedReceiveName::new_unchecked(format!("veriflow_registry.{entry}")),
            message: OwnedParameter::from_serial(param).unwrap(),
        },
    )
}

fn invoke<P: Serial>(chain: &Chain, contract: ContractAddress, entry: &str, param: &P) -> ContractInvokeSuccess {
    chain
        .contract_invoke(
            STRANGER,
            Address::Account(STRANGER),
            ENERGY,
            UpdateContractPayload {
                amount: Amount::zero(),
                address: contract,
                receive_name: OwnedReceiveName::new_unchecked(format!("veriflow_registry.{entry}")),
                message: OwnedParameter::from_serial(param).unwrap(),
            },
        )
        .expect("view")
}

fn error_of(e: ContractInvokeError) -> Error {
    e.parse_return_value::<Error>().expect("contract error")
}

fn commit(chain: &mut Chain, c: ContractAddress, who: AccountAddress, canon: &str) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    update(chain, c, who, "commit", &CommitParams { commitment: sha256(canon), asset: "BTC".into() })
}

fn reveal(chain: &mut Chain, c: ContractAddress, who: AccountAddress, canon: &str) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    update(chain, c, who, "reveal", &RevealParams { canonical: canon.into() })
}

#[test]
fn seller_commits_and_anyone_reveals_after_the_horizon() {
    let (mut chain, c) = setup();
    let committed = commit(&mut chain, c, SELLER, CANON).expect("commit");
    let events: Vec<Event> = committed.events().flat_map(|(_, es)| es.iter().map(|e| e.parse().unwrap())).collect();
    assert!(matches!(events.as_slice(), [Event::Committed { asset, .. }] if asset == "BTC"));

    chain.tick_block_time(Duration::from_millis(WEEK_MS)).unwrap();
    let revealed = reveal(&mut chain, c, STRANGER, CANON).expect("reveal by a stranger");
    let events: Vec<Event> = revealed.events().flat_map(|(_, es)| es.iter().map(|e| e.parse().unwrap())).collect();
    assert!(matches!(events.as_slice(), [Event::Revealed { signal: Signal::RiskOff, .. }]));

    let record: Option<CommitmentRecord> = invoke(&chain, c, "commitment", &sha256(CANON)).parse_return_value().unwrap();
    let record = record.expect("stored");
    let r = record.reveal.expect("revealed");
    assert_eq!(r.signal, Signal::RiskOff);
    assert_eq!(r.canonical, CANON);

    let summary: Summary = invoke(&chain, c, "view", &()).parse_return_value().unwrap();
    assert_eq!((summary.owner, summary.issued, summary.revealed, summary.horizon_ms), (SELLER, 1, 1, WEEK_MS));
}

#[test]
fn only_the_seller_can_commit() {
    let (mut chain, c) = setup();
    assert_eq!(error_of(commit(&mut chain, c, STRANGER, CANON).unwrap_err()), Error::Unauthorized);
}

#[test]
fn a_commitment_cannot_be_overwritten() {
    let (mut chain, c) = setup();
    commit(&mut chain, c, SELLER, CANON).unwrap();
    assert_eq!(error_of(commit(&mut chain, c, SELLER, CANON).unwrap_err()), Error::AlreadyCommitted);
}

#[test]
fn reveal_before_the_horizon_is_refused() {
    let (mut chain, c) = setup();
    commit(&mut chain, c, SELLER, CANON).unwrap();
    chain.tick_block_time(Duration::from_millis(WEEK_MS - 1)).unwrap();
    assert_eq!(error_of(reveal(&mut chain, c, STRANGER, CANON).unwrap_err()), Error::TooEarly);
}

#[test]
fn edited_history_does_not_match_any_commitment() {
    let (mut chain, c) = setup();
    commit(&mut chain, c, SELLER, CANON).unwrap();
    chain.tick_block_time(Duration::from_millis(WEEK_MS)).unwrap();
    let edited = CANON.replace("RISK_OFF", "RISK_ON");
    assert_eq!(error_of(reveal(&mut chain, c, SELLER, &edited).unwrap_err()), Error::UnknownCommitment);
}

#[test]
fn a_signal_is_revealed_once() {
    let (mut chain, c) = setup();
    commit(&mut chain, c, SELLER, CANON).unwrap();
    chain.tick_block_time(Duration::from_millis(WEEK_MS)).unwrap();
    reveal(&mut chain, c, STRANGER, CANON).unwrap();
    assert_eq!(error_of(reveal(&mut chain, c, STRANGER, CANON).unwrap_err()), Error::AlreadyRevealed);
}

#[test]
fn content_without_a_signal_is_refused() {
    let (mut chain, c) = setup();
    let bad = r#"{"asset":"BTC","nonce":"00"}"#;
    commit(&mut chain, c, SELLER, bad).unwrap();
    chain.tick_block_time(Duration::from_millis(WEEK_MS)).unwrap();
    assert_eq!(error_of(reveal(&mut chain, c, STRANGER, bad).unwrap_err()), Error::NoSignalInContent);
}

#[test]
fn unknown_commitment_views_as_none() {
    let (chain, c) = setup();
    let r: Option<CommitmentRecord> = invoke(&chain, c, "commitment", &sha256("nothing")).parse_return_value().unwrap();
    assert_eq!(r, None);
}
