//! End-to-end tests: the compiled Wasm module runs inside a simulated chain.
//! Build first: `cargo concordium build --schema-embed --out concordium-out/module.wasm.v1`
use concordium_smart_contract_testing::*;
use concordium_std::{HashSha2256, Serial};
use veriflow_registry_v2::*;

const OWNER: AccountAddress = AccountAddress([1; 32]);
const COMMITTER: AccountAddress = AccountAddress([2; 32]);
const STRANGER: AccountAddress = AccountAddress([3; 32]);
const ENERGY: Energy = Energy { energy: 100_000 };
const NONCE: &str = "0123456789abcdef0123456789abcdef";

fn canon(as_of: &str, asset: &str, m: i64, signal: &str) -> String {
    format!(r#"{{"as_of":"{as_of}","asset":"{asset}","momentum_e6":{m},"nonce":"{NONCE}","signal":"{signal}"}}"#)
}

fn sha256(s: &str) -> HashSha2256 {
    use sha2::{Digest, Sha256};
    HashSha2256(Sha256::digest(s.as_bytes()).into())
}

/// Chain clock at 2026-11-24 00:12 UTC: the commit window for as_of 2026-11-23.
fn setup() -> (Chain, ContractAddress) {
    let open = (day_of("2026-11-23").unwrap() as u64 + 1) * DAY_MS;
    let mut chain = Chain::new_with_time(Timestamp::from_timestamp_millis(open + 12 * 60_000));
    for a in [OWNER, COMMITTER, STRANGER] {
        chain.create_account(Account::new(a, Amount::from_ccd(1000)));
    }
    let module = module_load_v1("concordium-out/module.wasm.v1").expect("build the module first");
    let deployed = chain.module_deploy_v1(Signer::with_one_key(), OWNER, module).expect("deploy");
    let init = chain
        .contract_init(
            Signer::with_one_key(),
            OWNER,
            ENERGY,
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref: deployed.module_reference,
                init_name: OwnedContractName::new_unchecked("init_veriflow_registry_v2".into()),
                param: OwnedParameter::empty(),
            },
        )
        .expect("init");
    let c = init.contract_address;
    update(&mut chain, c, OWNER, "set_committer", &COMMITTER).expect("set committer");
    (chain, c)
}

fn update<P: Serial>(chain: &mut Chain, c: ContractAddress, who: AccountAddress, entry: &str, p: &P) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    chain.contract_update(
        Signer::with_one_key(),
        who,
        Address::Account(who),
        ENERGY,
        UpdateContractPayload {
            amount: Amount::zero(),
            address: c,
            receive_name: OwnedReceiveName::new_unchecked(format!("veriflow_registry_v2.{entry}")),
            message: OwnedParameter::from_serial(p).unwrap(),
        },
    )
}

fn invoke<P: Serial>(chain: &Chain, c: ContractAddress, entry: &str, p: &P) -> ContractInvokeSuccess {
    chain
        .contract_invoke(
            STRANGER,
            Address::Account(STRANGER),
            ENERGY,
            UpdateContractPayload {
                amount: Amount::zero(),
                address: c,
                receive_name: OwnedReceiveName::new_unchecked(format!("veriflow_registry_v2.{entry}")),
                message: OwnedParameter::from_serial(p).unwrap(),
            },
        )
        .expect("view")
}

fn err(r: Result<ContractInvokeSuccess, ContractInvokeError>) -> Error {
    r.expect_err("should fail").parse_return_value::<Error>().expect("contract error")
}

fn commit(chain: &mut Chain, c: ContractAddress, who: AccountAddress, asset: &str, as_of: &str, h: HashSha2256) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    update(chain, c, who, "commit", &CommitParams { asset: asset.into(), as_of: as_of.into(), commitment: h })
}

fn reveal(chain: &mut Chain, c: ContractAddress, text: &str) -> Result<ContractInvokeSuccess, ContractInvokeError> {
    update(chain, c, STRANGER, "reveal", &RevealParams { canonical: text.into() })
}

fn slot(chain: &Chain, c: ContractAddress, asset: &str, as_of: &str) -> Option<SlotRecord> {
    invoke(chain, c, "slot", &SlotParams { asset: asset.into(), as_of: as_of.into() }).parse_return_value().unwrap()
}

fn summary(chain: &Chain, c: ContractAddress) -> Summary {
    invoke(chain, c, "view", &()).parse_return_value().unwrap()
}

#[test]
fn roles_owner_cannot_commit_or_be_committer() {
    let (mut chain, c) = setup();
    let h = sha256(&canon("2026-11-23", "BTC", 5, "RISK_ON"));
    assert_eq!(err(commit(&mut chain, c, OWNER, "BTC", "2026-11-23", h)), Error::OwnerCannotCommit);
    assert_eq!(err(commit(&mut chain, c, STRANGER, "BTC", "2026-11-23", h)), Error::NotCommitter);
    assert_eq!(err(update(&mut chain, c, OWNER, "set_committer", &OWNER)), Error::OwnerCannotCommit);
    assert_eq!(err(update(&mut chain, c, STRANGER, "set_committer", &STRANGER)), Error::NotOwner);
    assert_eq!(err(update(&mut chain, c, COMMITTER, "revoke_committer", &())), Error::NotOwner);
    update(&mut chain, c, OWNER, "revoke_committer", &()).unwrap();
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", h)), Error::NoCommitter);
    // replacing: a new committer takes over, the old one is out
    update(&mut chain, c, OWNER, "set_committer", &STRANGER).unwrap();
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", h)), Error::NotCommitter);
    commit(&mut chain, c, STRANGER, "BTC", "2026-11-23", h).unwrap();
    assert_eq!(summary(&chain, c).committer, Some(STRANGER));
}

#[test]
fn one_call_per_asset_and_day() {
    let (mut chain, c) = setup();
    let on = canon("2026-11-23", "BTC", 5, "RISK_ON");
    let off = canon("2026-11-23", "BTC", -5, "RISK_OFF");
    commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", sha256(&on)).unwrap();
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", sha256(&off))), Error::SlotTaken);
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "ETH", "2026-11-23", sha256(&on))), Error::HashTaken);
    commit(&mut chain, c, COMMITTER, "ETH", "2026-11-23", sha256(&canon("2026-11-23", "ETH", -1, "RISK_OFF"))).unwrap();
    let s = summary(&chain, c);
    assert_eq!((s.issued, s.revealed, s.horizon_ms), (2, 0, 7 * DAY_MS));
    assert!(slot(&chain, c, "BTC", "2026-11-23").is_some());
    assert!(slot(&chain, c, "BTC", "2026-11-22").is_none());
}

#[test]
fn commit_window_assets_and_dates() {
    let (mut chain, c) = setup();
    let h = |a: &str, d: &str| sha256(&canon(d, a, 1, "RISK_ON"));
    // window is [as_of+1d, as_of+2d): today 2026-11-24 00:12 accepts only as_of 2026-11-23
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-22", h("BTC", "2026-11-22"))), Error::OutsideCommitWindow);
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-24", h("BTC", "2026-11-24"))), Error::OutsideCommitWindow);
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "SOL", "2026-11-23", h("SOL", "2026-11-23"))), Error::UnknownAsset);
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "btc", "2026-11-23", h("btc", "2026-11-23"))), Error::UnknownAsset);
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23T00:00:00Z", h("BTC", "x"))), Error::BadDate);
    // the last millisecond of the window still works, the next one does not
    chain.tick_block_time(Duration::from_millis(DAY_MS - 12 * 60_000 - 1)).unwrap();
    commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", h("BTC", "2026-11-23")).unwrap();
    chain.tick_block_time(Duration::from_millis(1)).unwrap();
    assert_eq!(err(commit(&mut chain, c, COMMITTER, "ETH", "2026-11-23", h("ETH", "2026-11-23"))), Error::OutsideCommitWindow);
}

#[test]
fn reveal_checks_hash_schema_key_rule_and_horizon() {
    let (mut chain, c) = setup();
    let good = canon("2026-11-23", "BTC", 123, "RISK_ON");
    let lie = canon("2026-11-23", "ETH", 123, "RISK_OFF"); // contradicts its own momentum
    let swapped = canon("2026-11-22", "BTC", 1, "RISK_ON"); // committed under 2026-11-23 below
    commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", sha256(&good)).unwrap();
    commit(&mut chain, c, COMMITTER, "ETH", "2026-11-23", sha256(&lie)).unwrap();

    assert_eq!(err(reveal(&mut chain, c, &good)), Error::TooEarly);
    chain.tick_block_time(Duration::from_millis(7 * DAY_MS - 1)).unwrap();
    assert_eq!(err(reveal(&mut chain, c, &good)), Error::TooEarly);
    chain.tick_block_time(Duration::from_millis(1)).unwrap();

    assert_eq!(err(reveal(&mut chain, c, &good.replace("123", "124"))), Error::UnknownCommitment);
    assert_eq!(err(reveal(&mut chain, c, &lie)), Error::SignalContradictsMomentum);
    assert_eq!(err(reveal(&mut chain, c, &swapped)), Error::UnknownCommitment);
    reveal(&mut chain, c, &good).unwrap();
    assert_eq!(err(reveal(&mut chain, c, &good)), Error::AlreadyRevealed);

    let rec = slot(&chain, c, "BTC", "2026-11-23").unwrap();
    let r = rec.reveal.unwrap();
    assert_eq!((r.signal, r.canonical.as_str()), (Signal::RiskOn, good.as_str()));
    assert_eq!(summary(&chain, c).revealed, 1);
}

#[test]
fn reveal_rejects_content_whose_key_differs_from_the_slot() {
    let (mut chain, c) = setup();
    // a hash of an ETH call committed under the BTC key: revealable text, wrong slot
    let eth = canon("2026-11-23", "ETH", 7, "RISK_ON");
    commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", sha256(&eth)).unwrap();
    chain.tick_block_time(Duration::from_millis(7 * DAY_MS)).unwrap();
    assert_eq!(err(reveal(&mut chain, c, &eth)), Error::KeyMismatch);
    // and a non-schema text committed under a key can never be revealed
    let junk = r#"{"as_of":"2026-11-23","asset":"BTC","signal":"RISK_ON"}"#;
    let (mut chain, c) = setup();
    commit(&mut chain, c, COMMITTER, "BTC", "2026-11-23", sha256(junk)).unwrap();
    chain.tick_block_time(Duration::from_millis(7 * DAY_MS)).unwrap();
    assert_eq!(err(reveal(&mut chain, c, junk)), Error::BadSchema);
}

#[test]
fn summary_records_owner_and_init_time() {
    let (chain, c) = setup();
    let s = summary(&chain, c);
    assert_eq!(s.owner, OWNER);
    assert_eq!(s.issued, 0);
    assert!(s.init_time.timestamp_millis() > 0);
}
