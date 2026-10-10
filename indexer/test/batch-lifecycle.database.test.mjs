import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";

import { loadDatabaseConfig } from "../src/config.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import {
  applyMigrations, createCanonicalStore, createDatabasePool, createDatabaseStore,
  createFinalityStore, readMessages, resetIndexerTables, tableName,
} from "../src/db.mjs";
import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import { createMessageBatcher } from "../src/message-batch.mjs";
import { buildMessageMerkleTree, verifyMessageMerkleProof } from "../src/message-merkle.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { commitConfigs, signedCommitFixture } from "../../validator/test/helpers/commit-fixtures.mjs";
import { buildQuorumCertificate, expectedCommitStatement, qcDigest } from "../../validator/src/quorum-certificate.mjs";
import { cloneCandidateFixture, sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = loadDatabaseConfig({
  ...process.env,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_lifecycle`,
});
const scope = { chainDomain: 10_011n, sourceGateway: "0x0000000000000000000000000000000000001001" };
const lifecycleConfig = { ...config, ...scope };
const pool = createDatabasePool(config);
const sourceStore = createDatabaseStore(pool, config.databaseSchema);
const finalityStore = createFinalityStore(pool, config.databaseSchema);
const canonicalStore = createCanonicalStore(pool, config.databaseSchema);
const lifecycle = createBatchLifecycle({ config: lifecycleConfig, pool });
const batches = tableName(config.databaseSchema, "message_batches");
const members = tableName(config.databaseSchema, "message_batch_members");
const failureFunction = tableName(config.databaseSchema, "reject_batch_seal_for_test");
const committee = commitConfigs[0].peers;
const certificateTable = tableName(config.databaseSchema, "batch_quorum_certificates");
const signaturesTable = tableName(config.databaseSchema, "batch_quorum_certificate_signatures");
const validatorSets = commitConfigs[0].validatorSets;
const committingLifecycle = createBatchLifecycle({ config: lifecycleConfig, pool, committee, validatorSets });

async function pendingCertificateFixture() {
  const { id } = await collectedPair();
  await lifecycle.sealBatch({ batchRecordId: id });
  await lifecycle.markConsensusPending({ batchRecordId: id });
  const pending = await committingLifecycle.pinConsensus({ batchRecordId: id });
  const statement = expectedCommitStatement({ sourceDomain: pending.record.sourceDomain, sourceGateway: pending.record.sourceGateway,
    epoch: pending.record.epoch, batchId: pending.record.batchId, messageRoot: pending.record.messageRoot, validatorEpoch: "0" }, committee, validatorSets);
  const options = { peers: committee, expected: statement };
  const votes = await Promise.all(commitConfigs.map((identity) => signedCommitFixture(statement, identity)));
  const a = await buildQuorumCertificate(votes.slice(0, 3), options);
  const b = await buildQuorumCertificate([votes[0], votes[1], votes[3]], options);
  return { id, pending, statement, options, votes, a, b };
}

async function certificateCounts() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${certificateTable})::int AS certificates,
    (SELECT COUNT(*) FROM ${signaturesTable})::int AS signatures`)).rows[0];
}

test("fixture rebuild replaces obsolete QC columns and constraints without changing source data", async () => {
  await pendingCertificateFixture();
  const fixtureSchema = `${config.databaseSchema}_fixture`;
  const obsoleteQC = tableName(fixtureSchema, "batch_quorum_certificates");
  const before = await sourceState(pool, config.databaseSchema);
  const triggersBefore = (await pool.query(`SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers
    WHERE trigger_schema = $1 ORDER BY event_object_table,trigger_name,event_manipulation`, [config.databaseSchema])).rows;
  await cloneCandidateFixture(pool, config.databaseSchema, fixtureSchema);
  await pool.query(`ALTER TABLE ${obsoleteQC} DROP COLUMN view`);
  await pool.query(`ALTER TABLE ${obsoleteQC} DROP CONSTRAINT batch_quorum_certificates_protocol_version_check`);
  await pool.query(`ALTER TABLE ${obsoleteQC} ADD CONSTRAINT batch_quorum_certificates_protocol_version_check CHECK (protocol_version = 1)`);
  for (let iteration = 0; iteration < 2; iteration++) {
    await cloneCandidateFixture(pool, config.databaseSchema, fixtureSchema);
    assert.deepEqual(await sourceState(pool, fixtureSchema), before);
    const sourceColumns = (await pool.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'batch_quorum_certificates' ORDER BY ordinal_position`, [config.databaseSchema])).rows;
    const fixtureColumns = (await pool.query(`SELECT column_name,data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'batch_quorum_certificates' ORDER BY ordinal_position`, [fixtureSchema])).rows;
    assert.deepEqual(fixtureColumns, sourceColumns);
    const checks = (await pool.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE conrelid = $1::regclass AND conname = 'batch_quorum_certificates_protocol_version_check'`, [obsoleteQC])).rows;
    assert.ok(checks[0].definition.includes('2'));
  }
  await assert.rejects(cloneCandidateFixture(pool, `${config.databaseSchema}_missing`, fixtureSchema), /does not exist/);
  assert.deepEqual(await sourceState(pool, fixtureSchema), before, "failed rebuild rolls back the previous complete fixture");
  assert.deepEqual(await sourceState(pool, config.databaseSchema), before);
  assert.deepEqual((await pool.query(`SELECT event_object_table,trigger_name,action_statement FROM information_schema.triggers
    WHERE trigger_schema = $1 ORDER BY event_object_table,trigger_name,event_manipulation`, [config.databaseSchema])).rows, triggersBefore);
});

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function block(number, overrides = {}) {
  return { number, hash: hash(number + 1n), parentHash: hash(number), ...overrides };
}

function message(blockNumber, logIndex, overrides = {}) {
  const payload = "0x68656c6c6f";
  const row = {
    version: 2,
    sourceDomain: scope.chainDomain.toString(),
    sourceGateway: scope.sourceGateway,
    sourceSender: "0x0000000000000000000000000000000000001002",
    destinationDomain: "2001",
    destinationGateway: "0x0000000000000000000000000000000000002001",
    destinationReceiver: "0x0000000000000000000000000000000000002002",
    nonce: (blockNumber * 100n + logIndex).toString(),
    payload: Buffer.from(payload.slice(2), "hex"),
    payloadHash: computePayloadHash(payload),
    deadline: "2000000000",
    sourceBlockNumber: blockNumber.toString(),
    sourceBlockHash: hash(blockNumber + 1n),
    sourceTransactionHash: hash(blockNumber * 100n + logIndex),
    sourceLogIndex: logIndex.toString(),
    ...overrides,
  };
  row.messageId = computeCanonicalMessageId({ ...row, payload: `0x${row.payload.toString("hex")}` });
  return row;
}

async function persist(fromBlock, toBlock, rows, blocks) {
  const canonical = blocks ?? Array.from(
    { length: Number(toBlock - fromBlock + 1n) },
    (_, index) => block(fromBlock + BigInt(index)),
  );
  return sourceStore.persistRange(scope, { fromBlock, toBlock, blocks: canonical, rows });
}

async function finalizedPair() {
  const first = message(10n, 0n);
  const second = message(10n, 1n);
  await persist(10n, 10n, [second, first]);
  await finalityStore.advanceFinality(scope, { headBlock: 10n, finalityBlockDepth: 0n });
  return { first, second, rows: await readMessages(pool, config.databaseSchema) };
}

async function collectedPair(initialEpoch = 23n) {
  const source = await finalizedPair();
  const collected = await lifecycle.collectEligible({ initialEpoch });
  return { ...source, collected, id: collected.snapshot.record.batchRecordId };
}

test("only a matching independently verified QC can commit; equivalent evidence preserves the first certificate", async () => {
  const { id, pending, a, b, votes, options } = await pendingCertificateFixture();
  const messagesBefore = await readMessages(pool, config.databaseSchema);
  await assert.rejects(committingLifecycle.commitWithCertificate({}), /QC batch ID/);
  await assert.rejects(committingLifecycle.commitWithCertificate({ certificate: { ...a, commits: a.commits.slice(0, 2) } }));
  await assert.rejects(pool.query(`UPDATE ${batches} SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP
    WHERE batch_record_id = $1`, [id]), /PBFT quorum authorization/);
  assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
  const committed = await committingLifecycle.commitWithCertificate({ certificate: a });
  assert.equal(committed.record.status, "COMMITTED");
  assert.deepEqual(committed.members, pending.members); assert.deepEqual(committed.batch, pending.batch);
  assert.deepEqual(committed.tree, pending.tree); assert.deepEqual(committed.quorumCertificate, a);
  assert.deepEqual(await committingLifecycle.commitWithCertificate({ certificate: a }), committed);
  assert.deepEqual(await committingLifecycle.commitWithCertificate({ certificate: b }), committed);
  assert.deepEqual(await committingLifecycle.commitWithCertificate({ certificate: await buildQuorumCertificate(votes, options) }), committed);
  assert.deepEqual(await certificateCounts(), { certificates: 1, signatures: 3 });
  assert.deepEqual(await readMessages(pool, config.databaseSchema), messagesBefore);
  await applyMigrations(pool, config.databaseSchema);
  const fresh = createDatabasePool(config);
  try {
    const reader = createBatchLifecycle({ config: lifecycleConfig, pool: fresh, committee });
    assert.deepEqual(await reader.readBatch({ batchRecordId: id }), committed);
    assert.deepEqual(await reader.commitWithCertificate({ certificate: b }), committed);
    await assert.rejects(createBatchLifecycle({ config: lifecycleConfig, pool: fresh }).readBatch({ batchRecordId: id }), /expected static committee/);
  } finally { await fresh.end(); }
  for (const status of ["CONSENSUS_PENDING", "SEALED"]) {
    await assert.rejects(pool.query(`UPDATE ${batches} SET status = $2 WHERE batch_record_id = $1`, [id, status]), /illegal batch lifecycle/);
  }
  await assert.rejects(pool.query(`UPDATE ${batches} SET message_root = $2 WHERE batch_record_id = $1`, [id, hash(99)]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${members} WHERE batch_record_id = $1`, [id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${certificateTable} WHERE batch_record_id = $1`, [id]), /immutable/);
  await assert.rejects(pool.query(`UPDATE ${signaturesTable} SET signature = $2 WHERE batch_record_id = $1`, [id, `0x${"ff".repeat(65)}`]), /immutable/);
});

test("QC transaction failure rolls back both certificate and batch status; fresh retry completes atomically", async () => {
  const { id, pending, a } = await pendingCertificateFixture();
  const failing = createBatchLifecycle({ config: lifecycleConfig, pool, committee,
    afterCertificatePersisted: async () => { throw new Error("injected failure after QC persistence"); } });
  await assert.rejects(failing.commitWithCertificate({ certificate: a }), /injected failure/);
  assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), pending);
  const fresh = createDatabasePool(config);
  try {
    const retry = createBatchLifecycle({ config: lifecycleConfig, pool: fresh, committee });
    assert.equal((await retry.commitWithCertificate({ certificate: a })).record.status, "COMMITTED");
  } finally { await fresh.end(); }
  assert.deepEqual(await certificateCounts(), { certificates: 1, signatures: 3 });
});

test("SQL cannot persist a certificate without the same transaction committing its batch", async () => {
  const { id, pending, a } = await pendingCertificateFixture();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO ${certificateTable}
      (batch_record_id, protocol_version, source_domain, source_gateway, epoch, batch_id,
       message_root, proposal_digest, committee_digest, qc_digest,validator_epoch)
      VALUES ($1,3,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, a.sourceDomain, a.sourceGateway, a.epoch, a.batchId, a.messageRoot, a.proposalDigest, a.committeeDigest, a.qcDigest,a.validatorEpoch]);
    for (const vote of a.commits) {
      await client.query(`INSERT INTO ${signaturesTable}
        (batch_record_id, voter_identity, commit_digest, signature) VALUES ($1,$2,$3,$4)`,
      [id, vote.voterIdentity, vote.commitDigest, vote.signature]);
    }
    await assert.rejects(client.query("COMMIT"), /must be atomic/);
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), pending);
});

test("concurrent same or equivalent QCs commit once; a conflicting certificate cannot win", async () => {
  const { id, a, b } = await pendingCertificateFixture();
  const changed = { ...a, messageRoot: hash(991) };
  changed.qcDigest = qcDigest(changed);
  const outcomes = await Promise.allSettled([
    committingLifecycle.commitWithCertificate({ certificate: a }),
    committingLifecycle.commitWithCertificate({ certificate: b }),
    committingLifecycle.commitWithCertificate({ certificate: a }),
    committingLifecycle.commitWithCertificate({ certificate: changed }),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 3);
  assert.equal(outcomes.filter((r) => r.status === "rejected").length, 1);
  const committed = await committingLifecycle.readBatch({ batchRecordId: id });
  for (const outcome of outcomes.filter((r) => r.status === "fulfilled")) assert.deepEqual(outcome.value, committed);
  assert.deepEqual(await certificateCounts(), { certificates: 1, signatures: 3 });
  assert.ok([a, b].some((q) => JSON.stringify(q) === JSON.stringify(committed.quorumCertificate)));
});

test("COMMITTED reads fail closed on corrupted persisted QC even when SQL structure is intact", async () => {
  const { id, a } = await pendingCertificateFixture();
  const committed = await committingLifecycle.commitWithCertificate({ certificate: a });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // Test-owned corruption is isolated to a rollback transaction; normal guards stay enabled afterwards.
    await client.query(`ALTER TABLE ${signaturesTable} DISABLE TRIGGER batch_quorum_certificate_signatures_guard`);
    await client.query(`UPDATE ${signaturesTable} SET signature = $2 WHERE batch_record_id = $1`, [id, `0x${"ff".repeat(65)}`]);
    // Read inside the corruption transaction without nesting BEGIN/COMMIT.
    const readPool = { async connect() { return { async query(sql, values) {
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return {};
      return client.query(sql, values);
    }, release() {} }; } };
    await assert.rejects(createBatchLifecycle({ config: lifecycleConfig, pool: readPool, committee }).readBatch({ batchRecordId: id }), /INVALID_SIGNATURE/);
  } finally { await client.query("ROLLBACK"); client.release(); }
  assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }), committed);
});

before(async () => {
  await applyMigrations(pool, config.databaseSchema);
  // Remove only this suite's fault fixture if a previous run was interrupted.
  await pool.query(`DROP TRIGGER IF EXISTS reject_batch_seal_for_test ON ${batches}`);
  await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
});
beforeEach(async () => {
  await resetIndexerTables(pool, config.databaseSchema);
  await sourceStore.loadOrInitializeCursor(scope, 10n);
  await canonicalStore.bootstrapCanonicalHistory(scope, { expectedNextBlock: 10n, blocks: [block(9n)] });
});
after(async () => {
  await pool.end();
});

test("migration is re-runnable and BUILDING state recovers without protocol commitments", async () => {
  await applyMigrations(pool, config.databaseSchema);
  const created = await lifecycle.getOrCreateBuilding({ initialEpoch: 23n });
  assert.equal(created.record.status, "BUILDING");
  assert.equal(created.record.epoch, 23n);
  assert.equal(created.record.batchId, null);
  assert.equal(created.record.messageRoot, null);
  assert.equal(created.record.messageCount, null);
  assert.deepEqual(created.members, []);
  await assert.rejects(lifecycle.sealBatch({ batchRecordId: created.record.batchRecordId }), /empty BUILDING/);
  await assert.rejects(pool.query(
    `UPDATE ${batches} SET status = 'SEALED', batch_id = $2, message_root = $2,
        message_count = 1, sealed_at = CURRENT_TIMESTAMP WHERE batch_record_id = $1`,
    [created.record.batchRecordId, hash(999n)],
  ), /cannot seal empty or inconsistent/);
  const freshPool = createDatabasePool(config);
  try {
    const restored = await createBatchLifecycle({ config: lifecycleConfig, pool: freshPool }).getOrCreateBuilding();
    assert.deepEqual(restored, created);
  } finally {
    await freshPool.end();
  }
  await assert.rejects(lifecycle.getOrCreateBuilding({ initialEpoch: 24n }), /initial epoch does not match/);
});

test("collection and same-occurrence assignment are idempotent and remain unsealed", async () => {
  const { collected, id, rows } = await collectedPair();
  assert.equal(collected.assignedCount, 2);
  assert.equal(collected.snapshot.record.batchId, null);
  assert.ok(collected.snapshot.members.every((member) => member.position === null));
  const repeated = await lifecycle.collectEligible();
  assert.equal(repeated.assignedCount, 0);
  assert.deepEqual(repeated.snapshot, collected.snapshot);
  const assignment = await lifecycle.assignMessages({ batchRecordId: id, sourceMessageIds: [rows[0].id, rows[0].id] });
  assert.equal(assignment.assignedCount, 0);
  assert.deepEqual(assignment.snapshot, collected.snapshot);
});

test("only FINALIZED occurrences in the correct source scope can be assigned", async () => {
  await persist(10n, 11n, [message(10n, 0n), message(11n, 0n)]);
  await finalityStore.advanceFinality(scope, { headBlock: 11n, finalityBlockDepth: 1n });
  const orphanHash = hash(999n);
  await persist(12n, 12n, [message(12n, 0n, { sourceBlockHash: orphanHash })], [block(12n, { hash: orphanHash })]);
  await canonicalStore.recoverCanonicalReorg(scope, { commonAncestor: block(11n), forkBlock: 12n });
  await persist(12n, 12n, [message(12n, 0n, { nonce: "9999" })]);
  const rows = await readMessages(pool, config.databaseSchema);
  assert.deepEqual(rows.map((row) => row.status), ["FINALIZED", "FINALIZING", "REORGED", "OBSERVED"]);
  const open = await lifecycle.getOrCreateBuilding({ initialEpoch: 23n });
  const id = open.record.batchRecordId;
  for (const row of rows.slice(1)) {
    await assert.rejects(lifecycle.assignMessages({ batchRecordId: id, sourceMessageIds: [row.id] }), /must be FINALIZED/);
    await assert.rejects(pool.query(
      `INSERT INTO ${members} (batch_record_id, source_message_id, message_id) VALUES ($1, $2, $3)`,
      [id, row.id, row.message_id],
    ), /must reference FINALIZED/);
  }
  const otherScope = { ...scope, sourceGateway: "0x0000000000000000000000000000000000001003" };
  const otherStore = createDatabaseStore(pool, config.databaseSchema);
  await otherStore.loadOrInitializeCursor(otherScope, 10n);
  await canonicalStore.bootstrapCanonicalHistory(otherScope, { expectedNextBlock: 10n, blocks: [block(9n)] });
  await otherStore.persistRange(otherScope, {
    fromBlock: 10n, toBlock: 10n, blocks: [block(10n)],
    rows: [message(10n, 0n, { sourceGateway: otherScope.sourceGateway })],
  });
  await finalityStore.advanceFinality(otherScope, { headBlock: 10n, finalityBlockDepth: 0n });
  const other = (await readMessages(pool, config.databaseSchema)).at(-1);
  await assert.rejects(lifecycle.assignMessages({ batchRecordId: id, sourceMessageIds: [other.id] }), /configured scope/);
  await assert.rejects(pool.query(
    `INSERT INTO ${members} (batch_record_id, source_message_id, message_id) VALUES ($1, $2, $3)`,
    [id, other.id, other.message_id],
  ), /source scope mismatch/);
  const collected = await lifecycle.collectEligible();
  assert.deepEqual(collected.snapshot.members.map((member) => member.sourceMessageId), [rows[0].id]);
});

test("sealing reuses canonical batch and Merkle definitions and survives client recreation", async () => {
  const { id, first, second } = await collectedPair();
  const before = await readMessages(pool, config.databaseSchema);
  const direct = await createMessageBatcher({ config: lifecycleConfig, pool }).buildBatch({ epoch: 23n });
  const directTree = buildMessageMerkleTree(direct);
  const building = await lifecycle.readBatch({ batchRecordId: id });
  await assert.rejects(lifecycle.sealBatch({ batchRecordId: id, expectedMessageRoot: hash(999n) }), /caller expectation/);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), building);
  const sealed = await lifecycle.sealBatch({ batchRecordId: id, expectedBatchId: direct.batchId, expectedMessageRoot: directTree.messageRoot });
  assert.equal(sealed.record.status, "SEALED");
  assert.deepEqual(sealed.batch, direct);
  assert.deepEqual(sealed.tree, directTree);
  assert.deepEqual(sealed.members.map((member) => member.messageId), [first.messageId, second.messageId]);
  assert.deepEqual(sealed.members.map((member) => member.position), [0n, 1n]);
  assert.equal(sealed.record.messageCount, 2n);
  assert.deepEqual(await lifecycle.sealBatch({ batchRecordId: id }), sealed);
  for (let index = 0; index < sealed.batch.messages.length; index += 1) {
    assert.equal(verifyMessageMerkleProof({ batch: sealed.batch, message: sealed.batch.messages[index], proof: sealed.tree.proofs[index], messageRoot: sealed.tree.messageRoot }), true);
  }
  await assert.rejects(lifecycle.sealBatch({ batchRecordId: id, expectedBatchId: hash(999n) }), /caller expectation/);
  await assert.rejects(lifecycle.sealBatch({ batchRecordId: id, expectedMessageRoot: hash(999n) }), /caller expectation/);
  const freshPool = createDatabasePool(config);
  try {
    assert.deepEqual(await createBatchLifecycle({ config: lifecycleConfig, pool: freshPool }).readBatch({ batchRecordId: id }), sealed);
  } finally {
    await freshPool.end();
  }
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
});

test("database guards reject every sealed snapshot or membership mutation", async () => {
  const { id, rows } = await collectedPair();
  const sealed = await lifecycle.sealBatch({ batchRecordId: id });
  await persist(11n, 11n, [message(11n, 0n)]);
  await finalityStore.advanceFinality(scope, { headBlock: 11n, finalityBlockDepth: 0n });
  const extra = (await readMessages(pool, config.databaseSchema)).at(-1);
  const mutations = [
    [`INSERT INTO ${members} (batch_record_id, source_message_id, message_id) VALUES ($1, $2, $3)`, [id, extra.id, extra.message_id]],
    [`DELETE FROM ${members} WHERE batch_record_id = $1`, [id]],
    [`UPDATE ${members} SET canonical_position = 10 WHERE batch_record_id = $1`, [id]],
    [`UPDATE ${members} SET message_id = $2 WHERE batch_record_id = $1`, [id, hash(999n)]],
    [`UPDATE ${batches} SET epoch = epoch + 1 WHERE batch_record_id = $1`, [id]],
    [`UPDATE ${batches} SET source_gateway = $2 WHERE batch_record_id = $1`, [id, "0x0000000000000000000000000000000000001003"]],
    [`UPDATE ${batches} SET version = 2 WHERE batch_record_id = $1`, [id]],
    [`UPDATE ${batches} SET batch_id = $2 WHERE batch_record_id = $1`, [id, hash(999n)]],
    [`UPDATE ${batches} SET message_root = $2 WHERE batch_record_id = $1`, [id, hash(999n)]],
    [`UPDATE ${batches} SET message_count = 99 WHERE batch_record_id = $1`, [id]],
    [`DELETE FROM ${batches} WHERE batch_record_id = $1`, [id]],
  ];
  for (const [sql, parameters] of mutations) {
    await assert.rejects(pool.query(sql, parameters), /immutable|cannot be deleted/);
  }
  await assert.rejects(lifecycle.assignMessages({ batchRecordId: id, sourceMessageIds: [rows[0].id] }), /only be assigned/);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), sealed);
});

test("CONSENSUS_PENDING is durable and ordinary APIs or SQL cannot self-authorize COMMITTED", async () => {
  const { id } = await collectedPair();
  await assert.rejects(lifecycle.markConsensusPending({ batchRecordId: id }), /illegal batch lifecycle transition/);
  await lifecycle.sealBatch({ batchRecordId: id });
  const pending = await lifecycle.markConsensusPending({ batchRecordId: id });
  assert.equal(pending.record.status, "CONSENSUS_PENDING");
  assert.equal(pending.record.committedAt, null);
  assert.deepEqual(await lifecycle.markConsensusPending({ batchRecordId: id }), pending);
  assert.equal("commitBatch" in lifecycle, false);
  assert.equal("transitionBatch" in lifecycle, false);
  await assert.rejects(pool.query(
    `UPDATE ${batches} SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP WHERE batch_record_id = $1`, [id],
  ), /PBFT quorum authorization/);
  await assert.rejects(pool.query(`UPDATE ${batches} SET status = 'SEALED', consensus_pending_at = NULL WHERE batch_record_id = $1`, [id]), /timestamps cannot be rewritten|illegal batch lifecycle transition/);
  const freshPool = createDatabasePool(config);
  try {
    assert.deepEqual(await createBatchLifecycle({ config: lifecycleConfig, pool: freshPool }).readBatch({ batchRecordId: id }), pending);
  } finally {
    await freshPool.end();
  }
});

test("new finalized messages roll into the next epoch without reassigning old members", async () => {
  const { id, rows } = await collectedPair();
  const sealed = await lifecycle.sealBatch({ batchRecordId: id });
  await persist(11n, 11n, [message(11n, 0n)]);
  await finalityStore.advanceFinality(scope, { headBlock: 11n, finalityBlockDepth: 0n });
  const newest = (await readMessages(pool, config.databaseSchema)).at(-1);
  const next = await lifecycle.collectEligible();
  assert.equal(next.snapshot.record.epoch, 24n);
  assert.equal(next.assignedCount, 1);
  assert.deepEqual(next.snapshot.members.map((member) => member.sourceMessageId), [newest.id]);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), sealed);
  await assert.rejects(lifecycle.assignMessages({ batchRecordId: next.snapshot.record.batchRecordId, sourceMessageIds: [rows[0].id] }), /already belongs/);
  await assert.rejects(pool.query(
    `INSERT INTO ${members} (batch_record_id, source_message_id, message_id) VALUES ($1, $2, $3)`,
    [next.snapshot.record.batchRecordId, rows[0].id, rows[0].message_id],
  ), /unique constraint/);
});

test("seal failure after position writes rolls back the complete snapshot and a fresh client retries", async () => {
  const { id, collected } = await collectedPair();
  await pool.query(`CREATE OR REPLACE FUNCTION ${failureFunction}() RETURNS trigger LANGUAGE plpgsql AS $failure$
    BEGIN
      IF NEW.status = 'SEALED' THEN
        RAISE EXCEPTION 'injected failure after member positions before seal commit';
      END IF;
      RETURN NEW;
    END;
    $failure$`);
  await pool.query(`CREATE TRIGGER reject_batch_seal_for_test BEFORE UPDATE ON ${batches}
    FOR EACH ROW EXECUTE FUNCTION ${failureFunction}()`);
  try {
    await assert.rejects(lifecycle.sealBatch({ batchRecordId: id }), /injected failure after member positions/);
    assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), collected.snapshot);
  } finally {
    await pool.query(`DROP TRIGGER IF EXISTS reject_batch_seal_for_test ON ${batches}`);
    await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
  }
  const expected = await createMessageBatcher({ config: lifecycleConfig, pool }).buildBatch({ epoch: 23n });
  const freshPool = createDatabasePool(config);
  try {
    const recovered = await createBatchLifecycle({ config: lifecycleConfig, pool: freshPool }).sealBatch({ batchRecordId: id });
    assert.deepEqual(recovered.batch, expected);
    assert.deepEqual(recovered.tree, buildMessageMerkleTree(expected));
    assert.deepEqual(recovered.members.map((member) => member.position), [0n, 1n]);
  } finally {
    await freshPool.end();
  }
});

async function mutateFixture(sql, parameters, table, trigger) {
  // Only the isolated test schema is affected. Constraints stay active, and guards
  // are re-enabled in the same transaction before the corrupted fixture is read.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(sql, parameters);
    // Drain deferred constraint events before changing trigger configuration.
    // Constraints still run; an invalid fixture rolls back with its guards restored.
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

test("sealed reads and pending transitions independently reject corrupted persisted commitments", async () => {
  const { id } = await collectedPair();
  const sealed = await lifecycle.sealBatch({ batchRecordId: id });
  await mutateFixture(`UPDATE ${batches} SET message_root = $2 WHERE batch_record_id = $1`, [id, hash(999n)], batches, "message_batches_record_guard");
  await assert.rejects(lifecycle.readBatch({ batchRecordId: id }), /Message Root mismatch/);
  await assert.rejects(lifecycle.markConsensusPending({ batchRecordId: id }), /Message Root mismatch/);
  await mutateFixture(`UPDATE ${batches} SET message_root = $2, batch_id = $3 WHERE batch_record_id = $1`, [id, sealed.tree.messageRoot, hash(999n)], batches, "message_batches_record_guard");
  await assert.rejects(lifecycle.readBatch({ batchRecordId: id }), /batch ID does not match/);
  await mutateFixture(`UPDATE ${batches} SET batch_id = $2 WHERE batch_record_id = $1`, [id, sealed.batch.batchId], batches, "message_batches_record_guard");
  await mutateFixture(`UPDATE ${batches} SET message_count = 99 WHERE batch_record_id = $1`, [id], batches, "message_batches_record_guard");
  await assert.rejects(lifecycle.readBatch({ batchRecordId: id }), /membership count mismatch/);
  await mutateFixture(`UPDATE ${batches} SET message_count = $2 WHERE batch_record_id = $1`, [id, sealed.record.messageCount.toString()], batches, "message_batches_record_guard");
  await mutateFixture(`UPDATE ${members} SET canonical_position = canonical_position + 10 WHERE batch_record_id = $1`, [id], members, "message_batch_members_guard");
  await assert.rejects(lifecycle.readBatch({ batchRecordId: id }), /positions or canonical order mismatch/);
});

test("QC-authorized COMMITTED is terminal and preserves the sealed commitment", async () => {
  const { id, pending, a } = await pendingCertificateFixture();
  const committed = await committingLifecycle.commitWithCertificate({ certificate: a });
  assert.equal(committed.record.status, "COMMITTED");
  assert.ok(committed.record.committedAt instanceof Date);
  assert.deepEqual(committed.batch, pending.batch);
  assert.deepEqual(committed.tree, pending.tree);
  await assert.rejects(lifecycle.markConsensusPending({ batchRecordId: id }), /illegal batch lifecycle transition/);
  await assert.rejects(pool.query(`UPDATE ${batches} SET status = 'CONSENSUS_PENDING' WHERE batch_record_id = $1`, [id]), /illegal batch lifecycle transition/);
});

test("finalized messages after COMMITTED enter the next epoch without changing the old QC or membership", async () => {
  const { id, a } = await pendingCertificateFixture();
  const committed = await committingLifecycle.commitWithCertificate({ certificate: a });
  await persist(11n, 11n, [message(11n, 0n)]);
  await finalityStore.advanceFinality(scope, { headBlock: 11n, finalityBlockDepth: 0n });
  const next = await lifecycle.collectEligible();
  assert.equal(next.assignedCount, 1);
  assert.equal(next.snapshot.record.epoch, committed.record.epoch + 1n);
  assert.equal(next.snapshot.record.status, "BUILDING");
  const extra = (await readMessages(pool, config.databaseSchema)).at(-1);
  await assert.rejects(lifecycle.assignMessages({ batchRecordId: id, sourceMessageIds: [extra.id] }), /only be assigned/);
  await assert.rejects(pool.query(`INSERT INTO ${members} (batch_record_id, source_message_id, message_id)
    VALUES ($1,$2,$3)`, [id, extra.id, extra.message_id]), /immutable/);
  assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }), committed);
});

test("fixed initial epoch automatically advances pending batches across a validator epoch boundary", async () => {
  const initialEpoch = 23n;
  const nextEpoch = initialEpoch + 1n;
  const { id } = await collectedPair(initialEpoch);
  const history = createValidatorSetResolver([
    { ...validatorSets.history[0], validatorEpoch: "7" },
    { ...validatorSets.history[0], validatorEpoch: "8", activationBatchEpoch: nextEpoch.toString() },
  ]);
  const manager = createBatchLifecycle({ config: lifecycleConfig, pool, committee, validatorSets: history });
  await manager.sealBatch({ batchRecordId: id });
  const first = await manager.markConsensusPending({ batchRecordId: id });
  assert.equal(first.record.epoch, initialEpoch);
  assert.equal(first.consensusBinding.validatorEpoch, "7");

  await persist(11n, 11n, [message(11n, 0n)]);
  await finalityStore.advanceFinality(scope, { headBlock: 11n, finalityBlockDepth: 0n });
  const building = await manager.getOrCreateBuilding({ initialEpoch });
  assert.equal(building.record.epoch, nextEpoch);
  assert.equal(building.record.status, "BUILDING");
  assert.deepEqual(await manager.getOrCreateBuilding({ initialEpoch }), building);
  await assert.rejects(
    manager.getOrCreateBuilding({ initialEpoch: nextEpoch }),
    /initial epoch does not match persisted batch history/,
  );
  assert.deepEqual(await manager.readBatch({ batchRecordId: building.record.batchRecordId }), building);
  const extra = (await readMessages(pool, config.databaseSchema)).find((row) => row.source_block_number === "11");
  assert.ok(extra);
  await manager.assignMessages({ batchRecordId: building.record.batchRecordId, sourceMessageIds: [extra.id] });
  await manager.sealBatch({ batchRecordId: building.record.batchRecordId });
  const second = await manager.markConsensusPending({ batchRecordId: building.record.batchRecordId });
  assert.equal(second.record.epoch, nextEpoch);
  assert.equal(second.record.status, "CONSENSUS_PENDING");
  assert.deepEqual(second.consensusBinding, {
    protocolVersion: "3",
    validatorEpoch: "8",
    committeeDigest: history.resolveForBatchEpoch(nextEpoch).committeeDigest,
  });
  assert.deepEqual(await manager.readBatch({ batchRecordId: id }), first);
  assert.deepEqual(await manager.markConsensusPending({ batchRecordId: second.record.batchRecordId }), second);
  assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
});

test("epoch rollover is exact for large values and rejects uint256 overflow", async () => {
  const large = (1n << 200n) + 1n;
  const { id } = await collectedPair(large);
  await lifecycle.sealBatch({ batchRecordId: id });
  const next = await lifecycle.getOrCreateBuilding();
  assert.equal(next.record.epoch, large + 1n);
  assert.equal(next.record.batchId, null);
  await resetIndexerTables(pool, config.databaseSchema);
  await sourceStore.loadOrInitializeCursor(scope, 10n);
  await canonicalStore.bootstrapCanonicalHistory(scope, { expectedNextBlock: 10n, blocks: [block(9n)] });
  const maximum = (1n << 256n) - 1n;
  const maxBatch = await collectedPair(maximum);
  const sealed = await lifecycle.sealBatch({ batchRecordId: maxBatch.id });
  await assert.rejects(lifecycle.getOrCreateBuilding(), /uint256 overflow/);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: maxBatch.id }), sealed);
});

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function barrierPool({ acquired, release, attempted }) {
  let intercepted = false;
  return {
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          const isScopeLock = sql.includes('"indexer_cursors"') && sql.includes("FOR UPDATE");
          if (!intercepted && isScopeLock) {
            intercepted = true;
            attempted?.resolve();
            const result = await client.query(sql, parameters);
            acquired?.resolve();
            if (release !== undefined) {
              await release.promise;
            }
            return result;
          }
          return client.query(sql, parameters);
        },
        release(error) {
          client.release(error);
        },
      };
    },
  };
}

async function concurrentOperations(operation) {
  const acquired = deferred();
  const release = deferred();
  const attempted = deferred();
  const firstManager = createBatchLifecycle({ config: lifecycleConfig, pool: barrierPool({ acquired, release }) });
  const secondManager = createBatchLifecycle({ config: lifecycleConfig, pool: barrierPool({ attempted }) });
  const first = operation(firstManager);
  let second;
  try {
    await Promise.race([acquired.promise, first.then(() => { throw new Error("first operation finished before the scope lock barrier"); })]);
    second = operation(secondManager);
    await Promise.race([attempted.promise, second.then(() => { throw new Error("second operation finished before attempting the scope lock"); })]);
    release.resolve();
    return await Promise.all([first, second]);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
}

test("concurrent creators produce one BUILDING record per scope", async () => {
  const [first, second] = await concurrentOperations((manager) => manager.getOrCreateBuilding({ initialEpoch: 23n }));
  assert.equal(first.record.batchRecordId, second.record.batchRecordId);
  assert.equal((await pool.query(`SELECT COUNT(*) AS count FROM ${batches}`)).rows[0].count, "1");
  await assert.rejects(pool.query(`INSERT INTO ${batches} (source_domain, source_gateway, epoch) VALUES ($1, $2, $3)`, [scope.chainDomain.toString(), scope.sourceGateway, "24"]), /unique constraint/);
});

test("concurrent collectors cannot double-assign any source occurrence", async () => {
  await finalizedPair();
  const [first, second] = await concurrentOperations((manager) => manager.collectEligible({ initialEpoch: 23n }));
  assert.equal(first.assignedCount + second.assignedCount, 2);
  assert.equal(first.snapshot.record.batchRecordId, second.snapshot.record.batchRecordId);
  assert.equal((await pool.query(`SELECT COUNT(*) AS count FROM ${members}`)).rows[0].count, "2");
});

test("concurrent identical seal attempts produce one canonical durable snapshot", async () => {
  const { id } = await collectedPair();
  const [first, second] = await concurrentOperations((manager) => manager.sealBatch({ batchRecordId: id }));
  assert.deepEqual(first, second);
  assert.equal((await pool.query(`SELECT COUNT(*) AS count FROM ${batches}`)).rows[0].count, "1");
  assert.equal(first.record.status, "SEALED");
});

test("view-bound QCs preserve the first final certificate across equivalent later and earlier views", async () => {
  const { pending, a, id } = await pendingCertificateFixture();
  const statement = expectedCommitStatement({ sourceDomain: pending.record.sourceDomain, sourceGateway: pending.record.sourceGateway,
    epoch: pending.record.epoch, validatorEpoch: "0", view: "1", batchId: pending.record.batchId, messageRoot: pending.record.messageRoot }, committee, validatorSets);
  const commits = await Promise.all(commitConfigs.slice(0, 3).map((identity) => signedCommitFixture(statement, identity)));
  const later = await buildQuorumCertificate(commits, { peers: committee, expected: statement });
  const first = await committingLifecycle.commitWithCertificate({ certificate: later });
  assert.equal(first.quorumCertificate.view, "1");
  const lateOld = await committingLifecycle.commitWithCertificate({ certificate: a });
  assert.deepEqual(lateOld, first);
  assert.deepEqual(await certificateCounts(), { certificates: 1, signatures: 3 });
  const row = (await pool.query(`SELECT view,protocol_version FROM ${certificateTable} WHERE batch_record_id = $1`, [id])).rows[0];
  assert.equal(row.view, "1"); assert.equal(row.protocol_version, 3);
  const rootCount = (await pool.query(`SELECT COUNT(DISTINCT message_root)::int AS count FROM ${certificateTable}
    WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`, [a.sourceDomain, a.sourceGateway, a.epoch])).rows[0].count;
  assert.equal(rootCount, 1);
  await applyMigrations(pool,config.databaseSchema);
  assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }),first);
});

test("source consensus pinning is idempotent, immutable and rejects a conflicting trusted epoch", async () => {
  const { id,pending } = await pendingCertificateFixture();
  const expected = validatorSets.resolveForBatchEpoch(pending.record.epoch);
  assert.deepEqual(pending.consensusBinding, {
    protocolVersion: "3",
    validatorEpoch: expected.validatorEpoch,
    committeeDigest: expected.committeeDigest,
  });
  assert.equal(Object.isFrozen(pending.consensusBinding), true);
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), pending);
  const [first,second] = await Promise.all([committingLifecycle.pinConsensus({ batchRecordId: id }),committingLifecycle.pinConsensus({ batchRecordId: id })]);
  assert.deepEqual(first,second); assert.deepEqual(first,pending);
  const bindingTable = tableName(config.databaseSchema,"batch_consensus_bindings");
  await assert.rejects(pool.query(`UPDATE ${bindingTable} SET validator_epoch = 1 WHERE batch_record_id = $1`,[id]), /immutable/);
  await assert.rejects(pool.query(`DELETE FROM ${bindingTable} WHERE batch_record_id = $1`,[id]), /immutable/);
  const differentHistory = createValidatorSetResolver([{ ...validatorSets.history[0],validatorEpoch: "1" }]);
  const conflicting = createBatchLifecycle({ config: lifecycleConfig,pool,committee,validatorSets: differentHistory });
  await assert.rejects(conflicting.pinConsensus({ batchRecordId: id }), /conflicting source batch consensus binding/);
  await assert.rejects(conflicting.readBatch({ batchRecordId: id }), /source batch committee binding differs from trusted history/);
  assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }),pending);
});

test("pending transition returns its persisted binding across retries and fresh readers", async () => {
  const { id } = await collectedPair();
  const sealed = await committingLifecycle.sealBatch({ batchRecordId: id });
  assert.equal(sealed.consensusBinding, null);
  const pending = await committingLifecycle.markConsensusPending({ batchRecordId: id });
  const expected = validatorSets.resolveForBatchEpoch(pending.record.epoch);
  assert.equal(pending.record.status, "CONSENSUS_PENDING");
  assert.deepEqual(pending.consensusBinding, {
    protocolVersion: "3",
    validatorEpoch: expected.validatorEpoch,
    committeeDigest: expected.committeeDigest,
  });
  assert.deepEqual(pending.members, sealed.members);
  assert.deepEqual(pending.batch, sealed.batch);
  assert.deepEqual(pending.tree, sealed.tree);
  assert.deepEqual(await committingLifecycle.markConsensusPending({ batchRecordId: id }), pending);
  const fresh = createDatabasePool(config);
  try {
    const reader = createBatchLifecycle({ config: lifecycleConfig, pool: fresh, committee, validatorSets });
    assert.deepEqual(await reader.readBatch({ batchRecordId: id }), pending);
    assert.deepEqual(await reader.pinConsensus({ batchRecordId: id }), pending);
    const unconfiguredReader = createBatchLifecycle({ config: lifecycleConfig, pool: fresh });
    assert.deepEqual(await unconfiguredReader.readBatch({ batchRecordId: id }), pending);
  } finally { await fresh.end(); }
});

test("pending QC submission rejects each mismatched binding without changing state", async () => {
  const { id, pending, a } = await pendingCertificateFixture();
  for (const certificate of [
    { ...a, protocolVersion: "2" },
    { ...a, validatorEpoch: "1" },
    { ...a, committeeDigest: hash(991) },
  ]) {
    await assert.rejects(
      committingLifecycle.commitWithCertificate({ certificate }),
      { code: "WRONG_CONSENSUS_BINDING" },
    );
    assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }), pending);
    assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
  }
  const committed = await committingLifecycle.commitWithCertificate({ certificate: a });
  assert.equal(committed.record.status, "COMMITTED");
  assert.deepEqual(committed.consensusBinding, pending.consensusBinding);
});

test("an unbound pending batch cannot adopt the validator epoch from a valid QC", async () => {
  const { id } = await collectedPair();
  await lifecycle.sealBatch({ batchRecordId: id });
  const pending = await lifecycle.markConsensusPending({ batchRecordId: id });
  assert.equal(pending.consensusBinding, null);
  const statement = expectedCommitStatement({
    sourceDomain: pending.record.sourceDomain,
    sourceGateway: pending.record.sourceGateway,
    epoch: pending.record.epoch,
    batchId: pending.record.batchId,
    messageRoot: pending.record.messageRoot,
  }, committee, validatorSets);
  const commits = await Promise.all(commitConfigs.slice(0, 3).map((identity) => signedCommitFixture(statement, identity)));
  const certificate = await buildQuorumCertificate(commits, { peers: committee, expected: statement, validatorSets });
  await assert.rejects(
    committingLifecycle.commitWithCertificate({ certificate }),
    { code: "WRONG_CONSENSUS_BINDING" },
  );
  assert.deepEqual(await lifecycle.readBatch({ batchRecordId: id }), pending);
  assert.deepEqual(await certificateCounts(), { certificates: 0, signatures: 0 });
});

test("historical version-one QC remains verifiable after QC metadata migration", async () => {
  const { id } = await collectedPair();
  await lifecycle.sealBatch({ batchRecordId: id });
  const pending = await lifecycle.markConsensusPending({ batchRecordId: id });
  const statement = expectedCommitStatement({ protocolVersion: "1", sourceDomain: pending.record.sourceDomain,
    sourceGateway: pending.record.sourceGateway, epoch: pending.record.epoch, batchId: pending.record.batchId,
    messageRoot: pending.record.messageRoot }, committee);
  const commits = await Promise.all(commitConfigs.slice(0, 3).map((identity) => signedCommitFixture(statement, identity)));
  const certificate = await buildQuorumCertificate(commits, { peers: committee, expected: statement });
  const committed = await committingLifecycle.commitWithCertificate({ certificate });
  await applyMigrations(pool, config.databaseSchema);
  assert.deepEqual(await committingLifecycle.readBatch({ batchRecordId: id }), committed);
  assert.equal(committed.quorumCertificate.protocolVersion, "1");
  assert.equal(Object.hasOwn(committed.quorumCertificate, "view"), false);
});
