import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, beforeEach, test } from "node:test";

import { loadDatabaseConfig } from "../src/config.mjs";
import {
  applyMigrations,
  createDatabasePool,
  createDatabaseStore,
  readCursor,
  readMessages,
  readTableColumns,
  resetIndexerTables,
} from "../src/db.mjs";

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
const LARGE_INTEGER = (1n << 200n) + 123_456_789n;
const MIGRATION_002_URL = new URL("../migrations/002_idempotent_event_ingestion.sql", import.meta.url);
const schemaIdentifier = `"${config.databaseSchema}"`;
const cursorsTable = `${schemaIdentifier}."indexer_cursors"`;

function messageRow(overrides = {}) {
  return {
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
    sourceBlockHash: `0x${"33".repeat(32)}`,
    sourceTransactionHash: `0x${"44".repeat(32)}`,
    sourceLogIndex: "3",
    ...overrides,
  };
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
  return store.loadOrInitializeCursor(scope, startBlock);
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

  assert.deepEqual(firstRun, ["001_chain_a_indexer.sql", "002_idempotent_event_ingestion.sql"]);
  assert.deepEqual(secondRun, firstRun);
  assert.ok(messageColumns.some((column) => column.column_name === "message_id"));
  assert.ok(messageColumns.some((column) => column.column_name === "observed_at"));
  assert.ok(messageColumns.some((column) => column.column_name === "status"));
  assert.ok(cursorColumns.some((column) => column.column_name === "next_block"));
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
  assert.equal(messages[0].source_block_hash, `0x${"33".repeat(32)}`);
  assert.equal(messages[0].source_tx_hash, `0x${"44".repeat(32)}`);
  assert.equal(messages[0].source_log_index, "3");
  assert.ok(messages[0].observed_at instanceof Date);
  assert.equal(cursor.next_block, "11");
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

test("allows the same protocol message identity under a different block occurrence", async () => {
  await initializeCursor();
  const result = await store.persistRange(scope, {
    fromBlock: 10n,
    toBlock: 10n,
    rows: [
      messageRow(),
      messageRow({
        sourceBlockHash: `0x${"88".repeat(32)}`,
      }),
    ],
  });

  assert.deepEqual(result, { inserted: 2, duplicates: 0, nextBlock: 11n });
  assert.equal((await readMessages(pool, config.databaseSchema)).length, 2);
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
