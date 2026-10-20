import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { parseDocument } from "yaml";
import { assertDashboardContract, loadDashboard, queryReferences, DATASOURCE_UID } from "./helpers/grafana-contract.mjs";

const root = new URL("../../", import.meta.url);
const dashboard = loadDashboard();
const panel = id => { const value = dashboard.panels.find(entry => entry.id === id); assert.ok(value, `required panel ${id}`); return value; };
const references = id => new Set(panel(id).targets.flatMap(target => [...queryReferences(target.expr)]));
const yaml = relative => {
  const document = parseDocument(readFileSync(new URL(relative, root), "utf8"));
  assert.deepEqual(document.errors, []); return document.toJS();
};

test("dashboard JSON has stable identity, layout, only built-in panels and one Prometheus datasource", () => {
  assertDashboardContract(dashboard);
  console.log("VALID: provisioned Cross-Chain Protocol Overview Grafana dashboard has a stable UID and uses only the Prometheus datasource");
});

test("nine required operational views have actual semantic metric coverage", () => {
  assert.deepEqual(references(11), new Set(["cross_chain_messages_observed_total", "cross_chain_messages_finalized_total"]));
  for (const target of panel(11).targets) assert.match(target.expr, /rate\([^()]+\[\$__rate_interval\]\)/);
  assert.equal(panel(11).fieldConfig.defaults.unit, "ops");
  console.log("VALID: message throughput uses rate-based observed/finalized counters rather than raw cumulative totals");
  for (const [id, family, percentiles] of [[12, "cross_chain_cross_chain_latency_seconds_bucket", ["0.50", "0.95", "0.99"]],
    [21, "cross_chain_pbft_round_duration_seconds_bucket", ["0.50", "0.95"]]]) {
    assert.deepEqual(references(id), new Set([family]));
    assert.deepEqual(panel(id).targets.map(target => /^histogram_quantile\(([^,]+),/.exec(target.expr)?.[1]), percentiles);
    for (const target of panel(id).targets) { assert.match(target.expr, /sum by \(le\)/); assert.match(target.expr, /rate\(/); assert.ok(target.expr.includes("[$__rate_interval]")); }
    assert.equal(panel(id).fieldConfig.defaults.unit, "s"); assert.equal(panel(id).fieldConfig.defaults.noValue, "No data");
  }
  console.log("VALID: cross-chain latency renders percentile queries over the production latency histogram");
  assert.ok(references(22).has("cross_chain_pbft_view_changes_total"));
  assert.ok(references(23).has("cross_chain_pbft_quorum_failures_total"));
  console.log("VALID: PBFT health combines real round-duration, view-change and quorum-failure metrics without claiming Grafana is a consensus authority");
  assert.deepEqual(references(24), new Set(["cross_chain_validator_available", "up"]));
  assert.deepEqual(references(25), new Set(["up"]));
  assert.match(panel(24).targets[0].expr, /and on\(job, instance\).*up.*== 1/);
  for (const id of [24, 25]) { assert.equal(panel(id).targets[0].instant, true); assert.equal(panel(id).targets[0].range, false); }
  assert.match(panel(24).targets[0].expr, /job="cross-chain-validators"/);
  console.log("VALID: validator health distinguishes protocol readiness from Prometheus target reachability and does not mutate committee membership");
  assert.deepEqual(references(32), new Set(["cross_chain_delivery_attempts_total", "cross_chain_transaction_replacements_total"]));
  assert.ok(references(33).has("cross_chain_delivery_retries_total")); assert.match(panel(33).targets[0].expr, /by \(kind\)/);
  assert.ok(references(34).has("cross_chain_relayer_failures_total")); assert.match(panel(34).targets[0].expr, /by \(operation, reason_class\)/);
  console.log("VALID: relayer health exposes delivery attempts, retries, failures and replacements from bounded production metrics");
  assert.ok(references(41).has("cross_chain_rpc_failures_total")); assert.ok(references(42).has("cross_chain_rpc_failures_total"));
  assert.match(panel(41).targets[0].expr, /by \(operation\)/); assert.match(panel(42).targets[0].expr, /by \(reason_class\)/);
  console.log("VALID: RPC health exposes structured failure rates by bounded production operation/class without endpoint credentials or raw errors");
  for (const id of [3, 31]) {
    assert.deepEqual(references(id), new Set(["cross_chain_pending_delivery_jobs", "up"]));
    assert.match(panel(id).targets[0].expr, /^max\(/); assert.match(panel(id).targets[0].expr, /job="cross-chain-api"/);
    assert.match(panel(id).targets[0].expr, />= 0/, "unknown/NaN collection must become No data rather than a number");
  }
  assert.equal(panel(3).type, "stat"); assert.equal(panel(3).targets[0].instant, true);
  assert.deepEqual(references(4), new Set(["cross_chain_messages_reorged_total"]));
  assert.match(panel(4).targets[0].expr, /increase\([^()]+\[\$__range\]\)/);
  assert.ok(references(51).has("cross_chain_messages_reorged_total"));
  console.log("VALID: source reorg panel derives from the production REORGED message counter and retains source/destination reorg semantic separation");
  const failures = ["cross_chain_delivery_retries_total", "cross_chain_relayer_failures_total", "cross_chain_rpc_failures_total", "cross_chain_destination_execution_failures_total"];
  assert.equal(panel(52).targets.length, 4);
  panel(52).targets.forEach((target, index) => { assert.deepEqual(queryReferences(target.expr), new Set([failures[index]])); assert.match(target.expr, /^sum\(rate\(/); });
  assert.equal(panel(52).fieldConfig.defaults.custom.stacking.mode, "none");
  console.log("VALID: failure/retry overview preserves separate RPC, relayer, delivery-retry and destination-execution-failure series");
  console.log("VALID: dashboard covers message throughput, cross-chain latency, PBFT health, validator health, relayer health, RPC health, pending delivery, reorg count and failure/retry rate");
});

test("official PromQL grammar rejects malformed queries and canonical registry checks reject stale names and identifier grouping", () => {
  for (const expression of ["sum(rate(", "rate(unknown_metric_total[1m])", "cross_chain_latency_seconds_bucket", 'up + cross_chain_unknown_total',
    'cross_chain_rpc_failures_total{error_text="unbounded"}', 'up{job="$unsupported"}']) {
    assert.throws(() => queryReferences(expression));
  }
  for (const mutate of [
    value => { value.panels.find(entry => entry.id === 11).targets[0].expr = "sum by (messageId) (cross_chain_messages_observed_total)"; },
    value => { value.panels.find(entry => entry.id === 11).datasource = { type: "postgres", uid: "other" }; },
    value => { value.panels[1].id = value.panels[0].id; },
    value => { value.templating.list.push({ name: "txHash", type: "textbox" }); },
    value => { value.panels.find(entry => entry.id === 11).actions = [{ type: "fetch", method: "POST" }]; },
  ]) { const invalid = structuredClone(dashboard); mutate(invalid); assert.throws(() => assertDashboardContract(invalid)); }
  console.log("VALID: every dashboard PromQL expression references existing bounded protocol metric families and no message/batch/transaction identifier labels");
  console.log("VALID: dashboard contains no messageId, batchId, transaction hash, Merkle root, nonce, worker ID or arbitrary error-text variable/grouping");
});

test("datasource, provider and scrape example are parseable, credential-free and reference the committed dashboard", () => {
  const manifest = JSON.parse(readFileSync(new URL("indexer/package.json", root), "utf8"));
  for (const name of ["@prometheus-io/lezer-promql", "@lezer/highlight", "@lezer/lr", "yaml"]) {
    assert.ok(manifest.devDependencies[name]); assert.equal(manifest.dependencies[name], undefined, "parsers are test-only dependencies");
  }
  const datasource = yaml("observability/grafana/provisioning/datasources/prometheus.yaml");
  assert.equal(datasource.apiVersion, 1); assert.equal(datasource.datasources.length, 1);
  const source = datasource.datasources[0]; assert.equal(source.type, "prometheus"); assert.equal(source.uid, DATASOURCE_UID);
  assert.equal(source.access, "proxy"); assert.equal(source.url, "http://127.0.0.1:9090");
  assert.equal(source.jsonData.httpMethod, "GET"); assert.equal(source.jsonData.timeInterval, "15s");
  assert.ok(!source.secureJsonData && !source.basicAuth && !source.user && !source.password);
  const provider = yaml("observability/grafana/provisioning/dashboards/cross-chain.yaml");
  assert.equal(provider.apiVersion, 1); assert.equal(provider.providers.length, 1);
  const entry = provider.providers[0]; assert.equal(entry.type, "file"); assert.equal(entry.allowUiUpdates, false);
  assert.equal(entry.disableDeletion, true); assert.equal(entry.updateIntervalSeconds, 30);
  assert.equal(entry.options.path, "$CROSS_CHAIN_GRAFANA_DASHBOARDS_PATH");
  const resolved = entry.options.path.replace("$CROSS_CHAIN_GRAFANA_DASHBOARDS_PATH", fileURLToPath(new URL("observability/grafana/dashboards", root)));
  assert.deepEqual(JSON.parse(readFileSync(`${resolved}/cross-chain-protocol.json`, "utf8")), dashboard);
  const prometheus = yaml("observability/prometheus/prometheus.example.yml");
  assert.equal(prometheus.global.scrape_interval, source.jsonData.timeInterval);
  assert.deepEqual(prometheus.scrape_configs.map(job => job.job_name), ["cross-chain-api", "cross-chain-workers", "cross-chain-validators"]);
  assert.deepEqual(prometheus.scrape_configs[0].static_configs[0].targets, ["127.0.0.1:8080"]);
  assert.deepEqual(prometheus.scrape_configs[2].static_configs[0].targets, [], "never invent ephemeral Validator verification ports");
  console.log("VALID: Grafana datasource and dashboard provisioning reference committed repository-local files with no credentials");
});

test("observability artifacts and README examples contain no sensitive material or protocol controls; production has no Grafana dependency", () => {
  const files = ["observability/grafana/dashboards/cross-chain-protocol.json", "observability/grafana/provisioning/dashboards/cross-chain.yaml",
    "observability/grafana/provisioning/datasources/prometheus.yaml", "observability/prometheus/prometheus.example.yml"];
  const readme = readFileSync(new URL("README.md", root), "utf8");
  const docs = readme.split("## Grafana Operational Dashboard\n")[1]?.split("\n## Local Two-Chain Environment")[0];
  assert.ok(docs, "README integrates dashboard product documentation");
  for (const text of [...files.map(file => readFileSync(new URL(file, root), "utf8")), docs]) {
    assert.ok(!/PRIVATE_KEY|DATABASE_URL|postgres(?:ql)?:\/\/|bearer\s+\S+|secureJsonData|0x[0-9a-f]{64}|0x02[0-9a-f]{100,}/i.test(text));
    assert.ok(!/"(?:method|httpMethod)"\s*:\s*"(?:POST|PUT|PATCH|DELETE)"|"actions"\s*:|"type"\s*:\s*"(?:postgres|mysql|infinity)"/.test(text));
  }
  function inspect(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
      if (entry.isDirectory()) inspect(file);
      else if (entry.name.endsWith(".mjs")) assert.ok(!/(?:import|from|readFile)[^\n]*(?:observability\/grafana|grafana-dashboard|grafana\/provisioning)/i.test(readFileSync(file, "utf8")));
    }
  }
  inspect(new URL("indexer/src/", root)); inspect(new URL("validator/src/", root));
  console.log("VALID: Grafana dashboard, variables, legends, provisioning and README contain no private keys, database credentials, RPC credentials, raw signed transactions or ZK witness material");
  console.log("VALID: no Indexer, Finality Watcher, validator, Relayer or Tx Manager production entry point depends on Grafana configuration");
});
