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

test("COMMITTED is representable and terminal while runtime authority remains unavailable", async () => {
  const { id } = await collectedPair();
  await lifecycle.sealBatch({ batchRecordId: id });
  const pending = await lifecycle.markConsensusPending({ batchRecordId: id });
  // A schema fixture exercises the reserved state. No production switch or commit API exists.
  await mutateFixture(`UPDATE ${batches} SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP
    WHERE batch_record_id = $1`, [id], batches, "message_batches_record_guard");
  const committed = await lifecycle.readBatch({ batchRecordId: id });
  assert.equal(committed.record.status, "COMMITTED");
  assert.ok(committed.record.committedAt instanceof Date);
  assert.deepEqual(committed.batch, pending.batch);
  assert.deepEqual(committed.tree, pending.tree);
  await assert.rejects(lifecycle.markConsensusPending({ batchRecordId: id }), /illegal batch lifecycle transition/);
  await assert.rejects(pool.query(`UPDATE ${batches} SET status = 'CONSENSUS_PENDING' WHERE batch_record_id = $1`, [id]), /illegal batch lifecycle transition/);
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
