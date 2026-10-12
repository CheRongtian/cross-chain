import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { applyMigrations, createCanonicalStore, createDatabasePool, createDatabaseStore, createFinalityStore,
  resetIndexerTables, tableName } from "../src/db.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createRelaySubmissionRepository } from "../src/relayer/repository.mjs";
import { createLegacyRelayer as createSingleRelayer } from "./helpers/legacy-relayer.mjs";
import { encodeDestinationSubmission } from "../src/relayer/encoding.mjs";
import { deliveryFixture, fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { relayerConfig } from "./helpers/relayer-fixtures.mjs";

const config = relayerConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_relayer`,RELAYER_MAX_JOBS_PER_RUN: "2" });
const pool = createDatabasePool(config);
const queue = createDeliveryRepository({ config,pool });
const repository = createRelaySubmissionRepository({ config,pool,queue });
const submissions = tableName(config.databaseSchema,"relayer_submissions");
let calls;
let lifecycle;

before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  calls = [];
  await resetIndexerTables(pool,config.databaseSchema);
  await createDatabaseStore(pool,config.databaseSchema).loadOrInitializeCursor(config,10n);
  await createCanonicalStore(pool,config.databaseSchema).bootstrapCanonicalHistory(config,{
    expectedNextBlock: 10n,blocks: [{ number: 9n,hash: fixtureHash(10),parentHash: fixtureHash(9) }] });
  lifecycle = createBatchLifecycle({ config,pool });
});
after(async () => { await pool.end(); });

function fakeSubmitter({ failure,hash } = {}) {
  return { async verifyChain() { return config.destinationDomain; },async submit(input) {
    calls.push(input); if (failure) throw failure; return hash ?? fixtureHash(1000 + calls.length);
  } };
}

async function readyFixture() {
  const fixture = await deliveryFixture();
  await createDatabaseStore(pool,config.databaseSchema).persistRange(config,{ fromBlock: 10n,toBlock: 10n,
    blocks: [{ number: 10n,hash: fixtureHash(11),parentHash: fixtureHash(10) }],
    rows: fixture.batch.messages.map((message) => ({ ...message,payload: Buffer.from(message.payload.slice(2),"hex") })) });
  await createFinalityStore(pool,config.databaseSchema).advanceFinality(config,{ headBlock: 10n,finalityBlockDepth: 0n });
  const collected = await lifecycle.collectEligible({ initialEpoch: fixture.record.epoch });
  const id = collected.snapshot.record.batchRecordId;
  await lifecycle.sealBatch({ batchRecordId: id });
  await lifecycle.markConsensusPending({ batchRecordId: id });
  const snapshot = await lifecycle.commitWithCertificate({ certificate: fixture.quorumCertificate });
  await createDeliveryProjector({ config,pool }).materializeBatch({ batchRecordId: id });
  return snapshot;
}

test("submission migration reruns, records bind exact evidence, and completed jobs do not starve later READY positions", async () => {
  const snapshot = await readyFixture();
  const jobsBefore = await queue.listReadyDeliveryJobs();
  const relayer = createSingleRelayer({ config,queue,repository,submitter: fakeSubmitter() });
  const first = await relayer.runOnce();
  assert.equal(first.selected,2); assert.equal(first.submitted,2);
  await applyMigrations(pool,config.databaseSchema);
  const second = await relayer.runOnce();
  assert.equal(second.selected,1); assert.equal(second.submitted,1);
  assert.equal(calls.length,3);
  const rows = (await pool.query(`SELECT * FROM ${submissions} ORDER BY delivery_job_id`)).rows;
  assert.equal(rows.length,3);
  for (const job of jobsBefore) {
    const pack = await queue.getDeliveryPackage(job.deliveryJobId);
    const encoded = await encodeDestinationSubmission(pack,{ validatorSets: config.validatorSets });
    const row = await repository.getSubmission(job.deliveryJobId);
    assert.equal(row.relayerAddress,config.relayerAddress);
    assert.equal(row.destinationDomain,pack.message.destinationDomain);
    assert.equal(row.destinationGateway,pack.message.destinationGateway);
    assert.equal(row.packageDigest,encoded.packageDigest);
    assert.match(row.transactionHash,/^0x[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(row).includes(config.privateKey));
  }
  const fresh = createDatabasePool(config);
  try {
    const reader = createDeliveryRepository({ config,pool: fresh });
    const records = createRelaySubmissionRepository({ config,pool: fresh,queue: reader });
    const restarted = createSingleRelayer({ config,queue: reader,repository: records,submitter: fakeSubmitter() });
    const result = await restarted.runOnce();
    assert.equal(result.selected,0); assert.equal(result.submitted,0); assert.equal(calls.length,3);
    const repeated = await restarted.submitJob(jobsBefore[0].deliveryJobId);
    assert.equal(repeated.submitted,false); assert.equal(calls.length,3);
  } finally { await fresh.end(); }
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobsBefore);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId }),snapshot);
  const columns = (await pool.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = 'relayer_submissions' ORDER BY column_name`,[config.databaseSchema])).rows.map((row) => row.column_name);
  assert.deepEqual(columns,["delivery_job_id","destination_domain","destination_gateway","package_digest","relayer_address","submitted_at","transaction_hash"]);
});

test("RPC failure and malformed hash leave every READY job unsubmitted and unchanged", async () => {
  await readyFixture();
  const before = await queue.listReadyDeliveryJobs();
  for (const submitter of [fakeSubmitter({ failure: new Error("injected unavailable RPC") }),fakeSubmitter({ hash: "invalid-hash" })]) {
    await assert.rejects(createSingleRelayer({ config,queue,repository,submitter }).runOnce());
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${submissions}`)).rows[0].count,0);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),before);
  }
  assert.equal(calls.length,2);
  assert.equal((await repository.listEligibleJobs({ limit: 100 })).length,3);
});

test("immutable submissions reject rewrites, preserve one record per job, and detect conflicting evidence", async () => {
  await readyFixture();
  const job = (await queue.listReadyDeliveryJobs())[0];
  const service = createSingleRelayer({ config,queue,repository,submitter: fakeSubmitter() });
  const result = await service.submitJob(job.deliveryJobId);
  const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(job.deliveryJobId),{ validatorSets: config.validatorSets });
  assert.deepEqual(await repository.recordSubmission({ deliveryJobId: job.deliveryJobId,encoded,transactionHash: result.transactionHash }),
    await repository.getSubmission(job.deliveryJobId));
  await assert.rejects(repository.recordSubmission({ deliveryJobId: job.deliveryJobId,encoded,transactionHash: fixtureHash(999) }),{ code: "CONFLICTING_RELAY_SUBMISSION" });
  for (const assignment of ["delivery_job_id = delivery_job_id || ':other'",`relayer_address = '0x${"11".repeat(20)}'`,
    "destination_domain = 3001",`destination_gateway = '0x${"22".repeat(20)}'`,
    `package_digest = '${fixtureHash(99)}'`,`transaction_hash = '${fixtureHash(99)}'`,"submitted_at = submitted_at + interval '1 second'"]) {
    await assert.rejects(pool.query(`UPDATE ${submissions} SET ${assignment}`),/immutable/);
  }
  await assert.rejects(pool.query(`DELETE FROM ${submissions}`),/immutable/);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${submissions} DISABLE TRIGGER relayer_submissions_guard`);
    await client.query(`UPDATE ${submissions} SET package_digest = $1 WHERE delivery_job_id = $2`,[fixtureHash(99),job.deliveryJobId]);
    const transactionPool = { async query(sql,values) { return client.query(sql,values); } };
    const corrupted = createRelaySubmissionRepository({ config,pool: transactionPool,queue });
    await assert.rejects(corrupted.getSubmission(job.deliveryJobId),{ code: "CONFLICTING_RELAY_SUBMISSION" });
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${submissions}`)).rows[0].count,1);
  assert.equal(calls.length,1);
});

test("a second active Relayer A fails fast and the session lock is reusable after release", async () => {
  await readyFixture();
  const fresh = createDatabasePool(config);
  try {
    const otherQueue = createDeliveryRepository({ config,pool: fresh });
    const other = createRelaySubmissionRepository({ config,pool: fresh,queue: otherQueue });
    await repository.withSingleton(async () => {
      await assert.rejects(createSingleRelayer({ config,queue: otherQueue,repository: other,submitter: fakeSubmitter() }).runOnce(),{ code: "RELAYER_ALREADY_RUNNING" });
      assert.equal(calls.length,0);
    });
    assert.equal((await createSingleRelayer({ config,queue: otherQueue,repository: other,submitter: fakeSubmitter() }).runOnce()).submitted,2);
  } finally { await fresh.end(); }
});
