import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parser } from "@prometheus-io/lezer-promql";
import { DEFINITIONS } from "../../src/metrics/registry.mjs";
import { PENDING_DELIVERY_NAME } from "../../src/metrics/pending-delivery.mjs";

export const DASHBOARD_URL = new URL("../../../observability/grafana/dashboards/cross-chain-protocol.json", import.meta.url);
export const DATASOURCE_UID = "cross-chain-prometheus";
export const loadDashboard = () => JSON.parse(readFileSync(DASHBOARD_URL, "utf8"));
export const metricFamilies = new Map(DEFINITIONS.map(([, suffix, type]) => [`cross_chain_${suffix}`, type.toLowerCase()]));
metricFamilies.set(PENDING_DELIVERY_NAME, "gauge");
const seriesFamilies = new Map([...metricFamilies].flatMap(([name, type]) => type === "histogram" ?
  ["_bucket", "_sum", "_count"].map(suffix => [name + suffix, name]) : [[name, name]]));
const labelNames = new Set(["job", "instance", "le", ...DEFINITIONS.flatMap(([, , , , labels = {}]) => Object.keys(labels))]);

// Test-only: the Prometheus project's parser validates syntax after Grafana
// substitutes duration macros. No home-grown PromQL parser or query service.
export function queryReferences(expression) {
  assert.equal(typeof expression, "string");
  const source = expression.replaceAll("$__rate_interval", "1m").replaceAll("$__range", "1h");
  assert.ok(!source.includes("$"), "unresolved dashboard variable");
  const references = new Set();
  parser.parse(source).iterate({ enter(node) {
    assert.equal(node.type.isError, false, `invalid PromQL at ${node.from}: ${expression}`);
    if (node.name === "LabelName") assert.ok(labelNames.has(source.slice(node.from, node.to)), "unknown or unbounded label");
    if (node.name === "VectorSelector") {
      const identifier = node.node.getChild("Identifier");
      assert.ok(identifier, "dashboard selectors must name one canonical metric explicitly");
      const name = source.slice(identifier.from, identifier.to);
      assert.ok(name === "up" || seriesFamilies.has(name), `unknown metric series ${name}`);
      references.add(name);
    }
  } });
  assert.ok(references.size, "query must reference a real metric");
  return references;
}

export function assertDashboardContract(dashboard = loadDashboard()) {
  assert.equal(dashboard.id, null); assert.equal(dashboard.uid, "cross-chain-protocol");
  assert.equal(dashboard.title, "Cross-Chain Protocol Overview"); assert.equal(dashboard.version, 1);
  assert.equal(dashboard.schemaVersion, 39); assert.equal(dashboard.editable, false);
  assert.deepEqual(dashboard.templating.list, []); assert.deepEqual(dashboard.links, []);
  assert.equal(dashboard.refresh, "15s"); assert.deepEqual(dashboard.time, { from: "now-1h", to: "now" });
  const ids = new Set(); const references = new Set();
  for (const panel of dashboard.panels) {
    assert.ok(Number.isInteger(panel.id) && !ids.has(panel.id), "unique deterministic panel IDs"); ids.add(panel.id);
    assert.ok(["row", "stat", "timeseries"].includes(panel.type), "built-in panels only");
    assert.ok(panel.gridPos.x >= 0 && panel.gridPos.w > 0 && panel.gridPos.x + panel.gridPos.w <= 24);
    if (panel.type === "row") continue;
    assert.ok(panel.description); assert.deepEqual(panel.datasource, { type: "prometheus", uid: DATASOURCE_UID });
    assert.ok(!panel.links?.length && !panel.actions?.length && !panel.fieldConfig.defaults.links?.length, "no action or data links");
    const refs = new Set();
    for (const target of panel.targets) {
      assert.ok(!refs.has(target.refId)); refs.add(target.refId);
      if (target.datasource) assert.deepEqual(target.datasource, panel.datasource);
      for (const name of queryReferences(target.expr)) references.add(name);
      assert.ok(!/message.?id|batch.?id|tx.?hash|transaction.?hash|root|signature|nonce|worker.?id|error_message|stack|https?:/i.test(target.expr + (target.legendFormat ?? "")), "no identifiers, URLs or raw errors in queries/legends");
      const withoutStrings = target.expr.replace(/"(?:[^"\\]|\\.)*"/g, '""');
      for (const match of withoutStrings.matchAll(/\b(?:by|on|ignoring|without)\s*\(([^)]*)\)/g)) {
        assert.ok(match[1].split(",").every(label => ["job", "instance", "le", "outcome", "kind", "operation", "reason_class"].includes(label.trim())));
      }
      assert.ok(!/\bor\s+vector\s*\(\s*0\s*\)/.test(target.expr), "no fabricated zero on missing data");
    }
  }
  return references;
}

export function assertDashboardExposition(bodies, dashboard = loadDashboard()) {
  const references = assertDashboardContract(dashboard);
  const text = Array.isArray(bodies) ? bodies.join("\n") : bodies;
  for (const name of references) {
    if (name === "up") continue; // Prometheus generates up, endpoint libraries do not.
    const family = seriesFamilies.get(name);
    assert.ok(text.includes(`# TYPE ${family} ${metricFamilies.get(family)}\n`), `missing real family ${family}`);
    assert.ok(new RegExp(`^${name}(?:\\{| )`, "m").test(text), `missing real sample ${name}`);
  }
  console.log("VALID: all dashboard-referenced protocol metric families are present in real Prometheus exposition during full verification");
}
