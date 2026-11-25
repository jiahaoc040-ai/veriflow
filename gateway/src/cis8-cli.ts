/**
 * CIS-8 commands: create an EVM key, bind it to a Concordium account, look up a binding
 *   npm run cis8 -- keygen <name>   create keys/evm-<name>.json (testnet use; the private key is never printed)
 *   npm run cis8 -- bind <name>     register in CIS-8 from the REGISTRY_OWNER_KEY_FILE account (the EVM key first signs the canonical bytes)
 *   npm run cis8 -- show <name>     read from a Concordium node which account this key is currently bound to
 * EVM_NAMESPACE defaults to eip155:84532 (Base Sepolia)
 */
import "./env-file.js";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { AccountAddress, BlockHash } from "@concordium/web-sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverMessageAddress } from "viem";
import { createGrpc } from "./grpc.js";
import { env, loadAccount } from "./config.js";
import { registryTool, submit, REGISTRY_NETWORK } from "./registry.js";
import { canonicalBytes, checkEvmBinding, encodeExternalKey, EVM_KEY_TYPE, EVM_PROOF_SCHEME, ownerOfKey, ownerOfKeyRaw } from "./cis8.js";

type EvmKey = { address: `0x${string}`; publicKey: `0x${string}`; privateKey: `0x${string}` };
const NS = env("EVM_NAMESPACE", "eip155:84532");
const keyPath = (name: string) => `keys/evm-${name.replace(/[^a-z0-9-]/gi, "")}.json`;
const loadKey = (name: string): EvmKey => JSON.parse(readFileSync(keyPath(name), "utf8"));

async function main() {
  const [cmd, name] = process.argv.slice(2);
  if (!cmd || !name) throw new Error("usage: npm run cis8 -- keygen|bind|show|raw <name>");

  if (cmd === "keygen") {
    const p = keyPath(name);
    if (existsSync(p)) throw new Error(`${p} already exists; refusing to overwrite`);
    const privateKey = generatePrivateKey();
    const acct = privateKeyToAccount(privateKey);
    mkdirSync("keys", { recursive: true });
    writeFileSync(p, JSON.stringify({ address: acct.address, publicKey: acct.publicKey, privateKey }, null, 2) + "\n", { mode: 0o600 });
    console.log(`✅ ${p}\naddress:    ${acct.address}\npublic key: ${acct.publicKey}\n(the private key stays in the file; never share it)`);
    return;
  }

  const key = loadKey(name);
  const ext = { namespace: NS, keyType: EVM_KEY_TYPE, publicKey: key.publicKey };

  // Debugging: print the node's raw return bytes and the official service's owner_of_key result
  if (cmd === "raw") {
    console.log("query  :", encodeExternalKey(ext).toString("hex"));
    try { console.log("node   :", await ownerOfKeyRaw(ext)); } catch (e) { console.log("node   : error", e instanceof Error ? e.message : e); }
    try {
      const r = await registryTool("owner_of_key", { network: REGISTRY_NETWORK, external_key: { namespace: NS, key_type: EVM_KEY_TYPE, public_key_hex: key.publicKey.replace(/^0x/, "") } });
      console.log("service:", JSON.stringify(r));
    } catch (e) { console.log("service: error", e instanceof Error ? e.message : e); }
    return;
  }

  if (cmd === "show") {
    const reg = await ownerOfKey(ext);
    console.log(JSON.stringify({ address: key.address, namespace: NS, registration: reg }, null, 2));
    return;
  }

  if (cmd === "bind") {
    const owner = loadAccount(env("REGISTRY_OWNER_KEY_FILE", env("FACILITATOR_KEY_FILE")));
    const ownerB58 = AccountAddress.toBase58(owner.accountAddress);
    const grpc = createGrpc();
    const genesis = BlockHash.toHexString((await grpc.getConsensusStatus()).genesisBlock);
    const mine = canonicalBytes({ account: ownerB58, genesisHash: genesis, externalNamespace: NS, key: ext, proofScheme: EVM_PROOF_SCHEME });
    // Compare with the bytes the official service computes; if they differ, do not sign
    const canon = await registryTool("build_cis8_canonical_bytes", {
      network: REGISTRY_NETWORK,
      concordium_account: ownerB58,
      external_namespace: NS,
      external_key_namespace: NS,
      external_key_type: EVM_KEY_TYPE,
      external_public_key_hex: key.publicKey.replace(/^0x/, ""),
      proof_scheme: EVM_PROOF_SCHEME,
    });
    const theirsHex: string | undefined = canon?.canonical_bytes_hex ?? canon?.bytes_hex ?? canon?.canonical_bytes ?? canon?.hex;
    if (!theirsHex) throw new Error(`unexpected build_cis8_canonical_bytes response: ${JSON.stringify(canon).slice(0, 500)}`);
    if (theirsHex.replace(/^0x/, "").toLowerCase() !== mine.toString("hex"))
      throw new Error(`canonical bytes differ\n ours:   ${mine.toString("hex")}\n theirs: ${theirsHex}`);
    console.log(`canonical bytes match the official service (${mine.length} bytes)`);
    const acct = privateKeyToAccount(key.privateKey);
    const signature = await acct.signMessage({ message: { raw: new Uint8Array(mine) } });
    const rec = await recoverMessageAddress({ message: { raw: new Uint8Array(mine) }, signature });
    if (rec.toLowerCase() !== key.address.toLowerCase()) throw new Error("signature does not recover to the key's address");
    const built = await registryTool("build_cis8_register", {
      network: REGISTRY_NETWORK,
      sender: ownerB58,
      external_key: { namespace: NS, key_type: EVM_KEY_TYPE, public_key_hex: key.publicKey.replace(/^0x/, "") },
      proof: { scheme: EVM_PROOF_SCHEME, signature_hex: signature.replace(/^0x/, "") },
      metadata: [{ key: "role", value: env("CIS8_ROLE", "veriflow") }],
    });
    await submit(owner, built);
    const check = await checkEvmBinding({ address: key.address, publicKey: key.publicKey, namespace: NS, expectOwner: ownerB58 });
    if (!check.ok) throw new Error(`registered, but the node check failed: ${check.reason}`);
    console.log(`✅ ${key.address} (${NS}) is bound to ${ownerB58} in CIS-8, read back from a Concordium node`);
    return;
  }
  throw new Error(`unknown command ${cmd}`);
}

main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
