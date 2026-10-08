import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { loadDatabaseConfig } from "../src/config.mjs";
import {
  applyMigration,
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

before(async () => {
  await applyMigration(pool, config.databaseSchema);
  await resetIndexerTables(pool, config.databaseSchema);
});

after(async () => {
  await pool.end();
});

test("migration creates message and cursor schemas", async () => {
  const messageColumns = await readTableColumns(pool, config.databaseSchema, "source_messages");
  const cursorColumns = await readTableColumns(pool, config.databaseSchema, "indexer_cursors");

  assert.ok(messageColumns.some((column) => column.column_name === "message_id"));
  assert.ok(messageColumns.some((column) => column.column_name === "observed_at"));
  assert.ok(messageColumns.some((column) => column.column_name === "status"));
  assert.ok(cursorColumns.some((column) => column.column_name === "next_block"));
});

test("persists OBSERVED messages, large integers, provenance, and cursor atomically", async () => {
  assert.equal(await store.loadOrInitializeCursor(scope, 10n), 10n);
  await store.persistRange(scope, { fromBlock: 10n, toBlock: 10n, rows: [messageRow()] });

  const messages = await readMessages(pool, config.databaseSchema);
  const cursor = await readCursor(pool, config.databaseSchema, scope);

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

test("persists multiple source events from one block before advancing the block cursor", async () => {
  await store.persistRange(scope, {
    fromBlock: 11n,
    toBlock: 11n,
    rows: [
      messageRow({
        messageId: `0x${"55".repeat(32)}`,
        sourceBlockNumber: "11",
        sourceLogIndex: "0",
      }),
      messageRow({
        messageId: `0x${"66".repeat(32)}`,
        sourceBlockNumber: "11",
        sourceLogIndex: "1",
      }),
    ],
  });

  const messages = await readMessages(pool, config.databaseSchema);
  const cursor = await readCursor(pool, config.databaseSchema, scope);
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.slice(1).map((message) => message.source_log_index),
    ["0", "1"],
  );
  assert.equal(cursor.next_block, "12");
  assert.equal(await store.loadOrInitializeCursor(scope, 0n), 12n);
});

test("rolls back all message writes and cursor movement when a range fails", async () => {
  const rowsBefore = await readMessages(pool, config.databaseSchema);
  const cursorBefore = await readCursor(pool, config.databaseSchema, scope);

  await assert.rejects(
    store.persistRange(scope, {
      fromBlock: 12n,
      toBlock: 12n,
      rows: [
        messageRow({ messageId: `0x${"77".repeat(32)}`, sourceBlockNumber: "12" }),
        messageRow({ messageId: null, sourceBlockNumber: "12", sourceLogIndex: "4" }),
      ],
    }),
    /null value|not-null/i,
  );

  const rowsAfter = await readMessages(pool, config.databaseSchema);
  const cursorAfter = await readCursor(pool, config.databaseSchema, scope);
  assert.equal(rowsAfter.length, rowsBefore.length);
  assert.equal(cursorAfter.next_block, cursorBefore.next_block);
});
