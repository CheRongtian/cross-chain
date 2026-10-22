import { tableName } from "../../src/db.mjs";

// Count every journal row, including unresolved logical/endpoint markers.
// Delivery identity belongs to the attempt, not to the broadcast event.
export async function countDeliveryBroadcastEvents(pool,schema,deliveryJobId) {
  const events = tableName(schema,"transaction_broadcast_events");
  const attempts = tableName(schema,"transaction_attempts");
  return (await pool.query(`SELECT COUNT(*)::int AS count FROM ${events} e
    JOIN ${attempts} a ON a.attempt_id = e.attempt_id
    WHERE a.delivery_job_id = $1`,[deliveryJobId])).rows[0].count;
}

export async function readSourceTransactionCounts(pool,schema,{ sourceMessageId,messageId }) {
  const t = name => tableName(schema,name);
  return (await pool.query(`WITH target_jobs AS (
      SELECT delivery_job_id FROM ${t("delivery_jobs")}
      WHERE source_message_id = $1 OR message_id = $2
    ) SELECT
      (SELECT COUNT(*) FROM ${t("transaction_intents")} i
        JOIN target_jobs j ON j.delivery_job_id = i.delivery_job_id)::int AS intents,
      (SELECT COUNT(*) FROM ${t("transaction_attempts")} a
        JOIN target_jobs j ON j.delivery_job_id = a.delivery_job_id)::int AS attempts,
      (SELECT COUNT(*) FROM ${t("transaction_broadcast_events")} e
        JOIN ${t("transaction_attempts")} a ON a.attempt_id = e.attempt_id
        JOIN target_jobs j ON j.delivery_job_id = a.delivery_job_id)::int AS broadcasts`,
  [sourceMessageId,messageId])).rows[0];
}
