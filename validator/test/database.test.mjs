import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyValidatorMigrations, createValidatorPool, createValidatorStore } from "../src/db.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { configuration, snapshotFixture } from "./helpers/fixtures.mjs";
import { canonicalCommittee, deterministicPrimary } from "../src/committee.mjs";
import { signPrePrepare } from "../src/pre-prepare.mjs";
import { createPrePrepareService } from "../src/pre-prepare-service.mjs";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for validator database tests");
const prefix = process.env.VALIDATOR_DATABASE_TEST_SCHEMA ?? "cross_chain_validator_database_test";
const configs = Array.from({ length: 4 }, (_, index) => configuration({
  SOURCE_DATABASE_URL: process.env.DATABASE_URL, VALIDATOR_DATABASE_URL: process.env.DATABASE_URL,
  VALIDATOR_DB_SCHEMA: `${prefix}_v${index + 1}`,
}, index));
const pools = configs.map(createValidatorPool);
const stores = configs.map((config, index) => createValidatorStore({ config, pool: pools[index] }));
let snapshot;
let head;

before(async () => {
  snapshot = await snapshotFixture();
  head = { number: snapshot.batch.messages[0].sourceBlockNumber + 2n, hash: `0x${"99".repeat(32)}` };
  for (let index = 0; index < 4; index++) await applyValidatorMigrations(pools[index], configs[index].databaseSchema);
});
beforeEach(async () => {
  for (let index = 0; index < 4; index++) {
    const schema = configs[index].databaseSchema;
    await pools[index].query(`TRUNCATE TABLE ${tableName(schema, "validation_observations")},
      ${tableName(schema, "validated_batch_bindings")}, ${tableName(schema, "validator_metadata")},
      ${tableName(schema, "validator_committee")}, ${tableName(schema, "pbft_pre_prepares")},
      ${tableName(schema, "pre_prepare_rejections")}`);
    await stores[index].bindIdentity();
  }
});

async function signedProposal(root = snapshot.tree.messageRoot) {
  const primary = configs.find((config) => config.validatorAddress === deterministicPrimary(configs[0].peers, snapshot.record.epoch));
  return signPrePrepare(primary, { messageType: "PRE_PREPARE", protocolVersion: "1",
    sourceDomain: primary.chainDomain, sourceGateway: primary.sourceGateway, epoch: snapshot.record.epoch,
    batchId: snapshot.record.batchId, messageRoot: root, primaryIdentity: primary.validatorAddress });
}

function direction(config, envelope) { return config.validatorAddress === envelope.primaryIdentity ? "ISSUED" : "ACCEPTED"; }

test("issued and accepted PRE-PREPARE survive migration and fresh-pool recovery without overwrites", async () => {
  const envelope = await signedProposal();
  for (let index = 0; index < 4; index++) {
    const first = await stores[index].savePrePrepare(envelope, direction(configs[index], envelope));
    assert.deepEqual(await stores[index].savePrePrepare(envelope, direction(configs[index], envelope)), first);
    await applyValidatorMigrations(pools[index], configs[index].databaseSchema);
    const fresh = createValidatorPool(configs[index]);
    try {
      const restored = createValidatorStore({ config: configs[index], pool: fresh });
      await restored.bindIdentity();
      assert.deepEqual(await restored.readPrePrepare(envelope.epoch), first);
      const conflict = await signedProposal(`0x${"ee".repeat(32)}`);
      await assert.rejects(restored.savePrePrepare(conflict, direction(configs[index], conflict)), /CONFLICTING_PRE_PREPARE/);
      assert.deepEqual(await restored.readPrePrepares(), [first]);
    } finally { await fresh.end(); }
    await assert.rejects(pools[index].query(`DELETE FROM ${tableName(configs[index].databaseSchema, "pbft_pre_prepares")}`), /immutable/);
  }
});

test("database safety slots serialize concurrent duplicates and conflicting signed proposals", async () => {
  const a = await signedProposal();
  const repeated = await Promise.all(Array.from({ length: 8 }, () => stores[0].savePrePrepare(a, direction(configs[0], a))));
  for (const record of repeated) assert.deepEqual(record, repeated[0]);
  assert.equal((await stores[0].readPrePrepares()).length, 1);
  const b = await signedProposal(`0x${"ee".repeat(32)}`);
  const races = await Promise.allSettled([
    stores[1].savePrePrepare(a, direction(configs[1], a)), stores[1].savePrePrepare(b, direction(configs[1], b)),
  ]);
  assert.equal(races.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = races.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "CONFLICTING_PRE_PREPARE");
  assert.equal((await stores[1].readPrePrepares()).length, 1);
});

test("rejection audit never reserves a safety slot; committee permutations preserve binding", async () => {
  const p = await signedProposal();
  await stores[0].recordPrePrepareRejection({ ...p, epoch: "bad" }, "MALFORMED");
  assert.deepEqual(await stores[0].readPrePrepares(), []);
  await stores[0].savePrePrepare(p, direction(configs[0], p));
  const reordered = createValidatorStore({ pool: pools[0], config: { ...configs[0], peers: [...configs[0].peers].reverse() } });
  await reordered.bindIdentity();
  assert.deepEqual(await reordered.readPrePrepares(), await stores[0].readPrePrepares());
  const altered = configs[0].peers.map((peer, index) => index === 1 ? { ...peer, address: "0x0000000000000000000000000000000000000099" } : peer);
  assert.notDeepEqual(canonicalCommittee(altered), canonicalCommittee(configs[0].peers));
  await assert.rejects(createValidatorStore({ pool: pools[0], config: { ...configs[0], peers: altered } }).bindIdentity(), /committee mismatch/);
});

test("failed source validation records rejection without creating accepted state", async () => {
  const envelope = await signedProposal();
  const service = createPrePrepareService({ config: configs[0], store: stores[0],
    validation: { async validatePending() { return { result: "INVALID", reason: "CANONICAL_BLOCK" }; } },
    logger: { warn() {} } });
  assert.equal((await service.receive(envelope)).reason, "INVALID_SOURCE_STATE");
  assert.deepEqual(await stores[0].readPrePrepares(), []);
  const audit = await pools[0].query(`SELECT * FROM ${tableName(configs[0].databaseSchema, "pre_prepare_rejections")}`);
  assert.equal(audit.rowCount, 1); assert.equal(audit.rows[0].proposal_digest, envelope.proposalDigest);
});
after(async () => { await Promise.all(pools.map((pool) => pool.end())); });

test("rerunnable migrations and four identity-bound namespaces isolate observations", async () => {
  const firstIdentity = await stores[0].bindIdentity();
  await applyValidatorMigrations(pools[0], configs[0].databaseSchema);
  assert.deepEqual(await stores[0].bindIdentity(), firstIdentity);
  await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  assert.equal((await stores[0].readObservations()).length, 1);
  for (let index = 1; index < 4; index++) assert.deepEqual(await stores[index].readObservations(), []);
  for (let index = 1; index < 4; index++) await stores[index].recordObservation({ snapshot, head, result: "VALID" });
  for (const store of stores) assert.equal((await store.readObservations()).length, 1);
  assert.equal(new Set(configs.map((config) => config.validatorAddress)).size, 4);
});

test("fresh pools recover their own observations and reject swapped keys/context", async () => {
  for (let index = 0; index < 2; index++) {
    await stores[index].recordObservation({ snapshot, head, result: "VALID" });
    const before = await stores[index].readObservations();
    const pool = createValidatorPool(configs[index]);
    try {
      const restored = createValidatorStore({ pool, config: configs[index] });
      await restored.bindIdentity();
      assert.deepEqual(await restored.readObservations(), before);
      const swapped = createValidatorStore({ pool, config: { ...configs[index], validatorAddress: configs[1 - index].validatorAddress } });
      await assert.rejects(swapped.bindIdentity(), /identity or source context mismatch/);
      const changedPolicy = createValidatorStore({ pool, config: { ...configs[index], finalityBlockDepth: 3n } });
      await assert.rejects(changedPolicy.bindIdentity(), /identity or source context mismatch/);
      assert.deepEqual(await restored.readObservations(), before);
    } finally { await pool.end(); }
  }
});

test("same-head validation is idempotent; changed heads retain immutable history", async () => {
  const first = await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  assert.deepEqual(await stores[0].recordObservation({ snapshot, head, result: "VALID" }), first);
  assert.equal((await stores[0].readObservations()).length, 1);
  await stores[0].recordObservation({ snapshot, head: { number: head.number + 1n, hash: `0x${"98".repeat(32)}` }, result: "INVALID", reason: "CANONICAL_BLOCK" });
  assert.equal((await stores[0].readObservations()).length, 2);
  await assert.rejects(stores[0].recordObservation({ snapshot, head, result: "INVALID", reason: "CANONICAL_BLOCK" }), /conflicting validation observation/);
  assert.equal((await stores[0].readObservations())[0].result, "VALID");
});

test("conflicting roots, epochs, or occurrence membership cannot replace existing bindings", async () => {
  await stores[0].recordObservation({ snapshot, head, result: "VALID" });
  const before = await stores[0].readObservations();
  for (const candidate of [
    { ...snapshot, record: { ...snapshot.record, messageRoot: `0x${"ee".repeat(32)}` } },
    { ...snapshot, record: { ...snapshot.record, epoch: snapshot.record.epoch + 1n } },
    { ...snapshot, batch: { ...snapshot.batch, messages: [...snapshot.batch.messages].reverse() } },
  ]) await assert.rejects(stores[0].recordObservation({ snapshot: candidate, head, result: "VALID" }), /conflicting validator-local batch snapshot/);
  assert.deepEqual(await stores[0].readObservations(), before);
  for (const table of ["validator_metadata", "validated_batch_bindings", "validation_observations"]) {
    await assert.rejects(pools[0].query(`DELETE FROM ${tableName(configs[0].databaseSchema, table)}`), /immutable/);
  }
  const data = JSON.stringify({ identities: await stores[0].bindIdentity(), observations: before });
  assert.ok(!data.includes(configs[0].privateKey));
});
