import assert from "node:assert/strict";
import test from "node:test";
import { loadDeliveryConfig } from "../src/delivery/config.mjs";
import { environment } from "../../validator/test/helpers/fixtures.mjs";

function configEnvironment(overrides = {}) {
  const publicConfig = environment();
  return { DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused",INDEXER_DB_SCHEMA: "delivery_fixture",
    CHAIN_A_DOMAIN: publicConfig.CHAIN_A_DOMAIN,SOURCE_GATEWAY_ADDRESS: publicConfig.SOURCE_GATEWAY_ADDRESS,
    VALIDATOR_SET_HISTORY: publicConfig.VALIDATOR_SET_HISTORY,VALIDATOR_SET_HISTORY_FILE: "",...overrides };
}

test("delivery configuration uses only database, source scope and trusted public history", () => {
  const config = loadDeliveryConfig(configEnvironment());
  assert.equal(config.chainDomain,10011n);
  assert.equal(config.validatorSets.history.length,1);
  assert.equal(config.validatorSets.history[0].validators.length,4);
  for (const field of ["privateKey","chainRpcUrl","destinationRpcUrl","listenPort"]) assert.equal(field in config,false);
  assert.equal(loadDeliveryConfig(configEnvironment({ CHAIN_A_DOMAIN: ((1n << 200n) + 1n).toString() })).chainDomain,(1n << 200n) + 1n);
});

test("delivery configuration rejects missing or conflicting trust and invalid source scope", () => {
  for (const overrides of [{ DATABASE_URL: "" },{ SOURCE_GATEWAY_ADDRESS: "invalid" },{ CHAIN_A_DOMAIN: "0" },
    { CHAIN_A_DOMAIN: "-1" },{ VALIDATOR_SET_HISTORY: "" },
    { VALIDATOR_SET_HISTORY_FILE: "another-public-history.json" }]) assert.throws(() => loadDeliveryConfig(configEnvironment(overrides)));
});
