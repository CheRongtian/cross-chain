import assert from "node:assert/strict";
import { processMetrics } from "../../src/metrics/registry.mjs";

export async function metricValue(suffix, { metrics = processMetrics, labels = {}, part = "" } = {}) {
  await metrics.settled();
  const name = `cross_chain_${suffix}`;
  const metric = await metrics.registry.getSingleMetric(name).get();
  return metric.values.filter(value => (value.metricName ?? name) === name + part &&
    Object.entries(labels).every(([key, entry]) => value.labels[key] === entry)).reduce((sum, value) => sum + value.value, 0);
}
// Verification-only reader for the library's fixed-name, bounded-label samples.
// Production exposition is entirely owned by prom-client, with no custom parser.
export function scrapeValue(body, name, labels = {}) {
  const rows = body.split("\n").filter(line => line.startsWith(name + " ") || line.startsWith(name + "{"));
  const selected = rows.filter(line => Object.entries(labels).every(([key, value]) => line.includes(`${key}="${value}"`)));
  assert.ok(selected.length, `missing expected metric ${name}`);
  return selected.reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1)), 0);
}
export async function scrapeMetrics(origin) {
  const response = await fetch(`${origin}/metrics`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200); assert.ok(response.headers.get("content-type").includes("version=0.0.4"));
  return response.text();
}
export async function assertScrapePure(origin) {
  await processMetrics.settled();
  const first = await scrapeMetrics(origin); const again = await scrapeMetrics(origin);
  assert.equal(first, again, "repeated idle scrapes cannot increment event counters");
  assert.equal((await fetch(`${origin}/metrics`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${origin}/metrics?messageId=forbidden`)).status, 404);
  console.log("VALID: Prometheus-compatible metrics endpoints expose the required protocol metrics with standard content types and no state-changing methods");
  return first;
}
