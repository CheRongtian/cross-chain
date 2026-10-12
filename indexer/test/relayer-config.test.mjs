import assert from "node:assert/strict";
import test from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { loadRelayerConfig, publicRelayerConfig, safeRelayerMessage } from "../src/relayer/config.mjs";
import { relayerConfig, relayerEnvironment } from "./helpers/relayer-fixtures.mjs";

test("relayer configuration derives only public sender metadata and exact domain values", () => {
  const config = relayerConfig({ CHAIN_A_DOMAIN: ((1n << 200n) + 1n).toString() });
  assert.equal(config.chainDomain,(1n << 200n) + 1n);
  assert.equal(config.destinationDomain,2001n);
  assert.equal(config.maxJobs,100);
  assert.equal(config.relayerAddress,privateKeyToAccount(config.privateKey).address.toLowerCase());
  const view = publicRelayerConfig(config);
  assert.equal("privateKey" in view,false);
  assert.equal("databaseUrl" in view,false);
  assert.equal("destinationRpcUrl" in view,false);
  assert.ok(!JSON.stringify(view).includes(config.privateKey));
  assert.equal(safeRelayerMessage(new Error(`${config.privateKey} ${config.databaseUrl} ${config.destinationRpcUrl}`),config),"<redacted> <redacted> <redacted>");
});

test("invalid keys, RPC URLs, chain IDs and run limits fail configuration without leaking values", () => {
  for (const overrides of [{ CHAIN_B_RPC_URL: undefined },{ CHAIN_B_RPC_URL: "not a url" },{ CHAIN_B_RPC_URL: "file:///unused" },
    { RELAYER_A_PRIVATE_KEY: undefined },{ RELAYER_A_PRIVATE_KEY: "a-secret-invalid-key" },{ RELAYER_A_PRIVATE_KEY: `0x${"00".repeat(32)}` },
    { CHAIN_B_CHAIN_ID: "0" },{ CHAIN_B_CHAIN_ID: "-1" },{ CHAIN_B_CHAIN_ID: "1.5" },
    { CHAIN_B_CHAIN_ID: (BigInt(Number.MAX_SAFE_INTEGER) + 1n).toString() },
    { RELAYER_MAX_JOBS_PER_RUN: "0" },{ RELAYER_MAX_JOBS_PER_RUN: "1001" },{ RELAYER_MAX_JOBS_PER_RUN: "2.5" }]) {
    assert.throws(() => loadRelayerConfig(relayerEnvironment(overrides)),(error) => !error.message.includes("a-secret-invalid-key"));
  }
});
