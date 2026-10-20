import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetrics, recordMetric } from "../src/metrics/registry.mjs";
import { registerPendingDelivery, PENDING_DELIVERY_NAME } from "../src/metrics/pending-delivery.mjs";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { transactionConfig } from "./helpers/transaction-fixtures.mjs";
import { scrapeMetrics, scrapeValue } from "./helpers/metrics-assertions.mjs";

test("pending collector is optional, singly owned, source-scoped, SELECT-only and refreshed on every scrape", async () => {
  const metrics = createMetrics(); const config = transactionConfig(); let count = "7"; const calls = [];
  assert.equal(metrics.registry.getSingleMetric(PENDING_DELIVERY_NAME), undefined);
  const owner = registerPendingDelivery({ config, metrics, pool: { async query(query) { calls.push(query); return { rows: [{ pending: count }] }; } } });
  try {
    assert.equal(calls.length, 0, "registration performs no database work");
    assert.equal(scrapeValue(await metrics.registry.metrics(), PENDING_DELIVERY_NAME), 7);
    count = "3";
    assert.equal(scrapeValue(await metrics.registry.metrics(), PENDING_DELIVERY_NAME), 3);
    assert.equal(calls.length, 2);
    for (const query of calls) {
      assert.ok(/^SELECT COUNT\(\*\)/.test(query.text));
      assert.ok(!/FOR UPDATE|FOR SHARE|advisory|INSERT|UPDATE |DELETE|TRUNCATE|BEGIN|COMMIT/i.test(query.text));
      assert.deepEqual(query.values, [config.chainDomain.toString(), config.sourceGateway]);
      assert.equal(query.query_timeout, 5000);
      assert.ok(query.text.includes("s.status = 'FINALIZED'"));
      assert.ok(query.text.includes("i.status IN ('CONFIRMED','REVERTED')"));
      assert.ok(!query.text.includes("retry_stopped_at") && !query.text.includes("preparation_retry_at"), "deferred and stopped jobs remain unresolved");
    }
    assert.throws(() => registerPendingDelivery({ config, pool: {}, metrics }), /already has an owner/);
  } finally { owner.close(); owner.close(); }
  assert.equal(metrics.registry.getSingleMetric(PENDING_DELIVERY_NAME), undefined);
  const next = registerPendingDelivery({ config, pool: { async query() { return { rows: [{ pending: "0" }] }; } }, metrics });
  try { assert.equal(scrapeValue(await metrics.registry.metrics(), PENDING_DELIVERY_NAME), 0); } finally { next.close(); }
});

test("unavailable or invalid pending observations export NaN, never stale counts/zero/secrets, without breaking other metrics or API", async () => {
  const metrics = createMetrics(); let result = "2"; let queries = 0;
  const secrets = ["DATABASE_PASSWORD_SENTINEL", "RPC_TOKEN_SENTINEL", "PRIVATE_KEY_SENTINEL", "RAW_SIGNED_TX_SENTINEL", "CREDENTIAL_WITNESS_SENTINEL"];
  const owner = registerPendingDelivery({ config: transactionConfig(), metrics, pool: { async query() {
    queries++; if (result === "throw") throw new Error(secrets.join(" "));
    return { rows: [{ pending: result }] };
  } } });
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {}, metrics });
  try {
    await runtime.listen(); const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    assert.equal(scrapeValue(await scrapeMetrics(origin), PENDING_DELIVERY_NAME), 2);
    for (const invalid of ["throw", "-1", "not-a-count", "9007199254740992", undefined]) {
      result = invalid;
      const body = await scrapeMetrics(origin);
      assert.ok(Number.isNaN(scrapeValue(body, PENDING_DELIVERY_NAME)));
      assert.ok(body.includes("cross_chain_messages_observed_total 0"));
      for (const secret of secrets) assert.ok(!body.includes(secret));
    }
    const before = queries;
    assert.equal((await fetch(`${origin}/metrics`, { method: "POST" })).status, 405);
    assert.equal(queries, before, "rejected methods do not collect pending data");
    assert.equal((await fetch(`${origin}/`)).status, 200);
    recordMetric(metrics, "observed");
    result = "0";
    const recovered = await scrapeMetrics(origin);
    assert.equal(scrapeValue(recovered, PENDING_DELIVERY_NAME), 0);
    assert.equal(scrapeValue(recovered, "cross_chain_messages_observed_total"), 1);
  } finally { await runtime.close(); owner.close(); }
});
