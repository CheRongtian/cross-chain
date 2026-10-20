import assert from "node:assert/strict";
import { test } from "node:test";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createMessageQuery } from "../src/api/message-query.mjs";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { transactionConfig } from "./helpers/transaction-fixtures.mjs";
import { querySourceRow } from "./helpers/message-query-fixtures.mjs";
import { deliveryMessage, fixtureHash } from "./helpers/delivery-fixtures.mjs";

test("PostgreSQL message browsing stays scoped, deduplicates reorg occurrences and paginates without writes", async () => {
  const schema = `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_list`;
  const config = { ...transactionConfig({ DATABASE_URL: process.env.DATABASE_URL, INDEXER_DB_SCHEMA: schema }), finalityBlockDepth: 2n };
  const pool = createDatabasePool(config); let runtime;
  try {
    await applyMigrations(pool, schema); await resetIndexerTables(pool, schema);
    // Isolated source-occurrence fixtures, not lifecycle transitions performed
    // by an observational GET. The production query reads these rows unchanged.
    async function insert(message, status) {
      const { id, ...row } = querySourceRow(message, status);
      const fields = Object.keys(row);
      const result = await pool.query(`INSERT INTO ${tableName(schema, "source_messages")}
        (${fields.map(value => `"${value}"`).join(",")}) VALUES (${fields.map((_, index) => `$${index + 1}`).join(",")}) RETURNING id`, Object.values(row));
      return result.rows[0].id;
    }
    const expected = new Map();
    for (let index = 0; index < 25; index++) {
      const message = deliveryMessage(index);
      const status = ["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"][index % 4];
      const id = await insert(message, status); expected.set(message.messageId, { id, status });
    }
    // An orphan inserted later must not displace the existing live occurrence.
    await insert(deliveryMessage(0, { sourceBlockHash: fixtureHash(500) }), "REORGED");
    // All-orphan messages use their newest historical occurrence exactly once.
    const latestOrphan = await insert(deliveryMessage(3, { sourceBlockHash: fixtureHash(501) }), "REORGED");
    expected.set(deliveryMessage(3).messageId, { id: latestOrphan, status: "REORGED" });
    const replacement = await insert(deliveryMessage(7, { sourceBlockHash: fixtureHash(502) }), "OBSERVED");
    expected.set(deliveryMessage(7).messageId, { id: replacement, status: "OBSERVED" });
    await insert(deliveryMessage(100, { sourceDomain: 3001n }), "OBSERVED");
    await insert(deliveryMessage(101, { sourceGateway: "0x2222222222222222222222222222222222222222" }), "OBSERVED");
    const capture = async () => {
      const result = {};
      for (const name of ["source_messages", "indexer_cursors", "message_batches", "batch_quorum_certificates", "delivery_jobs",
        "transaction_accounts", "transaction_intents", "transaction_attempts", "relayer_job_leases", "transaction_broadcast_events"]) {
        result[name] = (await pool.query(`SELECT * FROM ${tableName(schema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return result;
    };
    const statements = [];
    const readPool = { async connect() {
      const client = await pool.connect();
      return { release: error => client.release(error), query(sql, params) {
        assert.ok(!/\b(INSERT|UPDATE|DELETE|FOR\s+SHARE|FOR\s+UPDATE|pg_.*advisory)/i.test(sql));
        statements.push(sql); return client.query(sql, params);
      } };
    } };
    const query = createMessageQuery({ config, pool: readPool });
    runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query });
    await runtime.listen(); const url = `http://127.0.0.1:${runtime.server.address().port}/api/v1/messages`;
    const before = await capture(); const listed = []; let cursor = null;
    do {
      const response = await fetch(`${url}?limit=4${cursor ? `&before=${cursor}` : ""}`);
      assert.equal(response.status, 200); const page = await response.json();
      assert.ok(page.items.length <= 4); listed.push(...page.items); cursor = page.nextCursor;
      assert.ok(listed.length <= expected.size, "pagination must terminate without repeating older occurrences");
    } while (cursor !== null);
    const ordered = [...expected].sort((a, b) => BigInt(a[1].id) > BigInt(b[1].id) ? -1 : 1);
    assert.deepEqual(listed.map(item => item.messageId), ordered.map(([id]) => id));
    for (const item of listed) {
      assert.equal(item.sourceDomain, config.chainDomain.toString()); assert.equal(item.sourceStatus, expected.get(item.messageId).status);
      assert.ok(!Object.hasOwn(item, "execution"), "source FINALIZED cannot be presented as destination execution");
      const detail = await query.getMessageLifecycle(item.messageId);
      assert.equal(detail.finality.status, item.sourceStatus);
    }
    const empty = await query.listMessages({ cursor: "1" }); assert.deepEqual(empty.items, []); assert.equal(empty.nextCursor, null);
    assert.equal((await (await fetch(url)).json()).items.length, 20);
    assert.deepEqual(await capture(), before);
    assert.ok(statements.includes("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    console.log("VALID: recent-message browsing is scoped, bounded, read-only and consistent with live/orphan detail selection");
  } finally { await runtime?.close(); await pool.end(); }
});
