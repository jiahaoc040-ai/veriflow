//! Test double for the CIS-8004 Agent Registry, used only by the escrow's chain tests.
//! `set(token_id, raw)` stores the exact bytes `agentOf(token_id)` should return; unknown ids return `None` (one byte 0).
#![cfg_attr(target_arch = "wasm32", no_std)]
use concordium_std::*;

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S: HasStateApi = StateApi> {
    records: StateMap<u64, Vec<u8>, S>,
}

#[derive(Serialize, SchemaType)]
pub struct SetParams {
    pub token_id: u64,
    pub raw: Vec<u8>,
}

/// Raw bytes as the return value, with no length prefix (what the real registry's agentOf returns)
pub struct Raw(pub Vec<u8>);
impl Serial for Raw {
    fn serial<W: Write>(&self, out: &mut W) -> Result<(), W::Err> {
        out.write_all(&self.0)
    }
}

#[init(contract = "mock_cis8004")]
fn init(_ctx: &InitContext, b: &mut StateBuilder) -> InitResult<State> {
    Ok(State { records: b.new_map() })
}

#[receive(contract = "mock_cis8004", name = "set", parameter = "SetParams", mutable)]
fn set(ctx: &ReceiveContext, host: &mut Host<State>) -> ReceiveResult<()> {
    let p: SetParams = ctx.parameter_cursor().get()?;
    let _ = host.state_mut().records.insert(p.token_id, p.raw);
    Ok(())
}

#[receive(contract = "mock_cis8004", name = "agentOf")]
fn agent_of(ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<Raw> {
    let mut c = ctx.parameter_cursor();
    let len: u8 = c.get()?;
    ensure!(len == 8);
    let id: u64 = c.get()?;
    Ok(Raw(host.state().records.get(&id).map(|r| r.clone()).unwrap_or_else(|| Vec::from([0u8]))))
}
