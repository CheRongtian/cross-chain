import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { tableName } from "../../src/db.mjs";
import { registerPendingDelivery, PENDING_DELIVERY_NAME } from "../../src/metrics/pending-delivery.mjs";
import { createMessageQueryServer } from "../../src/api/server.mjs";
import { assertScrapePure, scrapeMetrics, scrapeValue } from "./metrics-assertions.mjs";
import { assertDashboardExposition } from "./grafana-contract.mjs";

// Verification-only snapshots around the existing real E2E receipt pass.
// No new source message, worker, consensus network or fault is created here.
export async function withPendingDashboardProbe({ config, pool, resolvedCount, captureDestination, validatorOrigins }, operation) {
  const metric = registerPendingDelivery({ config, pool });
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {} });
  async function capture() {
    const state = {};
    for (const name of ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batches", "message_batch_members",
      "batch_quorum_certificates", "batch_quorum_certificate_signatures", "delivery_batches", "delivery_jobs", "relayer_submissions",
      "relayer_job_leases", "transaction_accounts", "transaction_intents", "transaction_attempts", "transaction_broadcast_events",
      "transaction_receipt_observations", "transaction_receipt_orphans"]) {
      state[name] = (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
    }
    state.destination = await captureDestination(); return state;
  }
  try {
    await runtime.listen(); const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    const beforeState = await capture();
    const body = await assertScrapePure(origin);
    const before = scrapeValue(body, PENDING_DELIVERY_NAME);
    assert.ok(before >= resolvedCount, "the existing real E2E must have unresolved READY jobs");
    assert.ok(isDeepStrictEqual(await capture(), beforeState), "pending scrapes cannot change any protocol or business state");
    const result = await operation();
    const afterState = await capture();
    const afterBody = await assertScrapePure(origin);
    assert.equal(scrapeValue(afterBody, PENDING_DELIVERY_NAME), before - resolvedCount, "canonical terminal outcomes reduce unresolved work exactly once");
    assert.ok(isDeepStrictEqual(await capture(), afterState), "post-confirmation scrapes cannot acquire leases, nonces or transaction state");
    const validatorBodies = await Promise.all(validatorOrigins.map(scrapeMetrics));
    for (const body of validatorBodies) assert.equal(scrapeValue(body, "cross_chain_validator_available"), 1);
    assert.ok(validatorBodies.some(body => scrapeValue(body, "cross_chain_pbft_round_duration_seconds_count", { outcome: "committed" }) > 0));
    assertDashboardExposition([afterBody, ...validatorBodies]);
    assert.ok(scrapeValue(afterBody, "cross_chain_messages_observed_total") > 0);
    assert.ok(scrapeValue(afterBody, "cross_chain_messages_finalized_total") > 0);
    assert.ok(scrapeValue(afterBody, "cross_chain_cross_chain_latency_seconds_count") > 0);
    assert.ok(scrapeValue(afterBody, "cross_chain_destination_execution_failures_total") > 0);
    console.log("VALID: read-only pending-delivery collector reflects real unresolved READY work and repeated scrapes acquire no lease or transaction state");
    console.log("VALID: dashboard throughput/latency families contain real source and canonical Gateway execution observations, with pending work decreasing after confirmation");
    return result;
  } finally { try { await runtime.close(); } finally { metric.close(); } }
}
