import client from "prom-client";

export const PBFT_BUCKETS = Object.freeze([0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120]);
export const LATENCY_BUCKETS = Object.freeze([0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600]);
export const FAILURE_CLASSES = Object.freeze(["TRANSIENT_RPC_ERROR", "AMBIGUOUS_BROADCAST", "ALREADY_KNOWN", "REPLACEMENT_UNDERPRICED",
  "NONCE_TOO_LOW", "DETERMINISTIC_REJECTION", "RPC_RESPONSE_ERROR", "STALE_FENCE", "RELAYER_RUN_FAILED", "TRANSACTION_MANAGER_FAILED"]);
export const RPC_OPERATIONS = Object.freeze(["eth_chainId", "eth_getBlockByNumber", "eth_blockNumber", "eth_getTransactionCount", "eth_getTransactionReceipt",
  "eth_getTransactionByHash", "eth_sendRawTransaction", "eth_estimateGas", "eth_maxPriorityFeePerGas", "eth_call"]);
export const DEFINITIONS = Object.freeze([
  ["observed", "messages_observed_total", "Counter", "New source occurrences durably inserted as OBSERVED."],
  ["finalized", "messages_finalized_total", "Counter", "Source occurrences durably transitioning to FINALIZED."],
  ["reorged", "messages_reorged_total", "Counter", "Source occurrences durably transitioning to REORGED."],
  ["batches", "batches_created_total", "Counter", "New durable BUILDING batch records."],
  ["round", "pbft_round_duration_seconds", "Histogram", "Local validator PRE-PREPARE acceptance to durable QC or certified abandonment; not global round count.", { outcome: ["committed", "view_change"] }, PBFT_BUCKETS],
  ["views", "pbft_view_changes_total", "Counter", "Certified current-view transitions durably accepted by this validator."],
  ["available", "validator_available", "Gauge", "Local validator production readiness; process death is represented by Prometheus up."],
  ["quorum", "pbft_quorum_failures_total", "Counter", "Local views first entering durable timeout handling without quorum."],
  ["attempts", "delivery_attempts_total", "Counter", "New durable signed transaction candidates, including replacements."],
  ["retries", "delivery_retries_total", "Counter", "Durable replacement creation or actual repeated same-candidate external send.", { kind: ["exact_rebroadcast", "replacement"] }],
  ["relayer", "relayer_failures_total", "Counter", "Failed production Relayer or explicit Transaction Manager actions; passive skips excluded.",
    { operation: ["process_job", "run", "transaction"], reason_class: FAILURE_CLASSES }],
  ["rpc", "rpc_failures_total", "Counter", "Failed endpoint RPC requests, even when another endpoint succeeds.", { operation: RPC_OPERATIONS, reason_class: FAILURE_CLASSES.slice(0, 7) }],
  ["replacements", "transaction_replacements_total", "Counter", "New durable same-nonce replacement candidates."],
  ["latency", "cross_chain_latency_seconds", "Histogram", "Durable source observation to a new canonical production Gateway confirmation; reconfirmation is a new event.", {}, LATENCY_BUCKETS],
  ["execution", "destination_execution_failures_total", "Counter", "New canonical REVERTED destination transaction outcomes."],
]);
const registries = new WeakMap();
const pools = new WeakMap();
const transactions = new WeakMap();
const failureRecorded = Symbol("observation already recorded");
export function createMetrics({ registry = new client.Registry() } = {}) {
  if (registries.has(registry)) return registries.get(registry);
  const instruments = new Map(); const pending = new Set();
  for (const [key, suffix, type, help, labels = {}, buckets] of DEFINITIONS) {
    const metric = new client[type]({ name: `cross_chain_${suffix}`, help, labelNames: Object.keys(labels), registers: [registry], ...(buckets ? { buckets: [...buckets] } : {}) });
    instruments.set(key, { metric, labels, type });
    const combinations = Object.entries(labels).reduce((all, [name, values]) => all.flatMap(value => values.map(entry => ({ ...value, [name]: entry }))), [{}]);
    for (const combination of combinations) {
      if (type === "Histogram") metric.zero(combination);
      else if (type === "Counter") metric.inc(combination, 0);
      else metric.set(combination, 0);
    }
  }
  const metrics = { registry,
    record(key, labels = {}, value = 1) {
      const definition = instruments.get(key);
      if (!definition || !Number.isFinite(value) || value < 0) return;
      const { metric, type, labels: allowed } = definition;
      if (Object.keys(labels).length !== Object.keys(allowed).length || Object.entries(labels).some(([name, entry]) => !allowed[name]?.includes(entry))) return;
      if (type === "Histogram") metric.observe(labels, value);
      else if (type === "Gauge") metric.set(labels, value);
      else metric.inc(labels, value);
    },
    safely(operation) {
      try {
        const result = operation(metrics);
        if (result?.then) {
          const task = Promise.resolve(result).catch(() => {}).finally(() => pending.delete(task));
          pending.add(task);
        }
      } catch { /* Only observation failures are isolated, never protocol errors. */ }
    },
    async settled() { while (pending.size) await Promise.all([...pending]); },
  };
  registries.set(registry, metrics); return metrics;
}
export const processMetrics = createMetrics();
export function metricsFor(pool) { return pools.get(pool) ?? processMetrics; }
export function bindPoolMetrics(pool, metrics) { pools.set(pool, metrics); }
export function recordMetric(metrics, key, labels = {}, value = 1) {
  try { metrics?.record(key, labels, value); } catch { /* Metrics cannot fail protocol work. */ }
}
export function beginMetricEvents(connection, pool) { transactions.set(connection, { metrics: metricsFor(pool), events: [] }); }
export function afterMetricCommit(connection, operation) { transactions.get(connection)?.events.push(operation); }
export function finishMetricEvents(connection, committed) {
  const state = transactions.get(connection); transactions.delete(connection);
  if (committed && state) for (const operation of state.events) {
    try { state.metrics.safely(operation); } catch { /* Injectable observation sink may be unavailable. */ }
  }
}
export function secondsBetween(start, end) {
  if (start == null || end == null) return null;
  const seconds = (new Date(end).getTime() - new Date(start).getTime()) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
}
export function relayerFailure(metrics, error, operation) {
  if (error?.[failureRecorded]) return;
  const reason = FAILURE_CLASSES.includes(error?.errorClass) ? error.errorClass : FAILURE_CLASSES.includes(error?.code) ? error.code :
    operation === "transaction" ? "TRANSACTION_MANAGER_FAILED" : "RELAYER_RUN_FAILED";
  recordMetric(metrics, "relayer", { operation, reason_class: reason });
  if (error && Object.isExtensible(error)) error[failureRecorded] = true;
}
