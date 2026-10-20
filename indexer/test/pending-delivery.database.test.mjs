import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createMetrics } from "../src/metrics/registry.mjs";
import { registerPendingDelivery, PENDING_DELIVERY_NAME } from "../src/metrics/pending-delivery.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { createRelaySubmissionRepository } from "../src/relayer/repository.mjs";
import { DestinationRpcError } from "../src/transaction-manager/rpc-pool.mjs";
import { encodeDestinationSubmission } from "../src/relayer/encoding.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { scrapeValue } from "./helpers/metrics-assertions.mjs";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for pending-delivery database tests");
const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_pending` });
const pool = createDatabasePool(config);
let metrics; let collector;
const pending = async () => scrapeValue(await metrics.registry.metrics(), PENDING_DELIVERY_NAME);
before(async () => { await applyMigrations(pool, config.databaseSchema); });
beforeEach(async () => {
  collector?.close(); await resetIndexerTables(pool, config.databaseSchema);
  metrics = createMetrics(); collector = registerPendingDelivery({ config, pool, metrics });
});
after(async () => { collector?.close(); await pool.end(); });

async function state() {
  const snapshot = {};
  for (const name of ["source_messages", "indexer_cursors", "message_batches", "delivery_batches", "delivery_jobs", "relayer_job_leases",
    "transaction_accounts", "transaction_intents", "transaction_attempts", "transaction_broadcast_events", "transaction_receipt_observations", "transaction_receipt_orphans"]) {
    snapshot[name] = (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
  }
  return snapshot;
}

test("production lifecycle READY/SIGNED/stopped work stays pending; canonical CONFIRMED and REVERTED outcomes reduce backlog; scrapes change no state", async () => {
  assert.equal(await pending(), 0);
  await persistReadyTransactionFixture({ config, pool, count: 3 });
  assert.equal(await pending(), 3);
  const queue = createDeliveryRepository({ config, pool });
  const jobs = await queue.listReadyDeliveryJobs(); const h = await transactionHarness({ config });
  const manager = createTransactionManager({ config, pool, queue, rpc: h.rpc });
  const prepared = [];
  for (const job of jobs) prepared.push(await manager.prepareDeliveryTransaction(job.deliveryJobId));
  assert.equal(await pending(), 3, "signed candidate creation alone does not resolve a job");
  await manager.repository.stopRetry(jobs[2].deliveryJobId, "DETERMINISTIC_REJECTION");
  assert.equal(await pending(), 3, "stopped retries are still unresolved");
  const before = await state();
  for (let index = 0; index < 3; index++) assert.equal(await pending(), 3);
  assert.deepEqual(await state(), before);
  const outcome = { transactionHash: prepared[0].attempt.transactionHash, blockNumber: 100n, blockHash: fixtureHash(1100), head: 102n, status: 1 };
  await manager.repository.recordOutcome(jobs[0].deliveryJobId, outcome);
  assert.equal(await pending(), 2);
  await manager.repository.recordOutcome(jobs[1].deliveryJobId, { ...outcome, transactionHash: prepared[1].attempt.transactionHash, status: 0 });
  assert.equal(await pending(), 1);
  await manager.repository.recordOutcome(jobs[0].deliveryJobId, outcome);
  assert.equal(await pending(), 1, "re-reading an existing canonical outcome adds no resolution");
  const after = await state(); assert.equal(await pending(), 1); assert.deepEqual(await state(), after);
  assert.ok((await queue.listReadyDeliveryJobs()).every(job => job.status === "READY"), "the collector never mutates the immutable job status");
  const fresh = createDatabasePool(config); const freshMetrics = createMetrics();
  const owner = registerPendingDelivery({ config, pool: fresh, metrics: freshMetrics });
  try { assert.equal(scrapeValue(await freshMetrics.registry.metrics(), PENDING_DELIVERY_NAME), 1); }
  finally { owner.close(); await fresh.end(); }
});

test("source-scope filtering excludes other domains/gateways without adding labels", async () => {
  await persistReadyTransactionFixture({ config, pool, count: 1 });
  for (const override of [{ chainDomain: config.chainDomain + 1n }, { sourceGateway: "0x0000000000000000000000000000000000004040" }]) {
    const other = createMetrics(); const owner = registerPendingDelivery({ config: { ...config, ...override }, pool, metrics: other });
    try { assert.equal(scrapeValue(await other.registry.metrics(), PENDING_DELIVERY_NAME), 0); } finally { owner.close(); }
  }
  assert.equal(await pending(), 1);
});

test("ordinary leased preparation defer remains unresolved, and an unconfirmed historical submission cannot masquerade as a terminal intent", async () => {
  await persistReadyTransactionFixture({ config, pool, count: 1 });
  const queue = createDeliveryRepository({ config, pool }); const [job] = await queue.listReadyDeliveryJobs();
  const h = await transactionHarness({ config });
  const manager = createTransactionManager({ config, pool, queue, rpc: { ...h.rpc, async estimateGas() {
    throw new DestinationRpcError("ESTIMATE_EXECUTION_REVERT", { errorClass: "DETERMINISTIC_REJECTION", rpcCode: 3 });
  } } });
  assert.equal((await createRelayerWorker({ config, pool, queue, transactionManager: manager }).runOnce()).deferred, 1);
  assert.equal(await pending(), 1);
  const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(job.deliveryJobId), { validatorSets: config.validatorSets });
  await createRelaySubmissionRepository({ config, pool, queue }).recordSubmission({ deliveryJobId: job.deliveryJobId, encoded, transactionHash: fixtureHash(3000) });
  assert.equal(await pending(), 1, "a submitted transport hash has no canonical terminal confirmation");
  assert.equal(await manager.repository.getTransaction(job.deliveryJobId), null);
  const before = await state(); await pending(); await pending(); assert.deepEqual(await state(), before);
});
