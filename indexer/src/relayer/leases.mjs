import { randomUUID } from "node:crypto";
import { tableName, normalizeSourceScope } from "../db.mjs";
import { deliveryTransaction } from "../delivery/repository.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { RelayerError, normalizeWorkerId } from "./config.mjs";

export const MAX_FENCING_TOKEN = 9223372036854775807n;
export function normalizeLeaseFence(fence,id) {
  if (!fence || fence.deliveryJobId !== id || typeof fence.fencingToken !== "string" ||
      !/^[1-9][0-9]*$/.test(fence.fencingToken) || BigInt(fence.fencingToken) > MAX_FENCING_TOKEN ||
      typeof fence.ownerSessionId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(fence.ownerSessionId)) throw new RelayerError("INVALID_LEASE_FENCE");
  normalizeWorkerId(fence.ownerId);
  return fence;
}
function record(row) {
  return Object.freeze({ deliveryJobId: row.delivery_job_id,ownerId: row.owner_id,ownerSessionId: row.owner_session_id,
    fencingToken: row.fencing_token,leaseAcquiredAt: row.lease_acquired_at.toISOString(),
    leaseExpiresAt: row.lease_expires_at.toISOString(),lastRenewedAt: row.last_renewed_at.toISOString(),
    releasedAt: row.released_at?.toISOString() ?? null,createdAt: row.created_at.toISOString(),updatedAt: row.updated_at.toISOString() });
}

// Call after taking the account/intent locks, in the SAME mutation transaction.
// Retaining this row lock until COMMIT prevents T+1 from being issued in flight.
export async function assertLeaseFence(client,config,id,fence) {
  normalizeLeaseFence(fence,id);
  const leases = tableName(config.databaseSchema,"relayer_job_leases");
  await client.query(`SELECT delivery_job_id FROM ${leases} WHERE delivery_job_id = $1 FOR UPDATE`,[id]);
  const valid = await client.query(`SELECT 1 FROM ${leases} WHERE delivery_job_id = $1 AND owner_id = $2
    AND owner_session_id = $3 AND fencing_token = $4 AND released_at IS NULL AND lease_expires_at > clock_timestamp()`,
    [id,fence.ownerId,fence.ownerSessionId,fence.fencingToken]);
  if (!valid.rowCount) throw new RelayerError("STALE_FENCE");
}

export function createRelayerLeaseRepository({ config,pool,queue }) {
  const leases = tableName(config.databaseSchema,"relayer_job_leases");
  const workers = tableName(config.databaseSchema,"relayer_worker_ids");
  const jobs = tableName(config.databaseSchema,"delivery_jobs");
  const batches = tableName(config.databaseSchema,"delivery_batches");
  const intents = tableName(config.databaseSchema,"transaction_intents");
  const attempts = tableName(config.databaseSchema,"transaction_attempts");
  const events = tableName(config.databaseSchema,"transaction_broadcast_events");
  const submissions = tableName(config.databaseSchema,"relayer_submissions");
  const scope = normalizeSourceScope(config);
  const destinationDomain = config.destinationDomain.toString();
  const eligible = `b.source_domain = $1 AND b.source_gateway = $2 AND j.destination_domain = $3 AND j.status = 'READY'
    AND NOT EXISTS (SELECT 1 FROM ${submissions} s WHERE s.delivery_job_id = j.delivery_job_id)
    AND NOT EXISTS (SELECT 1 FROM ${intents} i WHERE i.delivery_job_id = j.delivery_job_id
      AND (i.status <> 'PENDING' OR i.retry_stopped_at IS NOT NULL))`;

  return {
    async withWorker(operation) {
      const workerId = normalizeWorkerId(config.workerId);
      const client = await pool.connect();
      let key; let acquired = false; let lost = false; let ended = false;
      const onError = () => { lost = true; };
      client.on("error",onError);
      try {
        await client.query(`INSERT INTO ${workers} (worker_id) VALUES ($1) ON CONFLICT DO NOTHING`,[workerId]);
        // Database-assigned IDs avoid hashing URLs or worker names. The relation
        // OID scopes the lock to this schema, including parallel test schemas.
        key = (await client.query(`SELECT ((tableoid::bigint << 32) | lock_id::bigint)::text AS key FROM ${workers} WHERE worker_id = $1`,[workerId])).rows[0].key;
        acquired = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[key])).rows[0].acquired;
        if (!acquired) throw new RelayerError("RELAYER_WORKER_ALREADY_RUNNING");
        const session = Object.freeze({ workerId,sessionId: randomUUID(),assertHeld() {
          if (lost || ended) throw new RelayerError("RELAYER_SESSION_LOST");
        } });
        return await operation(session);
      } finally {
        ended = true;
        try { if (acquired && !lost) await client.query("SELECT pg_advisory_unlock($1::bigint)",[key]); }
        finally { client.removeListener("error",onError); client.release(lost ? new Error("worker session connection lost") : undefined); }
      }
    },
    async listClaimableJobs({ limit = config.maxJobs,session } = {}) {
      deliveryLimit(limit); session.assertHeld();
      const rows = (await pool.query(`SELECT j.delivery_job_id FROM ${jobs} j JOIN ${batches} b USING (batch_record_id)
        LEFT JOIN ${leases} l ON l.delivery_job_id = j.delivery_job_id
        WHERE ${eligible} AND (l.delivery_job_id IS NULL OR l.lease_expires_at <= clock_timestamp()
          OR (l.owner_id = $4 AND l.owner_session_id = $5))
        AND (NOT EXISTS (SELECT 1 FROM ${intents} i WHERE i.delivery_job_id = j.delivery_job_id)
          OR EXISTS (SELECT 1 FROM ${intents} i WHERE i.delivery_job_id = j.delivery_job_id AND
            (i.next_action_at <= clock_timestamp() OR EXISTS (SELECT 1 FROM ${attempts} a
              WHERE a.delivery_job_id = i.delivery_job_id AND a.status = 'SIGNED' AND a.broadcast_attempt_count = 0
                AND a.attempt_number = (SELECT MAX(attempt_number) FROM ${attempts} WHERE delivery_job_id = i.delivery_job_id))
              OR EXISTS (SELECT 1 FROM ${events} e JOIN ${attempts} a USING (attempt_id)
                WHERE a.delivery_job_id = i.delivery_job_id AND e.completed_at IS NULL))))
        ORDER BY b.batch_epoch,j.message_index,j.delivery_job_id LIMIT $6`,
        [scope.chainDomain,scope.sourceGateway,destinationDomain,session.workerId,session.sessionId,limit])).rows;
      return Object.freeze(await Promise.all(rows.map(row => queue.getDeliveryJob(row.delivery_job_id))));
    },
    async tryAcquireLease(id,session) {
      session.assertHeld(); normalizeWorkerId(session.workerId);
      return deliveryTransaction(pool,async client => {
        if (!(await client.query(`SELECT j.delivery_job_id FROM ${jobs} j JOIN ${batches} b USING (batch_record_id)
          WHERE ${eligible} AND j.delivery_job_id = $4`,[scope.chainDomain,scope.sourceGateway,destinationDomain,id])).rowCount) return null;
        const inserted = await client.query(`INSERT INTO ${leases}
          (delivery_job_id,owner_id,owner_session_id,fencing_token,lease_acquired_at,lease_expires_at,last_renewed_at)
          SELECT $1,$2,$3,1,t,t + $4::bigint * interval '1 millisecond',t FROM (SELECT clock_timestamp() AS t) n
          ON CONFLICT (delivery_job_id) DO NOTHING RETURNING *`,[id,session.workerId,session.sessionId,config.leaseMs]);
        if (inserted.rowCount) return record(inserted.rows[0]);
        const row = (await client.query(`SELECT * FROM ${leases} WHERE delivery_job_id = $1 FOR UPDATE`,[id])).rows[0];
        const active = (await client.query(`SELECT lease_expires_at > clock_timestamp() AS active FROM ${leases} WHERE delivery_job_id = $1`,[id])).rows[0].active;
        if (active) return row.owner_id === session.workerId && row.owner_session_id === session.sessionId ? record(row) : null;
        if (BigInt(row.fencing_token) === MAX_FENCING_TOKEN) throw new RelayerError("FENCING_TOKEN_EXHAUSTED");
        const updated = await client.query(`UPDATE ${leases} SET owner_id = $2,owner_session_id = $3,fencing_token = fencing_token + 1,
          lease_acquired_at = n.t,lease_expires_at = n.t + $4::bigint * interval '1 millisecond',last_renewed_at = n.t,
          released_at = NULL,updated_at = n.t FROM (SELECT clock_timestamp() AS t) n WHERE delivery_job_id = $1 RETURNING ${leases}.*`,
          [id,session.workerId,session.sessionId,config.leaseMs]);
        return record(updated.rows[0]);
      });
    },
    async renewLease(fence) {
      return deliveryTransaction(pool,async client => {
        await assertLeaseFence(client,config,fence.deliveryJobId,fence);
        const result = await client.query(`UPDATE ${leases} SET lease_expires_at = n.t + $2::bigint * interval '1 millisecond',
          last_renewed_at = n.t,updated_at = n.t FROM (SELECT clock_timestamp() AS t) n WHERE delivery_job_id = $1 RETURNING ${leases}.*`,
          [fence.deliveryJobId,config.leaseMs]);
        return record(result.rows[0]);
      });
    },
    async releaseLease(fence) {
      normalizeLeaseFence(fence,fence?.deliveryJobId);
      return deliveryTransaction(pool,async client => {
        const row = (await client.query(`SELECT * FROM ${leases} WHERE delivery_job_id = $1 FOR UPDATE`,[fence.deliveryJobId])).rows[0];
        if (!row || row.owner_id !== fence.ownerId || row.owner_session_id !== fence.ownerSessionId || row.fencing_token !== fence.fencingToken) throw new RelayerError("STALE_FENCE");
        if (row.released_at !== null) return record(row);
        await assertLeaseFence(client,config,fence.deliveryJobId,fence);
        return record((await client.query(`UPDATE ${leases} SET lease_expires_at = n.t,released_at = n.t,updated_at = n.t
          FROM (SELECT clock_timestamp() AS t) n WHERE delivery_job_id = $1 RETURNING ${leases}.*`,[fence.deliveryJobId])).rows[0]);
      });
    },
    async getLease(id) {
      const row = (await pool.query(`SELECT * FROM ${leases} WHERE delivery_job_id = $1`,[id])).rows[0];
      return row ? record(row) : null;
    },
  };
}
