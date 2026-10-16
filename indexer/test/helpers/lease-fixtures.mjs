import { randomUUID } from "node:crypto";
import { normalizeLeaseFence, MAX_FENCING_TOKEN } from "../../src/relayer/leases.mjs";
import { RelayerError } from "../../src/relayer/config.mjs";

// Deterministic unit fixture. Database tests separately exercise real SQL locks.
export function memoryLeaseFixture(h) {
  const rows = new Map(); const workers = new Set(); const turns = new Map();
  const time = () => new Date(h.clock.now()).toISOString();
  const snapshot = row => Object.freeze({ ...row });
  function assertFence(id,fence) {
    normalizeLeaseFence(fence,id);
    const row = rows.get(id);
    if (!row || row.ownerId !== fence.ownerId || row.ownerSessionId !== fence.ownerSessionId || row.fencingToken !== fence.fencingToken ||
        row.releasedAt !== null || Date.parse(row.leaseExpiresAt) <= h.clock.now()) throw new RelayerError("STALE_FENCE");
  }
  h.repository.assertFence = async (id,fence) => assertFence(id,fence);
  const prepare = h.repository.persistPrepared.bind(h.repository);
  h.repository.persistPrepared = async options => {
    const stored = await prepare(options);
    const row = rows.get(options.intent.deliveryJobId);
    if (stored.created && row) Object.assign(row,{ preparationRetryAt: null,preparationDeferReason: null });
    return stored;
  };
  function repository(config = h.config) {
    return {
      async withWorker(operation) {
        if (workers.has(config.workerId)) throw new RelayerError("RELAYER_WORKER_ALREADY_RUNNING");
        workers.add(config.workerId);
        try { return await operation({ workerId: config.workerId,sessionId: randomUUID(),assertHeld() {} }); }
        finally { workers.delete(config.workerId); }
      },
      async listClaimableJobs({ limit,session }) {
        const eligible = h.jobs.filter(job => {
          const intent = h.records.get(job.deliveryJobId)?.intent;
          const attempt = h.records.get(job.deliveryJobId)?.attempt;
          const row = rows.get(job.deliveryJobId);
          return job.destinationDomain === config.destinationDomain.toString() && !h.historical.has(job.deliveryJobId) &&
            (intent || !row?.preparationRetryAt || Date.parse(row.preparationRetryAt) <= h.clock.now()) && (!intent || (intent.status === "PENDING" && intent.retryStoppedAt === null &&
            (Date.parse(intent.nextActionAt) <= h.clock.now() || (attempt.status === "SIGNED" && attempt.broadcastAttemptCount === "0") ||
              h.journal.some(event => event.completedAt === null && h.records.get(job.deliveryJobId).attempts.some(a => a.attemptId === event.attemptId))))) &&
            (!row || Date.parse(row.leaseExpiresAt) <= h.clock.now() || (row.ownerId === session.workerId && row.ownerSessionId === session.sessionId));
        });
        const deferred = eligible.filter(job => !h.records.has(job.deliveryJobId) && rows.get(job.deliveryJobId)?.preparationRetryAt);
        deferred.sort((a,b) => Date.parse(rows.get(a.deliveryJobId).preparationRetryAt) - Date.parse(rows.get(b.deliveryJobId).preparationRetryAt) || h.jobs.indexOf(a) - h.jobs.indexOf(b));
        const ordinary = eligible.filter(job => !deferred.includes(job));
        let turn = turns.get(config.workerId) ?? false;
        const selected = [];
        while (selected.length < limit && (ordinary.length || deferred.length)) {
          const group = turn ? (deferred.length ? deferred : ordinary) : (ordinary.length ? ordinary : deferred);
          selected.push(group.shift()); turn = group === ordinary;
        }
        if (selected.length) turns.set(config.workerId,turn);
        return selected;
      },
      async tryAcquireLease(id,session) {
        const intent = h.records.get(id)?.intent;
        if (!h.jobs.some(job => job.deliveryJobId === id && job.destinationDomain === config.destinationDomain.toString()) ||
            h.historical.has(id) || (intent && (intent.status !== "PENDING" || intent.retryStoppedAt !== null))) return null;
        const old = rows.get(id);
        if (!intent && old?.preparationRetryAt && Date.parse(old.preparationRetryAt) > h.clock.now()) return null;
        if (old && Date.parse(old.leaseExpiresAt) > h.clock.now()) return old.ownerId === session.workerId && old.ownerSessionId === session.sessionId ? snapshot(old) : null;
        if (old && BigInt(old.fencingToken) === MAX_FENCING_TOKEN) throw new RelayerError("FENCING_TOKEN_EXHAUSTED");
        const row = { deliveryJobId: id,ownerId: session.workerId,ownerSessionId: session.sessionId,
          fencingToken: ((old ? BigInt(old.fencingToken) : 0n) + 1n).toString(),leaseAcquiredAt: time(),
          leaseExpiresAt: new Date(h.clock.now() + config.leaseMs).toISOString(),lastRenewedAt: time(),releasedAt: null,
          createdAt: old?.createdAt ?? time(),updatedAt: time(),preparationRetryAt: old?.preparationRetryAt ?? null,
          preparationDeferReason: old?.preparationDeferReason ?? null };
        rows.set(id,row); return snapshot(row);
      },
      async deferPreparation(fence) {
        assertFence(fence.deliveryJobId,fence);
        if (h.records.has(fence.deliveryJobId)) return null;
        const row = rows.get(fence.deliveryJobId);
        Object.assign(row,{ preparationRetryAt: new Date(h.clock.now() + config.rebroadcastIntervalMs).toISOString(),
          preparationDeferReason: "ESTIMATE_EXECUTION_REVERT",updatedAt: time() });
        return snapshot(row);
      },
      async getPreparationDefer(id) {
        const row = rows.get(id);
        return !h.records.has(id) && row?.preparationRetryAt && Date.parse(row.preparationRetryAt) > h.clock.now() ? snapshot(row) : null;
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
  return { rows,turns,repository,assertFence };
}
