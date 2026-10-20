import client from "prom-client";
import { normalizeSourceScope, tableName } from "../db.mjs";
import { processMetrics } from "./registry.mjs";

export const PENDING_DELIVERY_NAME = "cross_chain_pending_delivery_jobs";
const owners = new WeakMap();

// One observational API owner per registry/source scope. Workers never import
// dashboard artifacts or use this count for selection, retry or authorization.
export function registerPendingDelivery({ config, pool, metrics = processMetrics }) {
  const registry = metrics.registry;
  if (owners.has(registry)) throw new Error("Pending-delivery collector already has an owner");
  const scope = normalizeSourceScope(config);
  const jobs = tableName(config.databaseSchema, "delivery_jobs");
  const batches = tableName(config.databaseSchema, "delivery_batches");
  const sources = tableName(config.databaseSchema, "source_messages");
  const intents = tableName(config.databaseSchema, "transaction_intents");
  const sql = `SELECT COUNT(*)::text AS pending FROM ${jobs} j
    JOIN ${batches} b USING (batch_record_id)
    JOIN ${sources} s ON s.id = j.source_message_id
    WHERE b.source_domain = $1 AND b.source_gateway = $2
      AND j.status = 'READY' AND s.status = 'FINALIZED'
      AND NOT EXISTS (SELECT 1 FROM ${intents} i WHERE i.delivery_job_id = j.delivery_job_id
        AND i.status IN ('CONFIRMED','REVERTED'))`;
  const gauge = new client.Gauge({ name: PENDING_DELIVERY_NAME,
    help: "Persisted canonical READY source-scope jobs without a CONFIRMED or REVERTED intent; includes deferred, stopped and historical unconfirmed work.",
    registers: [registry],
    async collect() {
      try {
        // A single SELECT has its own consistent MVCC snapshot. No protocol
        // repository, stateful getter, explicit transaction or lock is invoked.
        const result = await pool.query({ text: sql, values: [scope.chainDomain, scope.sourceGateway], query_timeout: 5000 });
        const text = result.rows[0]?.pending;
        const count = Number(text);
        if (!/^(0|[1-9][0-9]*)$/.test(text ?? "") || !Number.isSafeInteger(count)) throw new Error("Invalid pending observation");
        this.set(count);
      } catch {
        // Unknown must not look like zero backlog or retain a stale success.
        // Failure of this one observation leaves all existing metric families usable.
        this.set(NaN);
      }
    },
  });
  gauge.set(NaN);
  const owner = { close() {
    if (owners.get(registry) !== owner) return;
    owners.delete(registry); registry.removeSingleMetric(PENDING_DELIVERY_NAME);
  } };
  owners.set(registry, owner);
  return owner;
}
