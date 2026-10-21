import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { environment } from "../../validator/test/helpers/fixtures.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { loadDeliveryConfig } from "../src/delivery/config.mjs";
import { loadMessageQueryConfig } from "../src/api/config.mjs";
import { MessageQueryConfigurationError, messageQueryStartupError, publicQueryError } from "../src/api/errors.mjs";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const env = overrides => ({ ...environment(), DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused", ...overrides });

function configurationFailure(settings) {
  let failure;
  assert.throws(() => loadMessageQueryConfig(settings), error => {
    failure = error;
    return error instanceof MessageQueryConfigurationError && error.code === "INVALID_CONFIGURATION";
  });
  return messageQueryStartupError(failure);
}

// Root shell entries dispatch to the shared local-stack runtime. Keep these
// checks separate from the low-level standalone API configuration contract.
for (const command of ["start", "stop"]) {
  test(`root local ${command} launcher is executable and dispatches without running verification or installation`, () => {
    const path = new URL(`../../scripts/${command}.sh`, import.meta.url);
    const source = readFileSync(path, "utf8");
    assert.ok(source.startsWith("#!/usr/bin/env bash\n"));
    assert.match(source, /^set -euo pipefail$/m);
    assert.match(source, /^cd "\$PROJECT_ROOT"$/m);
    const commands = source.split("\n").filter(line => !line.trimStart().startsWith("#")).join("\n");
    const dispatch = commands.match(/^exec node "\$PROJECT_ROOT\/indexer\/scripts\/local\/main\.mjs" (start|stop)$/m);
    assert.ok(dispatch, "the launcher must dispatch to the shared local-stack runtime");
    assert.equal(dispatch[1], command, "each launcher must select its own operation");
    assert.equal(commands.split("\n").filter(line => /^\s*exec\b/.test(line)).length, 1, "the launcher must have one exec entry");
    assert.doesNotMatch(commands, /verify\.sh|verification\.log|\btee\b|\bforge\b|\banvil\b|npm (?:ci|install)|--test|deploy-/);
    assert.doesNotMatch(commands, /\bbrew\s+(?:install|upgrade|services)\b/);
    assert.ok((statSync(path).mode & 0o111) !== 0, `the launcher must support direct ./scripts/${command}.sh execution`);
  });
}

test("demonstrations have no separate public shell or CLI entry",() => {
  assert.equal(existsSync(new URL("../../scripts/demo.sh",import.meta.url)),false);
  const runtime = readFileSync(new URL("../scripts/local/main.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(runtime,/command\s*===\s*["']demo["']|scripts\/demo\.sh/);
});

test("standalone API configuration reports all missing deployment fields together before any startup work", () => {
  // Reproduces the original root .env: database/indexing settings only, without
  // the verification script's temporary deployment or committee injection.
  const text = configurationFailure({ DATABASE_URL: env().DATABASE_URL, FINALITY_BLOCK_DEPTH: "2" });
  assert.ok(text.startsWith("INVALID_CONFIGURATION: Check the root .env:"));
  assert.ok(text.includes("CHAIN_A_DOMAIN is required"));
  assert.ok(text.includes("SOURCE_GATEWAY_ADDRESS is required"));
  assert.ok(text.includes("set exactly one of VALIDATOR_SET_HISTORY or VALIDATOR_SET_HISTORY_FILE"));
  assert.ok(!text.includes("INTERNAL_ERROR"));

  const empty = configurationFailure({});
  assert.ok(empty.includes("DATABASE_URL is required"));
  assert.ok(empty.includes("FINALITY_BLOCK_DEPTH is required"));
  for (const value of [undefined, "", " "]) {
    assert.ok(configurationFailure(env({ CHAIN_A_DOMAIN: value })).includes("CHAIN_A_DOMAIN is required"));
    assert.ok(configurationFailure(env({ SOURCE_GATEWAY_ADDRESS: value })).includes("SOURCE_GATEWAY_ADDRESS is required"));
  }
});

test("API parsing preserves delivery bindings and remains independent of signer and RPC configuration", () => {
  const settings = env({ INDEXER_DB_SCHEMA: "existing_source", VALIDATOR_PRIVATE_KEY: undefined,
    CHAIN_A_RPC_URL: undefined, CHAIN_B_RPC_URL: undefined, RELAYER_A_PRIVATE_KEY: undefined });
  const base = loadDeliveryConfig(settings);
  const config = loadMessageQueryConfig(settings);
  for (const field of ["databaseUrl", "databaseSchema", "chainDomain", "sourceGateway"]) assert.equal(config[field], base[field]);
  assert.deepEqual(config.validatorSets.history, base.validatorSets.history);
  assert.equal(config.listenHost, "127.0.0.1");
  assert.equal(config.listenPort, 8080);
  assert.equal(config.finalityBlockDepth, 2n);
  assert.equal(config.destinationConfirmations, 3n);
  assert.deepEqual(config.validatorStores, []);
  for (const field of ["privateKey", "chainRpcUrl", "rpcUrls"]) assert.equal(Object.hasOwn(config, field), false);
  assert.equal(loadMessageQueryConfig(env()).databaseSchema, "cross_chain_indexer");
});

test("invalid deployment, listener and optional address settings identify only their own configuration fields", () => {
  const secret = "CONFIG_VALUE_MUST_NOT_APPEAR_IN_DIAGNOSTICS";
  const cases = [
    ["DATABASE_URL", `postgresql://fixture:${secret}@[invalid/database`],
    ["INDEXER_DB_SCHEMA", `bad-schema-${secret}`],
    ["CHAIN_A_DOMAIN", "0"], ["CHAIN_A_DOMAIN", "1.5"], ["CHAIN_A_DOMAIN", `10011${secret}`],
    ["SOURCE_GATEWAY_ADDRESS", secret],
    ["FINALITY_BLOCK_DEPTH", "-1"], ["FINALITY_BLOCK_DEPTH", secret],
    ["DESTINATION_CONFIRMATIONS", "0"], ["DESTINATION_CONFIRMATIONS", secret],
    ["MESSAGE_QUERY_API_HOST", `https://${secret}`],
    ["MESSAGE_QUERY_API_PORT", "0"], ["MESSAGE_QUERY_API_PORT", "65536"], ["MESSAGE_QUERY_API_PORT", secret],
    ["IDENTITY_APPLICATION_ADDRESS", `0x${"0".repeat(40)}`], ["IDENTITY_APPLICATION_ADDRESS", secret],
    ["PRODUCTION_DESTINATION_GATEWAY_ADDRESS", secret],
    ["VALIDATOR_SET_HISTORY", `[{"secret":"${secret}"`],
    ["MESSAGE_QUERY_VALIDATOR_STORES", `[{"databaseUrl":"${secret}"`],
    ["MESSAGE_QUERY_VALIDATOR_STORES", "{}"],
  ];
  for (const [field, value] of cases) {
    const text = configurationFailure(env({ [field]: value }));
    assert.ok(text.includes(`${field} is invalid`), `${field} must identify the invalid field`);
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes("postgresql://"));
  }
  const combined = configurationFailure(env({ CHAIN_A_DOMAIN: "0", MESSAGE_QUERY_API_PORT: "0", MESSAGE_QUERY_VALIDATOR_STORES: "{}" }));
  for (const field of ["CHAIN_A_DOMAIN", "MESSAGE_QUERY_API_PORT", "MESSAGE_QUERY_VALIDATOR_STORES"]) assert.ok(combined.includes(`${field} is invalid`));
});

test("validator history is explicitly configured without example or verification fallback", () => {
  const missing = configurationFailure(env({ VALIDATOR_SET_HISTORY: "", VALIDATOR_SET_HISTORY_FILE: "" }));
  assert.ok(missing.includes("set exactly one of VALIDATOR_SET_HISTORY or VALIDATOR_SET_HISTORY_FILE"));
  const both = configurationFailure(env({ VALIDATOR_SET_HISTORY_FILE: "validator/config/validator-set-history.example.json" }));
  assert.ok(both.includes("VALIDATOR_SET_HISTORY and VALIDATOR_SET_HISTORY_FILE cannot both be set"));
  const unknown = configurationFailure(env({ VALIDATOR_SET_HISTORY: JSON.stringify([]) }));
  assert.ok(unknown.includes("VALIDATOR_SET_HISTORY is invalid"));
});

test("relative API history files resolve from the root .env directory even when npm runs in indexer", () => {
  const previous = process.cwd();
  const path = "validator/config/validator-set-history.example.json";
  const expected = JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), "utf8"));
  const settings = env({ VALIDATOR_SET_HISTORY: "", VALIDATOR_SET_HISTORY_FILE: path });
  try {
    for (const cwd of [projectRoot, join(projectRoot, "indexer")]) {
      process.chdir(cwd);
      const config = loadMessageQueryConfig(settings);
      assert.deepEqual(config.validatorSets.history, createValidatorSetResolver(expected).history);
    }
  } finally { process.chdir(previous); }
  assert.equal(settings.VALIDATOR_SET_HISTORY_FILE, path, "loading configuration never rewrites the caller's environment");
});

test("absolute, missing and malformed history files retain actionable errors without leaking paths or file content", () => {
  const directory = mkdtempSync(join(tmpdir(), "message-query-config-"));
  const secret = "HISTORY_CONTENT_MUST_NOT_APPEAR_IN_DIAGNOSTICS";
  const path = join(directory, `${secret}.json`);
  try {
    const settings = env({ VALIDATOR_SET_HISTORY: "", VALIDATOR_SET_HISTORY_FILE: path });
    let text = configurationFailure(settings);
    assert.ok(text.includes("VALIDATOR_SET_HISTORY_FILE"));
    assert.ok(text.includes("readable JSON with valid validator history"));
    assert.ok(!text.includes(secret));
    assert.ok(!text.includes(directory));
    writeFileSync(path, `[{"secret":"${secret}"`);
    text = configurationFailure(settings);
    assert.ok(!text.includes(secret));
    writeFileSync(path, env().VALIDATOR_SET_HISTORY);
    assert.deepEqual(loadMessageQueryConfig(settings).validatorSets.history, loadMessageQueryConfig(env()).validatorSets.history);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test("validator reader diagnostics do not reflect private connection material or malformed entry content", () => {
  const settings = env();
  const validatorAddress = JSON.parse(settings.VALIDATOR_SET_HISTORY)[0].validators[0];
  const valid = { validatorAddress, databaseSchema: "existing_validator" };
  assert.equal(loadMessageQueryConfig({ ...settings, MESSAGE_QUERY_VALIDATOR_STORES: JSON.stringify([valid]) }).validatorStores[0].databaseUrl, settings.DATABASE_URL);
  const secret = "READER_PASSWORD_MUST_NOT_APPEAR_IN_DIAGNOSTICS";
  for (const entry of [null, {}, { ...valid, databaseSchema: `bad-schema-${secret}` },
    { ...valid, databaseUrl: `postgresql://fixture:${secret}@[invalid/database` },
    { ...valid, validatorAddress: `0x${"ff".repeat(20)}` }, { ...valid, [secret]: true }]) {
    const text = configurationFailure({ ...settings, MESSAGE_QUERY_VALIDATOR_STORES: JSON.stringify([entry]) });
    assert.ok(text.includes("MESSAGE_QUERY_VALIDATOR_STORES[0] is invalid"));
    assert.ok(!text.includes(secret));
  }
  const duplicated = configurationFailure({ ...settings, MESSAGE_QUERY_VALIDATOR_STORES: JSON.stringify([valid, valid]) });
  assert.ok(duplicated.includes("MESSAGE_QUERY_VALIDATOR_STORES[1] is invalid"));
});

test("startup diagnostics explain bind failures while HTTP responses and unknown exceptions stay redacted", () => {
  const secret = "STARTUP_ERROR_MUST_NOT_APPEAR_IN_DIAGNOSTICS";
  for (const [code, expected] of [["EADDRINUSE", "LISTEN_ADDRESS_IN_USE"], ["EACCES", "LISTEN_PERMISSION_DENIED"],
    ["EADDRNOTAVAIL", "LISTEN_ADDRESS_UNAVAILABLE"]]) {
    const error = Object.assign(new Error(secret), { code });
    const text = messageQueryStartupError(error);
    assert.ok(text.startsWith(`${expected}:`));
    assert.ok(text.includes("MESSAGE_QUERY_API_HOST"));
    assert.ok(!text.includes(secret));
    assert.deepEqual(publicQueryError(error), { status: 500, body: { error: "INTERNAL_ERROR" } });
  }
  const configuration = new MessageQueryConfigurationError(["SOURCE_GATEWAY_ADDRESS is required"]);
  assert.ok(messageQueryStartupError(configuration).includes("SOURCE_GATEWAY_ADDRESS is required"));
  assert.deepEqual(publicQueryError(configuration), { status: 500, body: { error: "INTERNAL_ERROR" } });
  assert.equal(messageQueryStartupError(new Error(secret)), "INTERNAL_ERROR");
  assert.equal(messageQueryStartupError(Object.assign(new Error(secret), { code: "ECONNREFUSED" })), "DEPENDENCY_UNAVAILABLE");
});
