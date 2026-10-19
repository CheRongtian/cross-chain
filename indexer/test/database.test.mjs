import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { loadDatabaseConfig } from "../src/config.mjs";
import {
  CanonicalDivergenceError,
  CanonicalHistoryBootstrapError,
  CanonicalHistoryChangedError,
  FinalizedSourceReorgError,
} from "../src/canonical-block.mjs";
import {
  applyMigrations,
  createCanonicalStore,
  createDatabasePool,
  createDatabaseStore,
  createFinalityStore,
  readCursor,
  readIndexedSourceBlocks,
  readMessages,
  readTableColumns,
  resetIndexerTables,
} from "../src/db.mjs";
import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import { createMessageBatcher } from "../src/message-batch.mjs";
import { buildMessageMerkleTree, verifyMessageMerkleProof } from "../src/message-merkle.mjs";
import { createCanonicalReconciler } from "../src/reorg-detector.mjs";
import { createFinalityWatcher } from "../src/finality-watcher.mjs";

assert.ok(process.env.DATABASE_URL, "DATABASE_URL is required for PostgreSQL tests");

const config = loadDatabaseConfig({
  ...process.env,
  INDEXER_DB_SCHEMA: process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test",
});
const pool = createDatabasePool(config);
const scope = {
  chainDomain: 10_011n,
  sourceGateway: "0x0000000000000000000000000000000000001001",
};
const store = createDatabaseStore(pool, config.databaseSchema);
const canonicalStore = createCanonicalStore(pool, config.databaseSchema);
const finalityStore = createFinalityStore(pool, config.databaseSchema);
const LARGE_INTEGER = (1n << 200n) + 123_456_789n;
const MIGRATION_002_URL = new URL("../migrations/002_idempotent_event_ingestion.sql", import.meta.url);
const schemaIdentifier = `"${config.databaseSchema}"`;
const cursorsTable = `${schemaIdentifier}."indexer_cursors"`;

function blockHash(number, branch = 0n) {
  const value = BigInt(number) + 1n + branch;
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function canonicalBlock(number, overrides = {}) {
  const normalizedNumber = BigInt(number);
  return {
    number: normalizedNumber,
    hash: blockHash(normalizedNumber),
    parentHash: normalizedNumber === 0n ? `0x${"00".repeat(32)}` : blockHash(normalizedNumber - 1n),
    ...overrides,
  };
}

function canonicalBlockRange(fromBlock, toBlock) {
  const blocks = [];
  for (let number = BigInt(fromBlock); number <= BigInt(toBlock); number += 1n) {
    blocks.push(canonicalBlock(number));
  }
  return blocks;
}

const rawPersistRange = store.persistRange.bind(store);
store.persistRange = (rangeScope, range) =>
  rawPersistRange(rangeScope, {
    ...range,
    blocks: range.blocks ?? canonicalBlockRange(range.fromBlock, range.toBlock),
  });

function messageRow(overrides = {}) {
  const row = {
    messageId: `0x${"11".repeat(32)}`,
    version: 2,
    sourceDomain: "10011",
    sourceGateway: scope.sourceGateway,
    sourceSender: "0x0000000000000000000000000000000000001002",
    destinationDomain: LARGE_INTEGER.toString(),
    destinationGateway: "0x0000000000000000000000000000000000002001",
    destinationReceiver: "0x0000000000000000000000000000000000002002",
    nonce: LARGE_INTEGER.toString(),
    payload: Buffer.from("database message", "utf8"),
    payloadHash: `0x${"22".repeat(32)}`,
    deadline: LARGE_INTEGER.toString(),
    sourceBlockNumber: "10",
    sourceBlockHash: undefined,
    sourceTransactionHash: `0x${"44".repeat(32)}`,
    sourceLogIndex: "3",
    ...overrides,
  };
  row.sourceBlockHash = overrides.sourceBlockHash ?? blockHash(row.sourceBlockNumber);
  return row;
}

function batchMessageRow(overrides = {}) {
  const row = messageRow(overrides);
  const payload = `0x${row.payload.toString("hex")}`;
  row.payloadHash = computePayloadHash(payload);
  row.messageId = computeCanonicalMessageId({ ...row, payload });
  return row;
}

async function insertRawMessage(client, row) {
  await client.query(
    `INSERT INTO source_messages (
        message_id,
        version,
        source_domain,
        source_gateway,
        source_sender,
        destination_domain,
        destination_gateway,
        destination_receiver,
        nonce,
        payload,
        payload_hash,
        deadline,
        source_block_number,
        source_block_hash,
        source_tx_hash,
        source_log_index
     ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8,
        $9, $10, $11, $12, $13, $14, $15, $16
     )`,
    [
      row.messageId,
      row.version,
      row.sourceDomain,
      row.sourceGateway,
      row.sourceSender,
      row.destinationDomain,
      row.destinationGateway,
      row.destinationReceiver,
      row.nonce,
      row.payload,
      row.payloadHash,
      row.deadline,
      row.sourceBlockNumber,
      row.sourceBlockHash,
      row.sourceTransactionHash,
      row.sourceLogIndex,
    ],
  );
}

async function initializeCursor(startBlock = 10n) {
  const nextBlock = await store.loadOrInitializeCursor(scope, startBlock);
  const history = await canonicalStore.readCanonicalHistoryState(scope);
  if (history.count === 0) {
    const anchorBlock = startBlock === 0n ? 0n : startBlock - 1n;
    await canonicalStore.bootstrapCanonicalHistory(scope, {
      expectedNextBlock: nextBlock,
      blocks: [canonicalBlock(anchorBlock)],
    });
  }
  return nextBlock;
}

async function rewindCursor(nextBlock) {
  const result = await pool.query(
    `UPDATE ${cursorsTable}
        SET next_block = $3, updated_at = CURRENT_TIMESTAMP
      WHERE chain_domain = $1 AND source_gateway = $2`,
    [scope.chainDomain.toString(), scope.sourceGateway, nextBlock.toString()],
  );
  assert.equal(result.rowCount, 1);
}

async function sourceEventConstraintColumns() {
  const result = await pool.query(
    `SELECT attribute.attname AS column_name
       FROM pg_constraint AS constraint_record
       JOIN pg_class AS relation_record
         ON relation_record.oid = constraint_record.conrelid
       JOIN pg_namespace AS namespace_record
         ON namespace_record.oid = relation_record.relnamespace
       CROSS JOIN LATERAL
         unnest(constraint_record.conkey) WITH ORDINALITY AS constraint_column(attnum, ordinality)
       JOIN pg_attribute AS attribute
         ON attribute.attrelid = relation_record.oid
        AND attribute.attnum = constraint_column.attnum
      WHERE namespace_record.nspname = $1
        AND relation_record.relname = 'source_messages'
        AND constraint_record.conname = 'source_messages_source_event_unique'
        AND constraint_record.contype = 'u'
      ORDER BY constraint_column.ordinality`,
    [config.databaseSchema],
  );
  return result.rows.map((row) => row.column_name);
}

function finalityResult(headBlock, overrides = {}) {
  return {
    headBlock,
    candidatesChecked: 0,
    observedToFinalizing: 0,
    observedToFinalized: 0,
    finalizingToFinalized: 0,
    unchangedFinalizing: 0,
    ...overrides,
  };
}

before(async () => {
  await applyMigrations(pool, config.databaseSchema);
});

beforeEach(async () => {
  await resetIndexerTables(pool, config.databaseSchema);
});

after(async () => {
  await pool.end();
});

test("migrations are re-runnable and install deterministic source-event uniqueness", async () => {
  const firstRun = await applyMigrations(pool, config.databaseSchema);
  const secondRun = await applyMigrations(pool, config.databaseSchema);
  const messageColumns = await readTableColumns(pool, config.databaseSchema, "source_messages");
  const cursorColumns = await readTableColumns(pool, config.databaseSchema, "indexer_cursors");

  assert.deepEqual(firstRun, [
    "001_chain_a_indexer.sql",
    "002_idempotent_event_ingestion.sql",
    "003_finality_watcher.sql",
    "004_source_reorg_detection.sql",
    "005_batch_lifecycle.sql",
    "006_pbft_commit.sql",
    "007_view_bound_qc.sql",
    "008_validator_epochs.sql",
    "009_delivery_queue.sql",
    "010_single_relayer.sql",
    "011_transaction_manager.sql",
    "012_transaction_retry_replacement.sql",
    "013_relayer_job_leases.sql",
    "014_transaction_recovery.sql",
    "015_rpc_response_errors.sql",
    "016_relayer_preparation_defer.sql",
    "017_transaction_scan_progress.sql",
    "018_destination_receipt_reconciliation.sql",
  ]);
  assert.deepEqual(secondRun, firstRun);
  assert.ok(messageColumns.some((column) => column.column_name === "message_id"));
  assert.ok(messageColumns.some((column) => column.column_name === "observed_at"));
  assert.ok(messageColumns.some((column) => column.column_name === "status"));
  assert.ok(messageColumns.some((column) => column.column_name === "finalizing_at"));
  assert.ok(messageColumns.some((column) => column.column_name === "finalized_at"));
  assert.ok(messageColumns.some((column) => column.column_name === "finalized_at_head"));
  assert.ok(messageColumns.some((column) => column.column_name === "reorged_at"));
  assert.ok(cursorColumns.some((column) => column.column_name === "next_block"));
  const blockColumns = await readTableColumns(
    pool,
    config.databaseSchema,
    "indexed_source_blocks",
  );
  assert.deepEqual(
    blockColumns.map((column) => column.column_name),
    [
      "source_domain",
      "source_gateway",
      "block_number",
      "block_hash",
      "parent_hash",
      "indexed_at",
    ],
  );
  assert.deepEqual(await sourceEventConstraintColumns(), [
    "source_domain",
    "source_gateway",
    "source_block_hash",
    "source_tx_hash",
    "source_log_index",
  ]);
});

test("idempotency migration fails clearly when duplicate event identities already exist", async () => {
  const migration = await readFile(MIGRATION_002_URL, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schemaIdentifier}`);
    await client.query(
      "ALTER TABLE source_messages DROP CONSTRAINT source_messages_source_event_unique",
    );
    await insertRawMessage(client, messageRow());
    await insertRawMessage(client, messageRow({ messageId: `0x${"55".repeat(32)}` }));

    await assert.rejects(
      client.query(migration),
      /Cannot enable idempotent event ingestion: duplicate source event identities already exist/,
    );
  } finally {
    await client.query("ROLLBACK");
    client.release();
  }
});

test("persists an OBSERVED message, large integers, provenance, and cursor atomically", async () => {
  assert.equal(await initializeCursor(), 10n);
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [messageRow()],
  });

  const messages = await readMessages(pool, config.databaseSchema);
  const cursor = await readCursor(pool, config.databaseSchema, scope);

  assert.deepEqual(result, { inserted: 1, duplicates: 0, nextBlock: 11n });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "OBSERVED");
  assert.equal(messages[0].destination_domain, LARGE_INTEGER.toString());
  assert.equal(messages[0].nonce, LARGE_INTEGER.toString());
  assert.equal(messages[0].deadline, LARGE_INTEGER.toString());
  assert.equal(messages[0].payload.toString("utf8"), "database message");
  assert.equal(messages[0].source_block_hash, blockHash(10n));
  assert.equal(messages[0].source_tx_hash, `0x${"44".repeat(32)}`);
  assert.equal(messages[0].source_log_index, "3");
  assert.ok(messages[0].observed_at instanceof Date);
  assert.equal(cursor.next_block, "11");
  assert.deepEqual(
    (await readIndexedSourceBlocks(pool, config.databaseSchema, scope)).map((block) => block.block_number),
    ["9", "10"],
  );
});

test("skips the same event across ranges without changing observation time or status", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });
  const firstObservation = (await readMessages(pool, config.databaseSchema))[0];

  await rewindCursor(10n);
  const duplicateResult = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [messageRow()],
  });
  const messages = await readMessages(pool, config.databaseSchema);
  const cursor = await readCursor(pool, config.databaseSchema, scope);

  assert.deepEqual(duplicateResult, { inserted: 0, duplicates: 1, nextBlock: 11n });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].observed_at.getTime(), firstObservation.observed_at.getTime());
  assert.equal(messages[0].status, firstObservation.status);
  assert.equal(cursor.next_block, "11");
});

test("deduplicates repeated logs in the same batch", async () => {
  await initializeCursor();
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [messageRow(), messageRow()],
  });

  assert.deepEqual(result, { inserted: 1, duplicates: 1, nextBlock: 11n });
  assert.equal((await readMessages(pool, config.databaseSchema)).length, 1);
});

test("persists two same-block events and skips a repeated first event", async () => {
  await initializeCursor();
  const first = messageRow({ sourceLogIndex: "0" });
  const second = messageRow({
    messageId: `0x${"66".repeat(32)}`,
    sourceLogIndex: "1",
  });
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [first, second, first],
  });

  const messages = await readMessages(pool, config.databaseSchema);
  assert.deepEqual(result, { inserted: 2, duplicates: 1, nextBlock: 11n });
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((message) => message.source_log_index),
    ["0", "1"],
  );
});

test("commits a duplicate and a new event together while advancing the cursor", async () => {
  await initializeCursor();
  const existing = messageRow({ sourceLogIndex: "0" });
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [existing] });

  await rewindCursor(10n);
  const newEvent = messageRow({
    messageId: `0x${"77".repeat(32)}`,
    sourceLogIndex: "1",
  });
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [existing, newEvent],
  });

  assert.deepEqual(result, { inserted: 1, duplicates: 1, nextBlock: 11n });
  assert.equal((await readMessages(pool, config.databaseSchema)).length, 2);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "11");
});

test("rejects an event whose block hash differs from canonical range metadata", async () => {
  await initializeCursor();
  await assert.rejects(
    store.persistRange(scope, {
      fromBlock: 10n,
      toBlock: 10n,
      rows: [messageRow({ sourceBlockHash: blockHash(10n, 1_000n) })],
    }),
    CanonicalDivergenceError,
  );

  assert.equal((await readMessages(pool, config.databaseSchema)).length, 0);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "10");
  assert.deepEqual(
    (await readIndexedSourceBlocks(pool, config.databaseSchema, scope)).map((block) => block.block_number),
    ["9"],
  );
});

test("rolls back new writes and cursor movement for an inconsistent duplicate", async () => {
  await initializeCursor();
  const existing = messageRow({ sourceLogIndex: "0" });
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [existing] });
  await rewindCursor(10n);

  const newEvent = messageRow({
    messageId: `0x${"99".repeat(32)}`,
    sourceLogIndex: "1",
  });
  const inconsistentDuplicate = messageRow({
    sourceLogIndex: "0",
    payload: Buffer.from("inconsistent payload", "utf8"),
  });

  await assert.rejects(
    store.persistRange(scope, {
      fromBlock: 10n,
      toBlock: 10n,
      rows: [newEvent, inconsistentDuplicate],
    }),
    /inconsistent duplicate source event.*payload differs/,
  );

  const messages = await readMessages(pool, config.databaseSchema);
  const cursor = await readCursor(pool, config.databaseSchema, scope);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message_id, existing.messageId);
  assert.equal(cursor.next_block, "10");
});

test("rolls back all writes when a non-duplicate row is invalid", async () => {
  await initializeCursor();

  await assert.rejects(
    store.persistRange(scope, {
      fromBlock: 10n,
      toBlock: 10n,
      rows: [
        messageRow(),
        messageRow({ messageId: null, sourceLogIndex: "4" }),
      ],
    }),
    /invalid message ID/,
  );

  assert.equal((await readMessages(pool, config.databaseSchema)).length, 0);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "10");
});

test("retries a complete range after an injected pre-commit cursor failure", async () => {
  await initializeCursor();
  const failureFunction = `${schemaIdentifier}."fail_cursor_advance_for_recovery_test"`;

  await pool.query(
    `DROP TRIGGER IF EXISTS fail_cursor_advance_for_recovery_test ON ${cursorsTable}`,
  );
  await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
  await pool.query(
    `CREATE OR REPLACE FUNCTION ${failureFunction}()
       RETURNS trigger
       LANGUAGE plpgsql
       AS $failure$
       BEGIN
         RAISE EXCEPTION 'injected cursor failure before commit';
       END;
       $failure$`,
  );
  await pool.query(
    `CREATE TRIGGER fail_cursor_advance_for_recovery_test
       BEFORE UPDATE OF next_block ON ${cursorsTable}
       FOR EACH ROW
       EXECUTE FUNCTION ${failureFunction}()`,
  );

  try {
    await assert.rejects(
      store.persistRange(scope, {
        fromBlock: 10n,
        toBlock: 10n,
        rows: [messageRow()],
      }),
      /injected cursor failure before commit/,
    );

    assert.equal((await readMessages(pool, config.databaseSchema)).length, 0);
    assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "10");
    assert.deepEqual(
      (await readIndexedSourceBlocks(
        pool,
        config.databaseSchema,
        scope,
      )).map((block) => block.block_number),
      ["9"],
    );
  } finally {
    await pool.query(
      `DROP TRIGGER IF EXISTS fail_cursor_advance_for_recovery_test ON ${cursorsTable}`,
    );
    await pool.query(`DROP FUNCTION IF EXISTS ${failureFunction}()`);
  }

  const retry = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [messageRow()],
  });

  assert.deepEqual(retry, { inserted: 1, duplicates: 0, nextBlock: 11n });
  assert.equal((await readMessages(pool, config.databaseSchema)).length, 1);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "11");
  assert.deepEqual(
    (await readIndexedSourceBlocks(
      pool,
      config.databaseSchema,
      scope,
    )).map((block) => block.block_number),
    ["9", "10"],
  );
});

test("a fresh PostgreSQL client resumes persisted terminal lifecycle state", async () => {
  await initializeCursor();
  const firstClientPool = createDatabasePool(config);

  try {
    const firstClientStore = createDatabaseStore(firstClientPool, config.databaseSchema);
    const firstClientFinalityStore = createFinalityStore(
      firstClientPool,
      config.databaseSchema,
    );
    const firstClientCanonicalStore = createCanonicalStore(
      firstClientPool,
      config.databaseSchema,
    );
    const orphanHash = blockHash(11n, 1_000n);

    await firstClientStore.persistRange(scope, {
      fromBlock: 10n,
      toBlock: 10n,
      blocks: canonicalBlockRange(10n, 10n),
      rows: [messageRow({ sourceLogIndex: "0" })],
    });
    await firstClientFinalityStore.advanceFinality(scope, {
      headBlock: 10n,
      finalityBlockDepth: 0n,
    });
    await firstClientStore.persistRange(scope, {
      fromBlock: 11n,
      toBlock: 11n,
      blocks: [
        canonicalBlock(11n, {
          hash: orphanHash,
          parentHash: blockHash(10n),
        }),
      ],
      rows: [
        messageRow({
          messageId: `0x${"55".repeat(32)}`,
          sourceBlockNumber: "11",
          sourceBlockHash: orphanHash,
          sourceTransactionHash: `0x${"45".repeat(32)}`,
          sourceLogIndex: "0",
        }),
      ],
    });
    await firstClientCanonicalStore.recoverCanonicalReorg(scope, {
      commonAncestor: canonicalBlock(10n),
      forkBlock: 11n,
    });
  } finally {
    await firstClientPool.end();
  }

  await assert.rejects(
    readCursor(firstClientPool, config.databaseSchema, scope),
    /end|closed|pool/i,
  );

  const recoveredClientPool = createDatabasePool(config);
  try {
    const recoveredStore = createDatabaseStore(
      recoveredClientPool,
      config.databaseSchema,
    );
    const recoveredFinalityStore = createFinalityStore(
      recoveredClientPool,
      config.databaseSchema,
    );
    const recoveredMessages = await readMessages(
      recoveredClientPool,
      config.databaseSchema,
    );
    const recoveredCursor = await readCursor(
      recoveredClientPool,
      config.databaseSchema,
      scope,
    );
    const recoveredBlocks = await readIndexedSourceBlocks(
      recoveredClientPool,
      config.databaseSchema,
      scope,
    );

    assert.deepEqual(
      recoveredMessages.map((row) => row.status),
      ["FINALIZED", "REORGED"],
    );
    assert.equal(recoveredCursor.next_block, "11");
    assert.deepEqual(
      recoveredBlocks.map((block) => block.block_number),
      ["9", "10"],
    );
    assert.deepEqual(
      (await recoveredFinalityStore.listBatchEligibleMessages(scope)).map(
        (row) => row.message_id,
      ),
      [`0x${"11".repeat(32)}`],
    );

    const terminalPass = await recoveredFinalityStore.advanceFinality(scope, {
      headBlock: 1_000n,
      finalityBlockDepth: 0n,
    });
    assert.deepEqual(terminalPass, finalityResult(1_000n));

    const replacementHash = blockHash(11n, 2_000n);
    const resumed = await recoveredStore.persistRange(scope, {
      fromBlock: 11n,
      toBlock: 11n,
      blocks: [
        canonicalBlock(11n, {
          hash: replacementHash,
          parentHash: blockHash(10n),
        }),
      ],
      rows: [
        messageRow({
          messageId: `0x${"66".repeat(32)}`,
          sourceBlockNumber: "11",
          sourceBlockHash: replacementHash,
          sourceTransactionHash: `0x${"46".repeat(32)}`,
          sourceLogIndex: "0",
        }),
      ],
    });
    assert.deepEqual(resumed, { inserted: 1, duplicates: 0, nextBlock: 12n });
    assert.deepEqual(
      (await readMessages(recoveredClientPool, config.databaseSchema)).map(
        (row) => row.status,
      ),
      ["FINALIZED", "REORGED", "OBSERVED"],
    );
  } finally {
    await recoveredClientPool.end();
  }
});

test("persists canonical metadata for every scanned block including empty blocks", async () => {
  await initializeCursor();
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 12n,
    rows: [],
  });

  const blocks = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
  assert.deepEqual(result, { inserted: 0, duplicates: 0, nextBlock: 13n });
  assert.deepEqual(blocks.map((block) => block.block_number), ["9", "10", "11", "12"]);
  assert.deepEqual(blocks.map((block) => block.block_hash), [
    blockHash(9n),
    blockHash(10n),
    blockHash(11n),
    blockHash(12n),
  ]);
});

test("accepts the same tracked block and rejects a different hash without overwriting", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [] });

  await rewindCursor(10n);
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [] });
  const storedBeforeConflict = await readIndexedSourceBlocks(
    pool,
    config.databaseSchema,
    scope,
  );

  await rewindCursor(10n);
  await assert.rejects(
    store.persistRange(scope, {
      fromBlock: 10n,
      toBlock: 10n,
      blocks: [
        canonicalBlock(10n, {
          hash: blockHash(10n, 1_000n),
          parentHash: blockHash(9n),
        }),
      ],
      rows: [],
    }),
    CanonicalDivergenceError,
  );

  const storedAfterConflict = await readIndexedSourceBlocks(
    pool,
    config.databaseSchema,
    scope,
  );
  assert.deepEqual(storedAfterConflict, storedBeforeConflict);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "10");
});

test("fails closed when pre-existing messages disagree during canonical bootstrap", async () => {
  assert.equal(await store.loadOrInitializeCursor(scope, 10n), 10n);
  await rewindCursor(11n);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SET LOCAL search_path TO ${schemaIdentifier}`);
    await insertRawMessage(
      client,
      messageRow({ sourceBlockHash: blockHash(10n, 1_000n) }),
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }

  await assert.rejects(
    canonicalStore.bootstrapCanonicalHistory(scope, {
      expectedNextBlock: 11n,
      blocks: canonicalBlockRange(9n, 10n),
    }),
    CanonicalHistoryBootstrapError,
  );
  assert.equal(
    (await canonicalStore.readCanonicalHistoryState(scope)).count,
    0,
  );
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "11");
  assert.equal((await readMessages(pool, config.databaseSchema))[0].status, "OBSERVED");
});

test("recovers an unfinalized fork and preserves old and replacement occurrences", async () => {
  await initializeCursor();
  const oldBlock10Hash = blockHash(10n, 1_000n);
  const oldBlock11Hash = blockHash(11n, 1_000n);
  const oldFinalizingEvent = messageRow({
    sourceBlockHash: oldBlock10Hash,
    sourceLogIndex: "0",
  });
  const oldObservedEvent = messageRow({
    messageId: `0x${"55".repeat(32)}`,
    sourceBlockNumber: "11",
    sourceBlockHash: oldBlock11Hash,
    sourceTransactionHash: `0x${"45".repeat(32)}`,
    sourceLogIndex: "0",
  });

  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    blocks: [
      canonicalBlock(10n, {
        hash: oldBlock10Hash,
        parentHash: blockHash(9n),
      }),
    ],
    rows: [oldFinalizingEvent],
  });
  await finalityStore.advanceFinality(scope, {
    headBlock: 10n,
    finalityBlockDepth: 2n,
  });
  await store.persistRange(scope, {
    fromBlock: 11n,
    toBlock: 11n,
    blocks: [
      canonicalBlock(11n, {
        hash: oldBlock11Hash,
        parentHash: oldBlock10Hash,
      }),
    ],
    rows: [oldObservedEvent],
  });

  const beforeRecovery = await readMessages(pool, config.databaseSchema);
  const firstFinalizingAt = beforeRecovery[0].finalizing_at.getTime();
  const firstObservedAt = beforeRecovery[0].observed_at.getTime();
  const secondObservedAt = beforeRecovery[1].observed_at.getTime();
  assert.deepEqual(beforeRecovery.map((row) => row.status), ["FINALIZING", "OBSERVED"]);

  const recovery = await canonicalStore.recoverCanonicalReorg(scope, {
    commonAncestor: canonicalBlock(9n),
    forkBlock: 10n,
    expectedState: {
      nextBlock: 12n,
      head: canonicalBlock(11n, { hash: oldBlock11Hash, parentHash: oldBlock10Hash }),
      probe: canonicalBlock(11n, { hash: oldBlock11Hash, parentHash: oldBlock10Hash }),
    },
  });
  const afterRecovery = await readMessages(pool, config.databaseSchema);
  const firstReorgedAt = afterRecovery[0].reorged_at.getTime();
  const secondReorgedAt = afterRecovery[1].reorged_at.getTime();

  assert.deepEqual(recovery, {
    reorgedMessages: 2,
    deletedCanonicalBlocks: 2,
    rewoundNextBlock: 10n,
  });
  assert.deepEqual(afterRecovery.map((row) => row.status), ["REORGED", "REORGED"]);
  assert.equal(afterRecovery[0].observed_at.getTime(), firstObservedAt);
  assert.equal(afterRecovery[0].finalizing_at.getTime(), firstFinalizingAt);
  assert.equal(afterRecovery[0].finalized_at, null);
  assert.equal(afterRecovery[0].source_block_hash, oldBlock10Hash);
  assert.equal(afterRecovery[1].observed_at.getTime(), secondObservedAt);
  assert.equal(afterRecovery[1].finalizing_at, null);
  assert.equal(afterRecovery[1].source_block_hash, oldBlock11Hash);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "10");
  assert.deepEqual(
    (await readIndexedSourceBlocks(pool, config.databaseSchema, scope)).map((block) => block.block_number),
    ["9"],
  );
  assert.equal((await finalityStore.listBatchEligibleMessages(scope)).length, 0);

  const terminalPass = await finalityStore.advanceFinality(scope, {
    headBlock: 1_000n,
    finalityBlockDepth: 2n,
  });
  assert.deepEqual(terminalPass, finalityResult(1_000n));
  assert.deepEqual(
    (await readMessages(pool, config.databaseSchema)).map((row) => row.status),
    ["REORGED", "REORGED"],
  );

  const repeatedRecovery = await canonicalStore.recoverCanonicalReorg(scope, {
    commonAncestor: canonicalBlock(9n),
    forkBlock: 10n,
  });
  const afterRepeatedRecovery = await readMessages(pool, config.databaseSchema);
  assert.equal(repeatedRecovery.reorgedMessages, 0);
  assert.equal(afterRepeatedRecovery[0].reorged_at.getTime(), firstReorgedAt);
  assert.equal(afterRepeatedRecovery[1].reorged_at.getTime(), secondReorgedAt);

  const replacementBlockHash = blockHash(10n, 2_000n);
  const replacementEvent = messageRow({
    sourceBlockHash: replacementBlockHash,
    sourceLogIndex: oldFinalizingEvent.sourceLogIndex,
    sourceTransactionHash: oldFinalizingEvent.sourceTransactionHash,
  });
  const replacementResult = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    blocks: [
      canonicalBlock(10n, {
        hash: replacementBlockHash,
        parentHash: blockHash(9n),
      }),
    ],
    rows: [replacementEvent],
  });
  const withReplacement = await readMessages(pool, config.databaseSchema);

  assert.deepEqual(replacementResult, { inserted: 1, duplicates: 0, nextBlock: 11n });
  assert.equal(withReplacement.length, 3);
  assert.deepEqual(withReplacement.map((row) => row.status), [
    "REORGED",
    "REORGED",
    "OBSERVED",
  ]);
  assert.equal(withReplacement[0].source_block_hash, oldBlock10Hash);
  assert.equal(withReplacement[2].source_block_hash, replacementBlockHash);
  assert.equal(withReplacement[0].message_id, withReplacement[2].message_id);
});

test("fails closed without any recovery mutation when a fork reaches FINALIZED", async () => {
  await initializeCursor();
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 11n,
    rows: [
      messageRow({ sourceBlockNumber: "10", sourceLogIndex: "0" }),
      messageRow({
        messageId: `0x${"66".repeat(32)}`,
        sourceBlockNumber: "11",
        sourceTransactionHash: `0x${"46".repeat(32)}`,
        sourceLogIndex: "0",
      }),
    ],
  });
  await finalityStore.advanceFinality(scope, {
    headBlock: 11n,
    finalityBlockDepth: 1n,
  });

  const messagesBefore = await readMessages(pool, config.databaseSchema);
  const blocksBefore = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
  const cursorBefore = await readCursor(pool, config.databaseSchema, scope);
  assert.deepEqual(messagesBefore.map((row) => row.status), ["FINALIZED", "FINALIZING"]);

  await assert.rejects(
    canonicalStore.recoverCanonicalReorg(scope, {
      commonAncestor: canonicalBlock(9n),
      forkBlock: 10n,
      expectedState: { nextBlock: 12n, head: canonicalBlock(11n), probe: canonicalBlock(11n) },
    }),
    FinalizedSourceReorgError,
  );

  const messagesAfter = await readMessages(pool, config.databaseSchema);
  const blocksAfter = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
  const cursorAfter = await readCursor(pool, config.databaseSchema, scope);
  assert.deepEqual(
    messagesAfter.map((row) => ({
      status: row.status,
      finalizingAt: row.finalizing_at?.getTime() ?? null,
      finalizedAt: row.finalized_at?.getTime() ?? null,
      reorgedAt: row.reorged_at,
    })),
    messagesBefore.map((row) => ({
      status: row.status,
      finalizingAt: row.finalizing_at?.getTime() ?? null,
      finalizedAt: row.finalized_at?.getTime() ?? null,
      reorgedAt: row.reorged_at,
    })),
  );
  assert.deepEqual(blocksAfter, blocksBefore);
  assert.equal(cursorAfter.next_block, cursorBefore.next_block);
});

test("advances OBSERVED through stable FINALIZING to terminal FINALIZED", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });

  const firstPass = await finalityStore.advanceFinality(scope, {
    headBlock: 10n,
    finalityBlockDepth: 2n,
  });
  const finalizingRow = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(firstPass, finalityResult(10n, {
    candidatesChecked: 1,
    observedToFinalizing: 1,
  }));
  assert.equal(finalizingRow.status, "FINALIZING");
  assert.ok(finalizingRow.finalizing_at instanceof Date);
  assert.equal(finalizingRow.finalized_at, null);
  assert.equal(finalizingRow.finalized_at_head, null);
  assert.equal((await finalityStore.listBatchEligibleMessages(scope)).length, 0);
  const firstFinalizingAt = finalizingRow.finalizing_at.getTime();

  const secondPass = await finalityStore.advanceFinality(scope, {
    headBlock: 11n,
    finalityBlockDepth: 2n,
  });
  const stillFinalizing = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(secondPass, finalityResult(11n, {
    candidatesChecked: 1,
    unchangedFinalizing: 1,
  }));
  assert.equal(stillFinalizing.status, "FINALIZING");
  assert.equal(stillFinalizing.finalizing_at.getTime(), firstFinalizingAt);
  assert.equal(stillFinalizing.finalized_at, null);

  const boundaryPass = await finalityStore.advanceFinality(scope, {
    headBlock: 12n,
    finalityBlockDepth: 2n,
  });
  const finalizedRow = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(boundaryPass, finalityResult(12n, {
    candidatesChecked: 1,
    finalizingToFinalized: 1,
  }));
  assert.equal(finalizedRow.status, "FINALIZED");
  assert.equal(finalizedRow.finalizing_at.getTime(), firstFinalizingAt);
  assert.ok(finalizedRow.finalized_at instanceof Date);
  assert.equal(finalizedRow.finalized_at_head, "12");
  assert.equal((await finalityStore.listBatchEligibleMessages(scope)).length, 1);
  const firstFinalizedAt = finalizedRow.finalized_at.getTime();

  const terminalPass = await finalityStore.advanceFinality(scope, {
    headBlock: 100n,
    finalityBlockDepth: 2n,
  });
  const terminalRow = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(terminalPass, finalityResult(100n));
  assert.equal(terminalRow.status, "FINALIZED");
  assert.equal(terminalRow.finalizing_at.getTime(), firstFinalizingAt);
  assert.equal(terminalRow.finalized_at.getTime(), firstFinalizedAt);
  assert.equal(terminalRow.finalized_at_head, "12");
});

test("finalizes an already deep OBSERVED message directly", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });

  const result = await finalityStore.advanceFinality(scope, {
    headBlock: 100n,
    finalityBlockDepth: 2n,
  });
  const row = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(result, finalityResult(100n, {
    candidatesChecked: 1,
    observedToFinalized: 1,
  }));
  assert.equal(row.status, "FINALIZED");
  assert.equal(row.finalizing_at, null);
  assert.ok(row.finalized_at instanceof Date);
  assert.equal(row.finalized_at_head, "100");
});

test("finalizes an OBSERVED message immediately at depth zero", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });

  const result = await finalityStore.advanceFinality(scope, {
    headBlock: 10n,
    finalityBlockDepth: 0n,
  });
  const row = (await readMessages(pool, config.databaseSchema))[0];

  assert.deepEqual(result, finalityResult(10n, {
    candidatesChecked: 1,
    observedToFinalized: 1,
  }));
  assert.equal(row.status, "FINALIZED");
  assert.equal(row.finalizing_at, null);
  assert.equal(row.finalized_at_head, "10");
});

test("evaluates messages independently and exposes only FINALIZED rows for batching", async () => {
  await initializeCursor();
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 12n,
    rows: [
      messageRow({ sourceBlockNumber: "10", sourceLogIndex: "0" }),
      messageRow({
        messageId: `0x${"55".repeat(32)}`,
        sourceBlockNumber: "11",
        sourceBlockHash: blockHash(11n),
        sourceTransactionHash: `0x${"45".repeat(32)}`,
        sourceLogIndex: "0",
      }),
      messageRow({
        messageId: `0x${"66".repeat(32)}`,
        sourceBlockNumber: "12",
        sourceBlockHash: blockHash(12n),
        sourceTransactionHash: `0x${"46".repeat(32)}`,
        sourceLogIndex: "0",
      }),
    ],
  });

  const pass = await finalityStore.advanceFinality(scope, {
    headBlock: 12n,
    finalityBlockDepth: 2n,
  });
  await store.persistRange(scope, {
    fromBlock: 13n,
    toBlock: 13n,
    rows: [
      messageRow({
        messageId: `0x${"77".repeat(32)}`,
        sourceBlockNumber: "13",
        sourceBlockHash: blockHash(13n),
        sourceTransactionHash: `0x${"47".repeat(32)}`,
        sourceLogIndex: "0",
      }),
    ],
  });

  const messages = await readMessages(pool, config.databaseSchema);
  const eligible = await finalityStore.listBatchEligibleMessages(scope);
  assert.deepEqual(pass, finalityResult(12n, {
    candidatesChecked: 3,
    observedToFinalizing: 2,
    observedToFinalized: 1,
  }));
  assert.deepEqual(messages.map((row) => row.status), [
    "FINALIZED",
    "FINALIZING",
    "FINALIZING",
    "OBSERVED",
  ]);
  assert.deepEqual(eligible.map((row) => row.message_id), [`0x${"11".repeat(32)}`]);
});

test("defers above-snapshot rows without rolling back eligible lifecycle updates", async () => {
  await initializeCursor();
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 20n,
    rows: [
      messageRow({ sourceBlockNumber: "10", sourceLogIndex: "0" }),
      messageRow({
        messageId: `0x${"88".repeat(32)}`,
        sourceBlockNumber: "20",
        sourceBlockHash: blockHash(20n),
        sourceTransactionHash: `0x${"48".repeat(32)}`,
        sourceLogIndex: "0",
      }),
    ],
  });

  const result = await finalityStore.advanceFinality(scope, {
    headBlock: 15n,
    finalityBlockDepth: 2n,
  });

  const messages = await readMessages(pool, config.databaseSchema);
  assert.equal(result.candidatesChecked, 1);
  assert.deepEqual(messages.map((row) => row.status), ["FINALIZED", "OBSERVED"]);
  assert.ok(messages.every((row) => row.finalizing_at === null));
  assert.equal(messages[1].finalized_at, null);
  const next = await finalityStore.advanceFinality(scope, { headBlock: 20n, finalityBlockDepth: 2n });
  assert.equal(next.observedToFinalizing, 1);
  assert.deepEqual((await readMessages(pool, config.databaseSchema)).map(row => row.status), ["FINALIZED", "FINALIZING"]);
});

test("a storage failure still rolls back every eligible lifecycle update", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 11n, rows: [
    messageRow({ sourceLogIndex: "0" }),
    messageRow({ sourceBlockNumber: "11", sourceLogIndex: "0", sourceTransactionHash: `0x${"49".repeat(32)}` }),
  ] });
  const before = await readMessages(pool, config.databaseSchema);
  const failingStore = createFinalityStore({
    async connect() {
      const client = await pool.connect();
      return {
        async query(sql, parameters) {
          if (sql.includes("UPDATE") && parameters[0] === before[1].id) {
            throw new Error("controlled finality write failure");
          }
          return client.query(sql, parameters);
        },
        release() { client.release(); },
      };
    },
  }, config.databaseSchema);
  await assert.rejects(failingStore.advanceFinality(scope, { headBlock: 20n, finalityBlockDepth: 2n }), /controlled finality write failure/);
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
});

for (const snapshot of [11n, (1n << 80n) + 11n]) {
  test(`bounds OBSERVED and FINALIZING candidates at exact snapshot ${snapshot}`, async () => {
    await initializeCursor(snapshot - 1n);
    const rows = [snapshot - 1n, snapshot, snapshot + 1n, snapshot + 2n].map((number, index) => messageRow({
      sourceBlockNumber: number.toString(), nonce: String(index), sourceLogIndex: "0",
      sourceTransactionHash: `0x${(70 + index).toString(16).repeat(32)}`,
    }));
    await store.persistRange(scope, { fromBlock: snapshot - 1n, toBlock: snapshot + 2n, rows });
    await pool.query(`UPDATE ${schemaIdentifier}."source_messages"
      SET status = 'FINALIZING', finalizing_at = CURRENT_TIMESTAMP
      WHERE source_block_number IN ($1::numeric, $2::numeric)`, [snapshot.toString(), (snapshot + 2n).toString()]);
    const before = await readMessages(pool, config.databaseSchema);
    const pass = await finalityStore.advanceFinality(scope, { headBlock: snapshot, finalityBlockDepth: 1n });
    const afterPass = await readMessages(pool, config.databaseSchema);
    assert.equal(pass.candidatesChecked, 2);
    assert.deepEqual(afterPass.map(row => row.status), ["FINALIZED", "FINALIZING", "OBSERVED", "FINALIZING"]);
    assert.deepEqual(afterPass.slice(2), before.slice(2));
    assert.equal(afterPass[0].finalized_at_head, snapshot.toString());
    const later = await finalityStore.advanceFinality(scope, { headBlock: snapshot + 3n, finalityBlockDepth: 1n });
    assert.equal(later.candidatesChecked, 3);
    assert.ok((await readMessages(pool, config.databaseSchema)).every(row => row.status === "FINALIZED"));
  });
}

for (const phase of ["after-head", "after-reconciliation"]) {
  test(`independent database clients preserve forward progress ${phase}`, { timeout: 30_000 }, async () => {
    await initializeCursor();
    await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow({ sourceLogIndex: "0" })] });
    const watcherPool = createDatabasePool(config);
    const indexerPool = createDatabasePool(config);
    const reached = Promise.withResolvers();
    const resume = Promise.withResolvers();
    let liveHead = 10n;
    let captured = false;
    let reconciliation;
    let recoveryCalls = 0;
    let pending;
    const liveClient = {
      async request({ method }) {
        assert.equal(method, "eth_blockNumber");
        const head = liveHead;
        if (phase === "after-head" && !captured) {
          captured = true;
          reached.resolve();
          await resume.promise;
        }
        return `0x${head.toString(16)}`;
      },
      async getBlock({ blockNumber }) { return canonicalBlock(blockNumber); },
    };
    const watcherConfig = { ...config, ...scope, sourceGatewayStartBlock: 10n, finalityBlockDepth: 2n };
    const watcherCanonicalStore = createCanonicalStore(watcherPool, config.databaseSchema);
    const recover = watcherCanonicalStore.recoverCanonicalReorg.bind(watcherCanonicalStore);
    watcherCanonicalStore.recoverCanonicalReorg = (...args) => { recoveryCalls += 1; return recover(...args); };
    const reconciler = createCanonicalReconciler({ config: watcherConfig, pool: watcherPool, publicClient: liveClient,
      canonicalStore: watcherCanonicalStore, logger: { log() {}, error() {} } });
    const watcher = createFinalityWatcher({ config: watcherConfig, pool: watcherPool, publicClient: liveClient,
      reconciler: { async reconcile(input) {
        reconciliation = await reconciler.reconcile(input);
        if (phase === "after-reconciliation") { reached.resolve(); await resume.promise; }
        return reconciliation;
      } }, logger: { log() {} } });
    try {
      const watcherPid = (await watcherPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      const indexerPid = (await indexerPool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
      assert.notEqual(watcherPid, indexerPid);
      pending = watcher.runFinalityPass();
      await Promise.race([reached.promise, pending.then(() => assert.fail("watcher did not reach the controlled barrier"))]);
      await createDatabaseStore(indexerPool, config.databaseSchema).persistRange(scope, {
        fromBlock: 11n, toBlock: 13n, blocks: canonicalBlockRange(11n, 13n),
        rows: [messageRow({ sourceBlockNumber: "11", sourceLogIndex: "0", sourceTransactionHash: `0x${"50".repeat(32)}` })],
      });
      liveHead = 13n;
      const blocksBefore = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
      const cursorBefore = await readCursor(pool, config.databaseSchema, scope);
      const futureBefore = (await readMessages(pool, config.databaseSchema))[1];
      assert.equal(cursorBefore.next_block, "14");
      resume.resolve();
      const pass = await pending;
      assert.equal(pass.headBlock, 10n);
      assert.equal(pass.candidatesChecked, 1);
      assert.equal(reconciliation.detected, false);
      assert.equal(recoveryCalls, 0);
      assert.deepEqual(await readIndexedSourceBlocks(pool, config.databaseSchema, scope), blocksBefore);
      assert.deepEqual(await readCursor(pool, config.databaseSchema, scope), cursorBefore);
      assert.deepEqual((await readMessages(pool, config.databaseSchema))[1], futureBefore);
      const later = await watcher.runFinalityPass();
      assert.equal(later.headBlock, 13n);
      assert.ok((await readMessages(pool, config.databaseSchema)).every(row => row.status === "FINALIZED"));
      console.log(`VALID: fixed snapshot 10, independent Indexer durable head 13 (${phase}); no recovery, H+1 message/blocks and cursor 14 preserved; later snapshot finalized the deferred row`);
    } finally {
      resume.resolve();
      if (pending) await pending.catch(() => {});
      await Promise.all([watcherPool.end(), indexerPool.end()]);
    }
  });
}

test("conditional reorg recovery refuses a cursor advanced by another client", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });
  const expectedState = { nextBlock: 11n, head: canonicalBlock(10n), probe: canonicalBlock(10n) };
  const otherPool = createDatabasePool(config);
  try {
    await createDatabaseStore(otherPool, config.databaseSchema).persistRange(scope, {
      fromBlock: 11n, toBlock: 11n, blocks: [canonicalBlock(11n)], rows: [],
    });
    const messagesBefore = await readMessages(pool, config.databaseSchema);
    const blocksBefore = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
    const cursorBefore = await readCursor(pool, config.databaseSchema, scope);
    await assert.rejects(canonicalStore.recoverCanonicalReorg(scope, {
      commonAncestor: canonicalBlock(9n), forkBlock: 10n, expectedState,
    }), CanonicalHistoryChangedError);
    assert.deepEqual(await readMessages(pool, config.databaseSchema), messagesBefore);
    assert.deepEqual(await readIndexedSourceBlocks(pool, config.databaseSchema, scope), blocksBefore);
    assert.deepEqual(await readCursor(pool, config.databaseSchema, scope), cursorBefore);
  } finally { await otherPool.end(); }
});

test("confirmed real head regression still recovers through the conditional transaction", async () => {
  await initializeCursor();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 11n, rows: [messageRow({ sourceBlockNumber: "11" })] });
  const result = await createCanonicalReconciler({
    config: { ...config, ...scope, sourceGatewayStartBlock: 10n }, pool,
    publicClient: {
      async request({ method }) { assert.equal(method, "eth_blockNumber"); return "0xa"; },
      async getBlock({ blockNumber }) { assert.ok(blockNumber <= 10n); return canonicalBlock(blockNumber); },
    }, logger: { log() {}, error() {} },
  }).reconcile({ headBlock: 10n });
  assert.equal(result.detected, true);
  assert.equal(result.commonAncestor, 10n);
  assert.equal(result.rewoundNextBlock, 11n);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "11");
  assert.deepEqual((await readIndexedSourceBlocks(pool, config.databaseSchema, scope)).map(row => row.block_number), ["9", "10"]);
  assert.equal((await readMessages(pool, config.databaseSchema))[0].status, "REORGED");
});

test("conditional recovery refuses replaced history even when cursor and height match", async () => {
  await initializeCursor();
  const old = messageRow();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [old] });
  const expectedState = { nextBlock: 11n, head: canonicalBlock(10n), probe: canonicalBlock(10n) };
  await canonicalStore.recoverCanonicalReorg(scope, { commonAncestor: canonicalBlock(9n), forkBlock: 10n });
  const replacementBlock = canonicalBlock(10n, { hash: blockHash(10n, 1_000n) });
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, blocks: [replacementBlock],
    rows: [messageRow({ sourceBlockHash: replacementBlock.hash })] });
  const messagesBefore = await readMessages(pool, config.databaseSchema);
  const blocksBefore = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
  await assert.rejects(canonicalStore.recoverCanonicalReorg(scope, {
    commonAncestor: canonicalBlock(9n), forkBlock: 10n, expectedState,
  }), CanonicalHistoryChangedError);
  assert.deepEqual(await readMessages(pool, config.databaseSchema), messagesBefore);
  assert.deepEqual(await readIndexedSourceBlocks(pool, config.databaseSchema, scope), blocksBefore);
  assert.equal((await readCursor(pool, config.databaseSchema, scope)).next_block, "11");
  // Exact old occurrences stay terminal even if a later canonical view returns
  // to those bytes. Conditional recovery must not be repaired by revival.
  await canonicalStore.recoverCanonicalReorg(scope, { commonAncestor: canonicalBlock(9n), forkBlock: 10n });
  const repeated = await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [old] });
  assert.equal(repeated.duplicates, 1);
  assert.ok((await readMessages(pool, config.databaseSchema)).every(row => row.status === "REORGED"));
});

test("duplicate re-ingestion preserves FINALIZED state and metadata", async () => {
  await initializeCursor();
  const event = messageRow();
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [event] });
  await finalityStore.advanceFinality(scope, {
    headBlock: 10n,
    finalityBlockDepth: 0n,
  });
  const finalizedBeforeRescan = (await readMessages(pool, config.databaseSchema))[0];

  await rewindCursor(10n);
  const rescan = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [event],
  });
  const messages = await readMessages(pool, config.databaseSchema);

  assert.deepEqual(rescan, { inserted: 0, duplicates: 1, nextBlock: 11n });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].status, "FINALIZED");
  assert.equal(
    messages[0].finalized_at.getTime(),
    finalizedBeforeRescan.finalized_at.getTime(),
  );
  assert.equal(messages[0].finalized_at_head, finalizedBeforeRescan.finalized_at_head);
});

test("the production batcher returns no batch when no FINALIZED rows exist", async () => {
  await initializeCursor();
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [batchMessageRow()],
  });
  const batcher = createMessageBatcher({
    config: { ...config, ...scope },
    pool,
  });
  const before = await readMessages(pool, config.databaseSchema);

  assert.equal(await batcher.buildBatch({ epoch: 1n }), undefined);
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
});

test("deterministic batching uses only FINALIZED rows and preserves lifecycle data", async () => {
  await initializeCursor();
  const first = batchMessageRow({ nonce: "1", sourceLogIndex: "0" });
  const second = batchMessageRow({ nonce: "2", sourceLogIndex: "1" });
  const finalizing = batchMessageRow({
    nonce: "3",
    sourceBlockNumber: "11",
    sourceLogIndex: "0",
  });
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 11n,
    rows: [second, finalizing, first],
  });
  await finalityStore.advanceFinality(scope, {
    headBlock: 12n,
    finalityBlockDepth: 2n,
  });

  const oldHash = blockHash(12n, 1_000n);
  const orphan = batchMessageRow({
    nonce: "4",
    sourceBlockNumber: "12",
    sourceBlockHash: oldHash,
    sourceLogIndex: "0",
  });
  await store.persistRange(scope, {
    fromBlock: 12n,
    toBlock: 12n,
    blocks: [canonicalBlock(12n, { hash: oldHash })],
    rows: [orphan],
  });
  await canonicalStore.recoverCanonicalReorg(scope, {
    commonAncestor: canonicalBlock(11n),
    forkBlock: 12n,
  });
  const observed = batchMessageRow({
    nonce: "5",
    sourceBlockNumber: "12",
    sourceLogIndex: "0",
  });
  await store.persistRange(scope, {
    fromBlock: 12n,
    toBlock: 12n,
    rows: [observed],
  });

  const before = await readMessages(pool, config.databaseSchema);
  const cursorBefore = await readCursor(pool, config.databaseSchema, scope);
  const blocksBefore = await readIndexedSourceBlocks(pool, config.databaseSchema, scope);
  assert.deepEqual(before.map((row) => row.status), [
    "FINALIZED", "FINALIZING", "FINALIZED", "REORGED", "OBSERVED",
  ]);
  assert.deepEqual(
    (await finalityStore.listBatchEligibleMessages(scope)).map((row) => row.message_id),
    [first.messageId, second.messageId],
  );
  const batcher = createMessageBatcher({ config: { ...config, ...scope }, pool });
  const batch = await batcher.buildBatch({ epoch: LARGE_INTEGER });
  const repeated = await batcher.buildBatch({ epoch: LARGE_INTEGER });
  assert.deepEqual(batch.messageIds, [first.messageId, second.messageId]);
  assert.deepEqual(batch.messages.map((message) => message.sourceLogIndex), [0n, 1n]);
  assert.deepEqual(repeated, batch);
  const tree = buildMessageMerkleTree(batch);
  assert.deepEqual(buildMessageMerkleTree(repeated), tree);
  for (let index = 0; index < batch.messages.length; index += 1) {
    assert.equal(verifyMessageMerkleProof({
      batch,
      message: batch.messages[index],
      proof: tree.proofs[index],
      messageRoot: tree.messageRoot,
    }), true);
  }
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
  assert.deepEqual(await readCursor(pool, config.databaseSchema, scope), cursorBefore);
  assert.deepEqual(await readIndexedSourceBlocks(pool, config.databaseSchema, scope), blocksBefore);

  const freshPool = createDatabasePool(config);
  try {
    const rebuilt = await createMessageBatcher({
      config: { ...config, ...scope },
      pool: freshPool,
    }).buildBatch({ epoch: LARGE_INTEGER.toString() });
    assert.deepEqual(rebuilt, batch);
    assert.deepEqual(buildMessageMerkleTree(rebuilt), tree);
  } finally {
    await freshPool.end();
  }

  await rewindCursor(10n);
  const rescan = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [first, second],
  });
  assert.deepEqual(rescan, { inserted: 0, duplicates: 2, nextBlock: 11n });
  assert.deepEqual(await batcher.buildBatch({ epoch: LARGE_INTEGER }), batch);
  assert.deepEqual(buildMessageMerkleTree(await batcher.buildBatch({ epoch: LARGE_INTEGER })), tree);
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
  assert.deepEqual(
    (await finalityStore.listBatchEligibleMessages(scope)).map((row) => row.message_id),
    [first.messageId, second.messageId],
  );
});

test("the production batcher rejects a persisted row with an inconsistent message ID", async () => {
  await initializeCursor();
  await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [batchMessageRow()],
  });
  await finalityStore.advanceFinality(scope, { headBlock: 10n, finalityBlockDepth: 0n });
  await pool.query(
    `UPDATE ${schemaIdentifier}."source_messages" SET message_id = $1`,
    [`0x${"ff".repeat(32)}`],
  );
  const before = await readMessages(pool, config.databaseSchema);
  await assert.rejects(
    createMessageBatcher({ config: { ...config, ...scope }, pool }).buildBatch({ epoch: 1n }),
    /canonical message ID mismatch/,
  );
  assert.deepEqual(await readMessages(pool, config.databaseSchema), before);
});
