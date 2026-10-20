import assert from "node:assert/strict";
import { test } from "node:test";
import { createMetrics, processMetrics, bindPoolMetrics, recordMetric, afterMetricCommit, secondsBetween, relayerFailure,
  DEFINITIONS, PBFT_BUCKETS, LATENCY_BUCKETS } from "../src/metrics/registry.mjs";
import { deliveryTransaction } from "../src/delivery/repository.mjs";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { createValidatorServer } from "../../validator/src/server.mjs";
import { startWorkerMetrics } from "../src/metrics/http.mjs";
import { createDestinationRpcPool } from "../src/transaction-manager/rpc-pool.mjs";
import { transactionConfig } from "./helpers/transaction-fixtures.mjs";
import { environment } from "../../validator/test/helpers/fixtures.mjs";
import { loadValidatorConfig } from "../../validator/src/config.mjs";
import { metricValue, scrapeValue, scrapeMetrics } from "./helpers/metrics-assertions.mjs";

test("all fifteen canonical instruments have correct types, HELP, bounded labels and isolated registry ownership", async () => {
  const metrics = createMetrics(); assert.notEqual(metrics.registry, processMetrics.registry);
  assert.equal(createMetrics({ registry: metrics.registry }), metrics);
  const families = await metrics.registry.getMetricsAsJSON(); assert.equal(families.length, 15);
  for (const [, suffix, type, help, labels = {}] of DEFINITIONS) {
    const family = families.find(value => value.name === `cross_chain_${suffix}`);
    assert.ok(family); assert.equal(family.type, type.toLowerCase()); assert.equal(family.help, help);
    assert.ok(Object.values(labels).every(values => values.length > 0));
    for (const key of Object.keys(labels)) assert.ok(!/id|hash|root|address|url|nonce|signature|error_message|worker/i.test(key));
  }
  console.log("VALID: metric labels are bounded and exclude message IDs, batch IDs, transaction hashes, roots, arbitrary errors, RPC URLs and secrets");
});

test("invalid labels and injected secrets cannot become exposition series", async () => {
  const metrics = createMetrics();
  const secrets = ["DATABASE_PASSWORD_SENTINEL", "RPC_TOKEN_SENTINEL", "PRIVATE_KEY_SENTINEL", "RAW_SIGNED_TX_SENTINEL", "CREDENTIAL_WITNESS_SENTINEL"];
  for (const secret of secrets) {
    recordMetric(metrics, "observed", { messageId: secret });
    recordMetric(metrics, "rpc", { operation: secret, reason_class: "TRANSIENT_RPC_ERROR" });
    recordMetric(metrics, "rpc", { operation: "eth_call", reason_class: secret });
    relayerFailure(metrics, new Error(secret), "run");
  }
  const text = await metrics.registry.metrics();
  for (const secret of secrets) assert.ok(!text.includes(secret));
  assert.equal(await metricValue("messages_observed_total", { metrics }), 0);
  console.log("VALID: metrics exposition contains no private keys, raw signed transactions, credential witness data, RPC credentials or database connection material");
});

test("transaction event sinks update only after COMMIT, discard rollback and isolate broken observation sinks", async () => {
  const metrics = createMetrics(); const statements = []; let failed = false; let committed = 0;
  const pool = { async connect() { return { async query(sql) {
    statements.push(sql);
    if (sql === "COMMIT") { assert.equal(await metricValue("batches_created_total", { metrics }), committed); if (failed) throw new Error("durable commit rejected"); }
    return { rows: [], rowCount: 0 };
  }, release() {} }; } };
  bindPoolMetrics(pool, metrics);
  failed = true;
  await assert.rejects(() => deliveryTransaction(pool, async client => { afterMetricCommit(client, sink => recordMetric(sink, "batches")); }), /durable commit rejected/);
  assert.equal(await metricValue("batches_created_total", { metrics }), 0);
  failed = false;
  await deliveryTransaction(pool, async client => { afterMetricCommit(client, sink => recordMetric(sink, "batches")); });
  committed = 1;
  assert.equal(await metricValue("batches_created_total", { metrics }), 1);
  bindPoolMetrics(pool, { safely() { throw new Error("metrics unavailable"); } });
  await deliveryTransaction(pool, async client => { afterMetricCommit(client, () => { throw new Error("serialization failed"); }); });
  assert.ok(statements.includes("ROLLBACK"));
  console.log("VALID: metrics scrape/serialization unavailability does not participate in or authorize protocol processing");
});

test("histograms use deterministic persisted timestamps, fixed cumulative buckets and reject invalid durations", async () => {
  const metrics = createMetrics(); const start = "2026-01-01T00:00:00.000Z"; const end = "2026-01-01T00:00:02.500Z";
  assert.equal(secondsBetween(start, end), 2.5);
  for (const [a, b] of [[null, end], [start, null], [end, start], ["invalid", end]]) assert.equal(secondsBetween(a, b), null);
  recordMetric(metrics, "round", { outcome: "committed" }, secondsBetween(start, end));
  recordMetric(metrics, "latency", {}, secondsBetween(start, end));
  for (const invalid of [-1, NaN, Infinity, null]) recordMetric(metrics, "latency", {}, invalid);
  assert.equal(await metricValue("pbft_round_duration_seconds", { metrics, labels: { outcome: "committed" }, part: "_count" }), 1);
  assert.equal(await metricValue("cross_chain_latency_seconds", { metrics, part: "_sum" }), 2.5);
  const text = await metrics.registry.metrics();
  assert.equal(scrapeValue(text, "cross_chain_pbft_round_duration_seconds_bucket", { outcome: "committed", le: "1" }), 0);
  assert.equal(scrapeValue(text, "cross_chain_pbft_round_duration_seconds_bucket", { outcome: "committed", le: "2.5" }), 1);
  assert.equal(scrapeValue(text, "cross_chain_cross_chain_latency_seconds_bucket", { le: "+Inf" }), 1);
  assert.deepEqual(PBFT_BUCKETS, [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]);
  assert.deepEqual(LATENCY_BUCKETS, [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]);
});

test("one primary RPC request failure is counted even when secondary succeeds, without a Relayer action failure", async () => {
  const metrics = createMetrics(); const config = transactionConfig({ CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]' });
  const pool = createDestinationRpcPool({ config, metrics, createClient: url => ({ async request({ method }) {
    if (url === config.destinationRpcUrls[0]) throw Object.assign(new Error("RPC_TOKEN_SENTINEL"), { code: "ECONNREFUSED" });
    if (method === "eth_chainId") return "0x7d1";
    if (method === "eth_getBlockByNumber") return { number: "0x0", hash: config.destinationGenesisHash };
    throw new Error("unexpected fixture RPC operation");
  } }) });
  assert.equal(await pool.verifyChain(), 2001n);
  assert.equal(await metricValue("rpc_failures_total", { metrics }), 1);
  assert.equal(await metricValue("relayer_failures_total", { metrics }), 0);
  assert.ok(!(await metrics.registry.metrics()).includes("RPC_TOKEN_SENTINEL"));
});

test("API and Validator serve library exposition without invoking query/readiness work on scrape", async () => {
  const metrics = createMetrics(); let checks = 0;
  const api = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, metrics,
    query: { getMessageLifecycle() { assert.fail("scrape cannot query message state"); } } });
  const validator = createValidatorServer({ config: { ...loadValidatorConfig(environment()), listenPort: 0 }, metrics,
    checkReady: async () => { checks++; throw new Error("database unavailable"); } });
  try {
    assert.equal(await metricValue("validator_available", { metrics }), 0);
    await api.listen(); await validator.listen();
    assert.equal(await metricValue("validator_available", { metrics }), 1);
    for (const runtime of [api, validator]) {
      const origin = `http://127.0.0.1:${runtime.server.address().port}`;
      const text = await scrapeMetrics(origin);
      for (const [, suffix, type] of DEFINITIONS) assert.ok(text.includes(`# TYPE cross_chain_${suffix} ${type.toLowerCase()}`));
      assert.equal((await fetch(`${origin}/metrics`, { method: "POST" })).status, 405);
      assert.equal((await fetch(`${origin}/metrics`, { method: "HEAD" })).status, 200);
    }
    assert.equal(checks, 0);
    assert.equal((await fetch(`http://127.0.0.1:${validator.server.address().port}/health`)).status, 503);
    assert.equal(await metricValue("validator_available", { metrics }), 0);
    const original = metrics.registry.metrics; metrics.registry.metrics = async () => { throw new Error("DATABASE_PASSWORD_SENTINEL"); };
    const response = await fetch(`http://127.0.0.1:${api.server.address().port}/metrics`);
    assert.equal(response.status, 503); assert.ok(!(await response.text()).includes("SENTINEL"));
    assert.equal((await fetch(`http://127.0.0.1:${api.server.address().port}/`)).status, 200);
    metrics.registry.metrics = original;
  } finally { await api.close(); await validator.close(); }
});

test("metrics-only worker listener is opt-in, loopback-bound and closes with its owner", async () => {
  const quiet = { log() {}, warn() {} }; const metrics = createMetrics();
  const omitted = await startWorkerMetrics({ environment: {}, logger: quiet, metrics }); await omitted.close();
  const runtime = await startWorkerMetrics({ environment: { METRICS_PORT: "0" }, logger: quiet, metrics });
  try {
    assert.ok((await scrapeMetrics(`http://127.0.0.1:${runtime.server.address().port}`)).includes("cross_chain_messages_observed_total"));
    const occupied = await startWorkerMetrics({ environment: { METRICS_PORT: String(runtime.server.address().port) }, logger: quiet, metrics });
    assert.equal(occupied.server.listening, false); await occupied.close();
    await assert.rejects(() => startWorkerMetrics({ environment: { METRICS_HOST: "0.0.0.0", METRICS_PORT: "9090" }, logger: quiet }), /configuration/);
  } finally { await runtime.close(); }
});
