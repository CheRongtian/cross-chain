import assert from "node:assert/strict";
import test from "node:test";
import { loadValidatorConfig } from "../src/config.mjs";
import { publicIdentity, validatorAccount } from "../src/identity.mjs";
import { developmentKeys, environment } from "./helpers/fixtures.mjs";

test("four stable secp256k1 identities, strict source/local separation, and public metadata", () => {
  const keys = developmentKeys();
  const addresses = keys.map((key) => validatorAccount(key).address.toLowerCase());
  assert.equal(new Set(addresses).size, 4);
  for (let index = 0; index < 4; index++) {
    const config = loadValidatorConfig(environment({}, index));
    assert.equal(config.validatorAddress, addresses[index]);
    assert.equal(validatorAccount(keys[index]).address.toLowerCase(), addresses[index]);
    const serialized = JSON.stringify(publicIdentity(config));
    assert.ok(!serialized.includes(keys[index]));
    assert.ok(!serialized.includes("privateKey"));
    assert.equal(config.finalityBlockDepth, 2n);
  }
});

test("malformed keys, incomplete/duplicate sets, endpoints, schemas, and policies fail early", () => {
  const valid = environment();
  const peers = JSON.parse(valid.VALIDATOR_PEERS);
  const cases = [
    { VALIDATOR_PRIVATE_KEY: "" }, { VALIDATOR_PRIVATE_KEY: "0x1234" }, { VALIDATOR_PRIVATE_KEY: `0x${"00".repeat(32)}` },
    { VALIDATOR_PRIVATE_KEY: `0x${99n.toString(16).padStart(64, "0")}` },
    { VALIDATOR_PRIVATE_KEY: `0x${"ff".repeat(32)}` }, { VALIDATOR_LISTEN_PORT: "0" }, { VALIDATOR_LISTEN_PORT: "65536" },
    { VALIDATOR_LISTEN_HOST: "invalid host" }, { VALIDATOR_PEERS: "{" },
    { VALIDATOR_PEERS: JSON.stringify(peers.slice(1)) },
    { VALIDATOR_PEERS: JSON.stringify([peers[0], peers[0], ...peers.slice(2)]) },
    { VALIDATOR_PEERS: JSON.stringify(peers.map((peer, index) => index === 1 ? { ...peer, url: peers[0].url } : peer)) },
    { VALIDATOR_PEERS: JSON.stringify(peers.map((peer) => ({ ...peer, extra: true }))) },
    { VALIDATOR_PEERS: JSON.stringify(peers.map((peer, index) => index === 0 ? { ...peer, url: "garbage" } : peer)) },
    { VALIDATOR_LISTEN_PORT: "32001" }, { SOURCE_DB_SCHEMA: "invalid-name" },
    { VALIDATOR_DB_SCHEMA: valid.SOURCE_DB_SCHEMA }, { CHAIN_A_DOMAIN: "0" }, { FINALITY_BLOCK_DEPTH: "1.5" },
    { VALIDATOR_DB_SCHEMA: valid.SOURCE_DB_SCHEMA, VALIDATOR_DATABASE_URL: "postgres://other-role:placeholder@127.0.0.1:5432/unused" },
    { SOURCE_GATEWAY_ADDRESS: "0x123" }, { CHAIN_A_RPC_URL: "file:///tmp/rpc" },
  ];
  for (const fields of cases) assert.throws(() => loadValidatorConfig({ ...valid, ...fields }));
});
