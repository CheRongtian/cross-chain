import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { loadDatabaseConfig } from "../src/config.mjs";
import { applyMigrations, createCanonicalStore, createDatabasePool, createDatabaseStore, createFinalityStore,
  readMessages, resetIndexerTables, tableName } from "../src/db.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { verifyDeliveryPackage } from "../src/delivery/package.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { buildQuorumCertificate, expectedCommitStatement } from "../../validator/src/quorum-certificate.mjs";
import { commitConfigs, signedCommitFixture } from "../../validator/test/helpers/commit-fixtures.mjs";
import { deliveryFixture, deliveryMessage, deliveryScope, deliveryValidatorSets, fixtureHash } from "./helpers/delivery-fixtures.mjs";

const config = { ...loadDatabaseConfig({ ...process.env,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_delivery` }),
  ...deliveryScope, validatorSets: deliveryValidatorSets };
const pool = createDatabasePool(config);
const source = createDatabaseStore(pool,config.databaseSchema);
const finality = createFinalityStore(pool,config.databaseSchema);
const lifecycle = createBatchLifecycle({ config,pool,committee: commitConfigs[0].peers });
const projector = createDeliveryProjector({ config,pool });
const repository = createDeliveryRepository({ config,pool });
const batches = tableName(config.databaseSchema,"delivery_batches");
const jobs = tableName(config.databaseSchema,"delivery_jobs");

before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema);
  await source.loadOrInitializeCursor(config,10n);
  await createCanonicalStore(pool,config.databaseSchema).bootstrapCanonicalHistory(config, {
    expectedNextBlock: 10n,blocks: [{ number: 9n,hash: fixtureHash(10),parentHash: fixtureHash(9) }] });
});
after(async () => { await pool.end(); });

async function persist(messages, blockNumber = 10n) {
  await source.persistRange(config,{ fromBlock: blockNumber,toBlock: blockNumber,
    blocks: [{ number: blockNumber,hash: fixtureHash(blockNumber + 1n),parentHash: fixtureHash(blockNumber) }],
    rows: messages.map((message) => ({ ...message,payload: Buffer.from(message.payload.slice(2),"hex") })) });
  await finality.advanceFinality(config,{ headBlock: blockNumber,finalityBlockDepth: 0n });
}

async function commitBatch(manager,id,validatorSets = config.validatorSets) {
  await manager.sealBatch({ batchRecordId: id });
  const pending = await manager.markConsensusPending({ batchRecordId: id });
  const statement = expectedCommitStatement({ sourceDomain: pending.record.sourceDomain,sourceGateway: pending.record.sourceGateway,
    epoch: pending.record.epoch,batchId: pending.record.batchId,messageRoot: pending.record.messageRoot },commitConfigs[0].peers,validatorSets);
  const commits = await Promise.all(commitConfigs.slice(0,3).map((identity) => signedCommitFixture(statement,identity)));
  const certificate = await buildQuorumCertificate(commits,{ peers: commitConfigs[0].peers,validatorSets,expected: statement });
  return manager.commitWithCertificate({ certificate });
}

async function committedFixture() {
  const fixture = await deliveryFixture({ multiDestination: true });
  await persist(fixture.batch.messages);
  const collected = await lifecycle.collectEligible({ initialEpoch: fixture.record.epoch });
  return commitBatch(lifecycle,collected.snapshot.record.batchRecordId);
}

async function counts() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${batches})::int AS batches,
    (SELECT COUNT(*) FROM ${jobs})::int AS jobs`)).rows[0];
}

test("queue migration reruns preserve complete READY jobs and strict fresh-client package reads", async () => {
  const snapshot = await committedFixture();
  const sourceBefore = await readMessages(pool,config.databaseSchema);
  const first = await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId });
  assert.equal(first.createdJobs,3); assert.equal(first.materialized,true);
  assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
  const listed = await repository.listReadyDeliveryJobs();
  assert.deepEqual(listed,first.jobs);
  assert.equal(listed[1].destinationDomain,"3001");
  assert.equal((await repository.listReadyDeliveryJobs({ limit: 1 })).length,1);
  assert.deepEqual(await projector.projectCommittedBatches(),{ materializedBatches: 0,createdJobs: 0 });
  const retry = await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId });
  assert.equal(retry.createdJobs,0); assert.deepEqual(retry.jobs,listed);
  await applyMigrations(pool,config.databaseSchema);
  await applyMigrations(pool,config.databaseSchema);
  const fresh = createDatabasePool(config);
  try {
    const reader = createDeliveryRepository({ config,pool: fresh });
    assert.deepEqual(await reader.listReadyDeliveryJobs(),listed);
    for (const job of listed) {
      assert.deepEqual(await reader.getDeliveryJob(job.deliveryJobId),job);
      const pack = await reader.getDeliveryPackage(job.deliveryJobId);
      assert.deepEqual(await verifyDeliveryPackage(pack,{ validatorSets: config.validatorSets }),pack);
      assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
      assert.deepEqual(pack.merkleProof.siblings,snapshot.tree.proofs[job.messageIndex].siblings);
      assert.equal(pack.message.deadline,((1n << 200n) + 123n).toString());
    }
    assert.deepEqual(await createDeliveryProjector({ config,pool: fresh }).materializeBatch({ batchRecordId: snapshot.record.batchRecordId }),retry);
  } finally { await fresh.end(); }
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId }),snapshot);
  assert.deepEqual(await readMessages(pool,config.databaseSchema),sourceBefore);
  assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
  await assert.rejects(repository.getDeliveryPackage("missing"),{ code: "DELIVERY_JOB_NOT_FOUND" });
  for (const limit of [0,1001,"1",1.5]) await assert.rejects(repository.listReadyDeliveryJobs({ limit }),{ code: "INVALID_DELIVERY_LIMIT" });
});

test("BUILDING, SEALED and CONSENSUS_PENDING cannot create a delivery projection", async () => {
  const fixture = await deliveryFixture();
  await persist(fixture.batch.messages);
  const collected = await lifecycle.collectEligible({ initialEpoch: 23n });
  const id = collected.snapshot.record.batchRecordId;
  for (const advance of [null,() => lifecycle.sealBatch({ batchRecordId: id }),() => lifecycle.markConsensusPending({ batchRecordId: id })]) {
    if (advance) await advance();
    await assert.rejects(projector.materializeBatch({ batchRecordId: id }),{ code: "DELIVERY_REQUIRES_COMMITTED" });
    assert.deepEqual(await counts(),{ batches: 0,jobs: 0 });
    assert.deepEqual(await projector.projectCommittedBatches(),{ materializedBatches: 0,createdJobs: 0 });
  }
});

test("failure after a partial insert rolls back the entire projection; a fresh projector retries", async () => {
  const snapshot = await committedFixture();
  const failing = createDeliveryProjector({ config,pool,afterJobPersisted: async ({ messageIndex }) => {
    if (messageIndex === 1) throw new Error("injected interruption after the second delivery job");
  } });
  await assert.rejects(failing.materializeBatch({ batchRecordId: snapshot.record.batchRecordId }),/injected interruption/);
  assert.deepEqual(await counts(),{ batches: 0,jobs: 0 });
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId }),snapshot);
  const fresh = createDatabasePool(config);
  try {
    assert.deepEqual(await createDeliveryProjector({ config,pool: fresh }).projectCommittedBatches(),{ materializedBatches: 1,createdJobs: 3 });
  } finally { await fresh.end(); }
  assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
});

test("independent concurrent projectors create one canonical projection and one job per position", async () => {
  const snapshot = await committedFixture();
  const fresh = createDatabasePool(config);
  try {
    const other = createDeliveryProjector({ config,pool: fresh });
    const results = await Promise.all([projector,other,projector,other].map((worker) => worker.materializeBatch({ batchRecordId: snapshot.record.batchRecordId })));
    assert.equal(results.reduce((sum,result) => sum + result.createdJobs,0),3);
    assert.equal(results.filter((result) => result.materialized).length,1);
    for (const result of results) assert.deepEqual(result.jobs,results[0].jobs);
    assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
  } finally { await fresh.end(); }
});

test("SQL cannot commit a delivery projection without every canonical job", async () => {
  const snapshot = await committedFixture();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q = snapshot.quorumCertificate;
    await client.query(`INSERT INTO ${batches} (batch_record_id,batch_id,source_domain,source_gateway,batch_epoch,
      batch_version,message_root,leaf_count,protocol_version,validator_epoch,committee_digest,qc_digest)
      VALUES ($1,$2,$3,$4,$5,1,$6,3,3,$7,$8,$9)`, [snapshot.record.batchRecordId,q.batchId,q.sourceDomain,
      q.sourceGateway,q.epoch,q.messageRoot,q.validatorEpoch,q.committeeDigest,q.qcDigest]);
    await assert.rejects(client.query("COMMIT"),/exactly one job per sealed position atomically/);
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.deepEqual(await counts(),{ batches: 0,jobs: 0 });
});

test("READY rows reject updates and deletions of operational and evidence fields", async () => {
  const snapshot = await committedFixture();
  await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId });
  for (const sql of [
    `UPDATE ${batches} SET batch_id = '${fixtureHash(99)}'`,
    `UPDATE ${batches} SET message_root = '${fixtureHash(99)}'`,
    `UPDATE ${batches} SET validator_epoch = 9`,
    `UPDATE ${batches} SET committee_digest = '${fixtureHash(99)}'`,
    `UPDATE ${batches} SET qc_digest = '${fixtureHash(99)}'`,
    `UPDATE ${jobs} SET message_index = message_index + 99`,
    `UPDATE ${jobs} SET message_id = '${fixtureHash(99)}'`,
    `UPDATE ${jobs} SET proof_siblings = '[]'::jsonb`,
    `UPDATE ${jobs} SET destination_domain = 999`,
    `UPDATE ${jobs} SET delivery_job_id = delivery_job_id || ':changed'`,
    `DELETE FROM ${jobs}`,`DELETE FROM ${batches}`,
  ]) await assert.rejects(pool.query(sql),/immutable/);
  assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
});

function rollbackOnlyPool(client) {
  return { async connect() { return { async query(sql,values) {
    if (["BEGIN","COMMIT","ROLLBACK"].includes(sql)) return {};
    return client.query(sql,values);
  },release() {} }; } };
}

test("strict materialization rejects corrupted source data and missing QC before creating any queue rows", async () => {
  const snapshot = await committedFixture();
  const signatures = tableName(config.databaseSchema,"batch_quorum_certificate_signatures");
  const certificates = tableName(config.databaseSchema,"batch_quorum_certificates");
  const sources = tableName(config.databaseSchema,"source_messages");
  for (const mutation of ["payload","missing QC"]) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (mutation === "payload") {
        await client.query(`UPDATE ${sources} SET payload = decode('ffff','hex') WHERE id = $1`,[snapshot.members[0].sourceMessageId]);
      } else {
        await client.query(`ALTER TABLE ${signatures} DISABLE TRIGGER batch_quorum_certificate_signatures_guard`);
        await client.query(`ALTER TABLE ${certificates} DISABLE TRIGGER batch_quorum_certificates_guard`);
        await client.query(`DELETE FROM ${signatures} WHERE batch_record_id = $1`,[snapshot.record.batchRecordId]);
        await client.query(`DELETE FROM ${certificates} WHERE batch_record_id = $1`,[snapshot.record.batchRecordId]);
      }
      const scoped = createDeliveryProjector({ config,pool: rollbackOnlyPool(client) });
      await assert.rejects(scoped.materializeBatch({ batchRecordId: snapshot.record.batchRecordId }),
        mutation === "payload" ? /payload hash/ : /missing its persisted QC/);
      assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM ${batches}`)).rows[0].count,0);
      assert.equal((await client.query(`SELECT COUNT(*)::int AS count FROM ${jobs}`)).rows[0].count,0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  }
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId }),snapshot);
  assert.equal((await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId })).createdJobs,3);
});

// Corruption remains inside a rollback-only transaction; no production guard is removed.
async function corruptedRead({ table,trigger,sql }, id, expected) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const batchRecordId = (await client.query(`SELECT batch_record_id FROM ${jobs} WHERE delivery_job_id = $1`,[id])).rows[0].batch_record_id;
    if (trigger) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(sql);
    const readPool = rollbackOnlyPool(client);
    await assert.rejects(createDeliveryRepository({ config,pool: readPool }).getDeliveryPackage(id),expected);
    await assert.rejects(createDeliveryProjector({ config,pool: readPool }).materializeBatch({ batchRecordId }));
  } finally { await client.query("ROLLBACK"); client.release(); }
}

test("strict reads reject corrupted queue paths, contexts, QC references and source cryptographic evidence", async () => {
  const snapshot = await committedFixture();
  const result = await projector.materializeBatch({ batchRecordId: snapshot.record.batchRecordId });
  const id = result.jobs[0].deliveryJobId;
  const signatures = tableName(config.databaseSchema,"batch_quorum_certificate_signatures");
  const sources = tableName(config.databaseSchema,"source_messages");
  for (const column of ["batch_id","message_root","committee_digest","qc_digest"]) {
    await corruptedRead({ table: batches,trigger: "delivery_batches_guard",sql: `UPDATE ${batches} SET ${column} = '${fixtureHash(99)}'` },id,{ code: "CORRUPTED_DELIVERY_PROJECTION" });
  }
  await corruptedRead({ table: batches,trigger: "delivery_batches_guard",sql: `UPDATE ${batches} SET validator_epoch = 99` },id,{ code: "CORRUPTED_DELIVERY_PROJECTION" });
  for (const assignment of ["message_index = message_index + 99","destination_domain = 999",`message_id = '${fixtureHash(99)}'`,
    `proof_siblings = '["${fixtureHash(99)}","${fixtureHash(99)}"]'::jsonb`]) {
    await corruptedRead({ table: jobs,trigger: "delivery_jobs_guard",sql: `UPDATE ${jobs} SET ${assignment} WHERE message_index = 0` },id,{ code: "CORRUPTED_DELIVERY_JOB" });
  }
  await corruptedRead({ table: signatures,trigger: "batch_quorum_certificate_signatures_guard",
    sql: `UPDATE ${signatures} SET signature = '0x${"ff".repeat(65)}'` },id,/INVALID_SIGNATURE/);
  await corruptedRead({ sql: `UPDATE ${sources} SET payload = decode('ffff','hex') WHERE id = 1` },id,/payload hash/);
  assert.deepEqual(await counts(),{ batches: 1,jobs: 3 });
  assert.equal((await repository.getDeliveryPackage(id)).messageRoot,snapshot.tree.messageRoot);
});

test("old queued evidence remains unchanged after projecting a new validator epoch", async () => {
  const initial = config.validatorSets.history[0];
  const history = createValidatorSetResolver([{ ...initial,validatorEpoch: "7" },{ ...initial,validatorEpoch: "8",activationBatchEpoch: "24" }]);
  const rotated = { ...config,validatorSets: history };
  const manager = createBatchLifecycle({ config: rotated,pool,committee: commitConfigs[0].peers });
  const fixture = await deliveryFixture({ validatorSets: history });
  await persist(fixture.batch.messages);
  const firstBuilding = await manager.collectEligible({ initialEpoch: 23n });
  const first = await commitBatch(manager,firstBuilding.snapshot.record.batchRecordId,history);
  const queue = createDeliveryProjector({ config: rotated,pool });
  const reader = createDeliveryRepository({ config: rotated,pool });
  const firstResult = await queue.materializeBatch({ batchRecordId: first.record.batchRecordId });
  const oldPackage = await reader.getDeliveryPackage(firstResult.jobs[0].deliveryJobId);
  const extra = deliveryMessage(0,{ nonce: 99n,sourceBlockNumber: 11n,sourceBlockHash: fixtureHash(12),sourceTransactionHash: fixtureHash(999) });
  await persist([extra],11n);
  const secondBuilding = await manager.collectEligible();
  const second = await commitBatch(manager,secondBuilding.snapshot.record.batchRecordId,history);
  const secondResult = await queue.materializeBatch({ batchRecordId: second.record.batchRecordId });
  assert.equal(secondResult.createdJobs,1);
  assert.equal((await reader.getDeliveryPackage(secondResult.jobs[0].deliveryJobId)).validatorEpoch,"8");
  assert.equal(oldPackage.validatorEpoch,"7");
  assert.deepEqual(await reader.getDeliveryPackage(firstResult.jobs[0].deliveryJobId),oldPackage);
  assert.deepEqual(await counts(),{ batches: 2,jobs: 4 });
});

for (const protocolVersion of ["1","2"]) {
  test(`legacy QC version ${protocolVersion} queues its original evidence without inventing a validator epoch`, async () => {
    const fixture = await deliveryFixture({ protocolVersion });
    await persist(fixture.batch.messages);
    const unbound = createBatchLifecycle({ config: { ...config,validatorSets: undefined },pool,committee: commitConfigs[0].peers });
    const collected = await unbound.collectEligible({ initialEpoch: fixture.record.epoch });
    const id = collected.snapshot.record.batchRecordId;
    await unbound.sealBatch({ batchRecordId: id });
    await unbound.markConsensusPending({ batchRecordId: id });
    const snapshot = await lifecycle.commitWithCertificate({ certificate: fixture.quorumCertificate });
    const result = await projector.materializeBatch({ batchRecordId: id });
    assert.equal(result.createdJobs,3);
    const pack = await repository.getDeliveryPackage(result.jobs[0].deliveryJobId);
    assert.equal(pack.validatorEpoch,null);
    assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
    assert.equal(pack.quorumCertificate.protocolVersion,protocolVersion);
    await applyMigrations(pool,config.databaseSchema);
    assert.deepEqual(await repository.getDeliveryPackage(result.jobs[0].deliveryJobId),pack);
  });
}
