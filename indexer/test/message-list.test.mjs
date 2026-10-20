import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { listRecentMessages, messageListOptions, parseMessageListQuery } from "../src/api/message-list.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";

const config = { databaseSchema: "existing_source", chainDomain: 9007199254740993n,
  sourceGateway: "0x1111111111111111111111111111111111111111" };
const row = index => ({ id: (9007199254741999n - BigInt(index)).toString(), message_id: fixtureHash(index + 1),
  source_domain: config.chainDomain.toString(), source_gateway: config.sourceGateway, destination_domain: "9007199254740995",
  status: "OBSERVED", observed_at: new Date("2026-10-20T00:00:00.000Z"), secret: "NEVER_EXPOSE_SOURCE_ROW_EXTRAS" });
function reader(rows, calls = []) {
  return { async connect() { return { release() { calls.push({ release: true }); }, async query(sql, values) {
    calls.push({ sql, values });
    assert.ok(!/\b(INSERT|UPDATE|DELETE|FOR\s+SHARE|FOR\s+UPDATE|pg_.*advisory)/i.test(sql));
    return { rows: sql.startsWith("SELECT") ? rows : [] };
  } }; } };
}

test("message list pagination is bounded and validates duplicate, unknown and inexact parameters", () => {
  assert.deepEqual(parseMessageListQuery(new URLSearchParams()), { limit: 20, cursor: null });
  assert.deepEqual(parseMessageListQuery(new URLSearchParams("limit=100&before=9007199254740993")), { limit: 100, cursor: "9007199254740993" });
  for (const query of ["limit=", "limit=0", "limit=101", "limit=01", "limit=1.5", "limit=1e2", "limit=2&limit=3",
    "before=", "before=0", "before=-1", "before=01", "before=1.5", "before=9223372036854775808", "before=1&before=2",
    "before=1%3BDROP+TABLE+source_messages", "schema=other_scope", "offset=20"]) {
    assert.throws(() => parseMessageListQuery(new URLSearchParams(query)), { code: "INVALID_LIST_QUERY", status: 400 });
  }
  for (const limit of [0, 101, 1.5, "20", NaN]) assert.throws(() => messageListOptions({ limit }), { code: "INVALID_LIST_QUERY" });
});

test("one read-only snapshot projects at most one bounded page with exact integers and no private row fields", async () => {
  const calls = [];
  const rows = Array.from({ length: 21 }, (_, index) => row(index));
  const page = await listRecentMessages({ config, pool: reader(rows, calls) });
  assert.equal(page.items.length, 20); assert.equal(page.nextCursor, rows[19].id);
  assert.deepEqual(page.items[0], { messageId: rows[0].message_id, sourceDomain: config.chainDomain.toString(),
    destinationDomain: rows[0].destination_domain, sourceStatus: "OBSERVED", observedAt: rows[0].observed_at.toISOString() });
  assert.ok(!JSON.stringify(page).includes(rows[0].secret));
  assert.equal(page.apiVersion, "1"); assert.equal(page.authority, "OBSERVATIONAL");
  assert.equal(calls[0].sql, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  assert.equal(calls.at(-2).sql, "COMMIT"); assert.equal(calls.at(-1).release, true);
  const select = calls.find(value => value.sql?.startsWith("SELECT"));
  assert.deepEqual(select.values, [config.chainDomain.toString(), config.sourceGateway, null, 21]);
  assert.ok(select.sql.includes("NOT EXISTS")); assert.ok(select.sql.includes("ORDER BY s.id DESC LIMIT $4"));
  const later = [];
  await listRecentMessages({ config, pool: reader([], later) }, { limit: 2, cursor: page.nextCursor });
  assert.deepEqual(later.find(value => value.sql?.startsWith("SELECT")).values, [config.chainDomain.toString(), config.sourceGateway, page.nextCursor, 3]);
});

test("empty, final and malformed persisted pages cannot manufacture data or terminal outcomes", async () => {
  assert.deepEqual((await listRecentMessages({ config, pool: reader([]) })).items, []);
  assert.equal((await listRecentMessages({ config, pool: reader([row(0)]) })).nextCursor, null);
  for (const patch of [{ status: "CONFIRMED" }, { source_domain: "2001" }, { source_gateway: "0x2222222222222222222222222222222222222222" },
    { message_id: "not-a-hash" }, { observed_at: null }, { observed_at: "not-a-time" }, { id: "1.5" }]) {
    const calls = [];
    await assert.rejects(() => listRecentMessages({ config, pool: reader([{ ...row(0), ...patch }], calls) }), { code: "INCONSISTENT_EVIDENCE" });
    assert.equal(calls.at(-2).sql, "ROLLBACK");
  }
});

test("invalid list options fail before acquiring a database client", async () => {
  const pool = { connect() { assert.fail("invalid query must fail before database access"); } };
  await assert.rejects(() => listRecentMessages({ config, pool }, { limit: 101 }), { code: "INVALID_LIST_QUERY" });
});

test("HTTP list route is GET-only, parses pagination before reads and preserves fixed safe errors", async () => {
  const calls = []; const secret = "LIST_DATABASE_PASSWORD_MUST_NOT_LEAK"; let failure;
  const page = { apiVersion: "1", authority: "OBSERVATIONAL", observedAt: new Date().toISOString(), items: [], nextCursor: null };
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {
    async listMessages(options) { calls.push(options); if (failure) throw failure; return page; },
  } });
  try {
    await runtime.listen(); const url = `http://127.0.0.1:${runtime.server.address().port}/api/v1/messages`;
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) assert.equal((await fetch(url, { method })).status, 405);
    assert.equal(calls.length, 0);
    assert.equal((await fetch(`${url}?limit=101`)).status, 400); assert.equal(calls.length, 0);
    const response = await fetch(`${url}?limit=2&before=9007199254740993`);
    assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), page); assert.deepEqual(calls, [{ limit: 2, cursor: "9007199254740993" }]);
    for (const [code, status] of [["ECONNREFUSED", 503], ["XX000", 500]]) {
      failure = Object.assign(new Error(secret), { code });
      const failed = await fetch(url); assert.equal(failed.status, status); assert.ok(!(await failed.text()).includes(secret));
    }
  } finally { await runtime.close(); }
});
