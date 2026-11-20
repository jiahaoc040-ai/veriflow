//! Prints byte-exact encodings of the contract's types, used by the TypeScript
//! client tests (gateway/test/contract.test.ts). Run: cargo run --example fixtures
use concordium_std::*;
use veriflow_registry::*;

fn hex<T: Serial>(v: &T) -> String {
    to_bytes(v).iter().map(|b| format!("{b:02x}")).collect()
}

fn main() {
    let c = HashSha2256([0xab; 32]);
    let rec = Some(CommitmentRecord {
        asset: "BTC".into(),
        committed_at: Timestamp::from_timestamp_millis(1_763_000_000_000),
        reveal: Some(Reveal {
            signal: Signal::RiskOff,
            revealed_at: Timestamp::from_timestamp_millis(1_763_604_800_000),
            canonical: r#"{"signal":"RISK_OFF"}"#.into(),
        }),
    });
    let unrevealed = Some(CommitmentRecord {
        asset: "ETH".into(),
        committed_at: Timestamp::from_timestamp_millis(5),
        reveal: None,
    });
    let summary = Summary { owner: AccountAddress([7; 32]), horizon_ms: 604_800_000, issued: 3, revealed: 1 };
    let event = Event::Committed { commitment: c, asset: "BTC".into(), committed_at: Timestamp::from_timestamp_millis(9) };
    println!("{{");
    println!("  \"init\": \"{}\",", hex(&InitParams { horizon_ms: 604_800_000 }));
    println!("  \"commit\": \"{}\",", hex(&CommitParams { commitment: c, asset: "BTC".into() }));
    println!("  \"reveal\": \"{}\",", hex(&RevealParams { canonical: r#"{"signal":"RISK_ON"}"#.into() }));
    println!("  \"record_revealed\": \"{}\",", hex(&rec));
    println!("  \"record_unrevealed\": \"{}\",", hex(&unrevealed));
    println!("  \"record_none\": \"{}\",", hex(&None::<CommitmentRecord>));
    println!("  \"summary\": \"{}\",", hex(&summary));
    println!("  \"event_committed\": \"{}\"", hex(&event));
    println!("}}");
}
