import assert from "node:assert/strict";
import test from "node:test";

import { loadConfig, loadDatabaseConfig } from "../src/config.mjs";

const VALID_ENVIRONMENT = {
  CHAIN_A_RPC_URL: "http://127.0.0.1:4545",
  CHAIN_A_DOMAIN: "10011",
  SOURCE_GATEWAY_ADDRESS: "0x0000000000000000000000000000000000001001",
  SOURCE_GATEWAY_START_BLOCK: "42",
  DATABASE_URL: "postgresql://indexer:secret@127.0.0.1/cross_chain",
  INDEXER_BLOCK_RANGE: "500",
  INDEXER_POLL_INTERVAL_MS: "250",
  INDEXER_DB_SCHEMA: "indexer_test",
};

test("loads and normalizes valid Indexer configuration", () => {
  const config = loadConfig(VALID_ENVIRONMENT);

  assert.equal(config.chainRpcUrl, VALID_ENVIRONMENT.CHAIN_A_RPC_URL);
  assert.equal(config.chainDomain, 10_011n);
  assert.equal(config.sourceGateway, VALID_ENVIRONMENT.SOURCE_GATEWAY_ADDRESS);
  assert.equal(config.sourceGatewayStartBlock, 42n);
  assert.equal(config.blockRange, 500n);
  assert.equal(config.pollIntervalMs, 250);
  assert.equal(config.databaseSchema, "indexer_test");
});

test("loads database-only configuration without chain settings", () => {
  const config = loadDatabaseConfig({
    DATABASE_URL: VALID_ENVIRONMENT.DATABASE_URL,
    INDEXER_DB_SCHEMA: "migration_test",
  });

  assert.equal(config.databaseUrl, VALID_ENVIRONMENT.DATABASE_URL);
  assert.equal(config.databaseSchema, "migration_test");
});

for (const [name, value, message] of [
  ["CHAIN_A_RPC_URL", "", /CHAIN_A_RPC_URL is required/],
  ["CHAIN_A_DOMAIN", "0", /CHAIN_A_DOMAIN must be greater than zero/],
  ["SOURCE_GATEWAY_ADDRESS", "0x1234", /invalid SourceGateway address/],
  ["SOURCE_GATEWAY_START_BLOCK", "-1", /invalid SourceGateway start block/],
  ["INDEXER_BLOCK_RANGE", "0", /INDEXER_BLOCK_RANGE must be a positive safe integer/],
  ["INDEXER_POLL_INTERVAL_MS", "0", /INDEXER_POLL_INTERVAL_MS must be a positive safe integer/],
  ["INDEXER_DB_SCHEMA", "invalid-schema", /must be a PostgreSQL identifier/],
]) {
  test(`rejects invalid ${name}`, () => {
    assert.throws(() => loadConfig({ ...VALID_ENVIRONMENT, [name]: value }), message);
  });
}

test("requires a PostgreSQL connection string", () => {
  assert.throws(
    () => loadConfig({ ...VALID_ENVIRONMENT, DATABASE_URL: "" }),
    /DATABASE_URL is required/,
  );
});
