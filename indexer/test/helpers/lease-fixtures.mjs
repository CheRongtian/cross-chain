import { randomUUID } from "node:crypto";
import { normalizeLeaseFence, MAX_FENCING_TOKEN } from "../../src/relayer/leases.mjs";
import { RelayerError } from "../../src/relayer/config.mjs";

// Deterministic unit fixture. Database tests separately exercise real SQL locks.
export function memoryLeaseFixture(h) {
  const rows = new Map(); const workers = new Set();
  const time = () => new Date(h.clock.now()).toISOString();
  const snapshot = row => Object.freeze({ ...row });
  function assertFence(id,fence) {
    normalizeLeaseFence(fence,id);
    const row = rows.get(id);
    if (!row || row.ownerId !== fence.ownerId || row.ownerSessionId !== fence.ownerSessionId || row.fencingToken !== fence.fencingToken ||
        row.releasedAt !== null || Date.parse(row.leaseExpiresAt) <= h.clock.now()) throw new RelayerError("STALE_FENCE");
  }
  h.repository.assertFence = async (id,fence) => assertFence(id,fence);
  function repository(config = h.config) {
    return {
      async withWorker(operation) {
        if (workers.has(config.workerId)) throw new RelayerError("RELAYER_WORKER_ALREADY_RUNNING");
        workers.add(config.workerId);
        try { return await operation({ workerId: config.workerId,sessionId: randomUUID(),assertHeld() {} }); }
        finally { workers.delete(config.workerId); }
      },
      async listClaimableJobs({ limit,session }) {
        return h.jobs.filter(job => {
          const intent = h.records.get(job.deliveryJobId)?.intent;
          const attempt = h.records.get(job.deliveryJobId)?.attempt;
          const row = rows.get(job.deliveryJobId);
          return !h.historical.has(job.deliveryJobId) && (!intent || (intent.status === "PENDING" && intent.retryStoppedAt === null &&
            (Date.parse(intent.nextActionAt) <= h.clock.now() || (attempt.status === "SIGNED" && attempt.broadcastAttemptCount === "0")))) &&
            (!row || Date.parse(row.leaseExpiresAt) <= h.clock.now() || (row.ownerId === session.workerId && row.ownerSessionId === session.sessionId));
        }).slice(0,limit);
      },
      async tryAcquireLease(id,session) {
        const intent = h.records.get(id)?.intent;
        if (!h.jobs.some(job => job.deliveryJobId === id) || h.historical.has(id) || (intent && (intent.status !== "PENDING" || intent.retryStoppedAt !== null))) return null;
        const old = rows.get(id);
        if (old && Date.parse(old.leaseExpiresAt) > h.clock.now()) return old.ownerId === session.workerId && old.ownerSessionId === session.sessionId ? snapshot(old) : null;
        if (old && BigInt(old.fencingToken) === MAX_FENCING_TOKEN) throw new RelayerError("FENCING_TOKEN_EXHAUSTED");
        const row = { deliveryJobId: id,ownerId: session.workerId,ownerSessionId: session.sessionId,
          fencingToken: ((old ? BigInt(old.fencingToken) : 0n) + 1n).toString(),leaseAcquiredAt: time(),
          leaseExpiresAt: new Date(h.clock.now() + config.leaseMs).toISOString(),lastRenewedAt: time(),releasedAt: null,
          createdAt: old?.createdAt ?? time(),updatedAt: time() };
        rows.set(id,row); return snapshot(row);
      },
      async renewLease(fence) {
        assertFence(fence.deliveryJobId,fence); const row = rows.get(fence.deliveryJobId);
        Object.assign(row,{ leaseExpiresAt: new Date(h.clock.now() + config.leaseMs).toISOString(),lastRenewedAt: time(),updatedAt: time() });
        return snapshot(row);
      },
      async releaseLease(fence) {
        normalizeLeaseFence(fence,fence.deliveryJobId); const row = rows.get(fence.deliveryJobId);
        if (!row || row.ownerId !== fence.ownerId || row.ownerSessionId !== fence.ownerSessionId || row.fencingToken !== fence.fencingToken) throw new RelayerError("STALE_FENCE");
        if (row.releasedAt !== null) return snapshot(row);
        assertFence(fence.deliveryJobId,fence); Object.assign(row,{ leaseExpiresAt: time(),releasedAt: time(),updatedAt: time() });
        return snapshot(row);
      },
      async getLease(id) { return rows.has(id) ? snapshot(rows.get(id)) : null; },
    };
  }
  return { rows,repository,assertFence };
}
