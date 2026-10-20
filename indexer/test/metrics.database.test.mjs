import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyMigrations, createDatabasePool, createDatabaseStore, createCanonicalStore, createFinalityStore, resetIndexerTables } from "../src/db.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { DestinationRpcError } from "../src/transaction-manager/rpc-pool.mjs";
import { bindPoolMetrics, createMetrics } from "../src/metrics/registry.mjs";
import { metricValue } from "./helpers/metrics-assertions.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { deliveryFixture, fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for metrics database tests");
const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_metrics` });
const pool = createDatabasePool(config);
let metrics;
const value = suffix => metricValue(suffix, { metrics });
before(async () => { await applyMigrations(pool, config.databaseSchema); });
beforeEach(async () => { await resetIndexerTables(pool, config.databaseSchema); metrics = createMetrics(); bindPoolMetrics(pool, metrics); });
after(async () => { await metrics?.settled(); await pool.end(); });

test("source inserts, duplicate occurrence, rollback, finality and batch creation count only durable new transitions", async () => {
  const store = createDatabaseStore(pool, config.databaseSchema);
  await store.loadOrInitializeCursor(config, 10n);
  await createCanonicalStore(pool, config.databaseSchema).bootstrapCanonicalHistory(config, {
    expectedNextBlock: 10n, blocks: [{ number: 9n, hash: fixtureHash(10), parentHash: fixtureHash(9) }] });
  const fixture = await deliveryFixture({ count: 1, sourceBlockNumber: 10n });
  const row = { ...fixture.batch.messages[0], payload: Buffer.from(fixture.batch.messages[0].payload.slice(2), "hex") };
  const range = { fromBlock: 10n, toBlock: 10n,
    blocks: [{ number: 10n, hash: fixtureHash(11), parentHash: fixtureHash(10) }], rows: [row, row] };
  // The production transaction inserts the first occurrence, then rejects the
  // next out-of-range occurrence. Its inserted row and counter must roll back.
  await assert.rejects(store.persistRange(config, { ...range, rows: [row, { ...row, sourceBlockNumber: 11n }] }));
  assert.equal(await value("messages_observed_total"), 0);
  await store.persistRange(config, range);
  assert.equal(await value("messages_observed_total"), 1, "a duplicate occurrence is not a new observation");
  const finality = createFinalityStore(pool, config.databaseSchema);
  await finality.advanceFinality(config, { headBlock: 10n, finalityBlockDepth: 0n });
  await finality.advanceFinality(config, { headBlock: 10n, finalityBlockDepth: 0n });
  assert.equal(await value("messages_finalized_total"), 1);
  const lifecycle = createBatchLifecycle({ config, pool });
  const collected = await lifecycle.collectEligible({ initialEpoch: fixture.record.epoch });
  assert.equal(await value("batches_created_total"), 1);
  await lifecycle.collectEligible();
  await lifecycle.readBatch({ batchRecordId: collected.snapshot.record.batchRecordId });
  assert.equal(await value("batches_created_total"), 1, "existing BUILDING batch and reads add zero");
  console.log("VALID: source rollback/duplicate/finality and batch deltas match durable production rows");
});

test("durable signed candidates count once; rollback, receipt polling, duplicate preparation and readback add zero", async () => {
  await persistReadyTransactionFixture({ config, pool, count: 1 });
  const queue = createDeliveryRepository({ config, pool });
  const [job] = await queue.listReadyDeliveryJobs();
  const h = await transactionHarness({ config });
  const failed = createTransactionManager({ config, pool, queue, rpc: h.rpc,
    beforeSignedCommit: async () => { throw new Error("before durable signed commit"); } });
  await assert.rejects(failed.prepareDeliveryTransaction(job.deliveryJobId), /before durable signed commit/);
  assert.equal(await value("delivery_attempts_total"), 0);
  const manager = createTransactionManager({ config, pool, queue, rpc: h.rpc });
  assert.equal((await manager.prepareDeliveryTransaction(job.deliveryJobId)).created, true);
  assert.equal(await value("delivery_attempts_total"), 1);
  assert.equal((await manager.prepareDeliveryTransaction(job.deliveryJobId)).created, false);
  await manager.checkReceiptsOnce();
  await manager.repository.getTransaction(job.deliveryJobId);
  assert.equal(await value("delivery_attempts_total"), 1);
  assert.equal(await value("delivery_retries_total"), 0);
  assert.equal(await value("transaction_replacements_total"), 0);
  assert.equal(await value("destination_execution_failures_total"), 0);
  assert.equal(await metricValue("cross_chain_latency_seconds", { metrics, part: "_count" }), 0, "a signature or empty receipt poll proves no production execution");
  assert.equal(await value("messages_observed_total"), 1);
  assert.equal(await value("messages_finalized_total"), 1);
  assert.equal(await value("batches_created_total"), 1);
  console.log("VALID: signed-candidate metrics follow committed rows, not preparation attempts or receipt polling");
});

test("ordinary leased preparation defer does not fabricate a failure, attempt, retry or execution outcome", async () => {
  await persistReadyTransactionFixture({ config, pool, count: 1 });
  const queue = createDeliveryRepository({ config, pool });
  const h = await transactionHarness({ config });
  const manager = createTransactionManager({ config, pool, queue, rpc: { ...h.rpc, async estimateGas() {
    throw new DestinationRpcError("ESTIMATE_EXECUTION_REVERT", { errorClass: "DETERMINISTIC_REJECTION", rpcCode: 3 });
  } } });
  const worker = createRelayerWorker({ config, pool, queue, transactionManager: manager });
  const result = await worker.runOnce();
  assert.equal(result.deferred, 1); assert.equal(result.submitted, 0);
  await worker.runOnce();
  for (const suffix of ["relayer_failures_total", "delivery_attempts_total", "delivery_retries_total", "destination_execution_failures_total"]) {
    assert.equal(await value(suffix), 0);
  }
  console.log("VALID: production preparation defer and passive retry selection add no operational failure or execution event");
});
