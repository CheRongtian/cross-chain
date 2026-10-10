import { tableName } from "../../indexer/src/db.mjs";
import { deterministicPrimary } from "./committee.mjs";
import { ViewChangeError } from "./prepared-certificate.mjs";

// The clock is injectable. Production owns one bounded, serialized scheduler;
// no HTTP route can set the view or directly fire its timeout.
export function createConsensusRuntime({ config, sourcePool, store, validation, lifecycle, prePrepare, prepare, commit, viewChange,
  clock = { now: () => Date.now(), schedule: setTimeout, cancel: clearTimeout }, logger = console }) {
  let stopped = false;
  let timer;
  let pendingTick = Promise.resolve();
  const retryAt = new Map();
  const interval = Math.max(10, Math.min(250, Math.floor(config.viewTimeoutMs / 4)));
  function due(key) {
    if ((retryAt.get(key) ?? 0) > clock.now()) return false;
    retryAt.set(key, clock.now() + 1000);
    return true;
  }
  async function advance(state) {
    if (state.finalized) return;
    if (!config.validatorSets.resolveForBatchEpoch(state.epoch).validators.includes(config.validatorAddress)) return;
    const epoch = state.epoch;
    const committee = state.protocol_version === 2 ? config.validatorSets.history[0].validators : config.validatorSets.resolveForBatchEpoch(epoch).validators;
    const view = state.current_view;
    const key = `${epoch}:${view}`;
    // Recovery of an already certified view is independent of the next timeout.
    // A former primary can help a lagging node even while waiting for a new leader.
    if (due(`${epoch}:new-view-replay`)) await viewChange.replay(epoch, state.batch_id);
    if (stopped) return;

    const candidates = await store.readViewChangeTargets(epoch);
    for (const target of candidates) {
      if (BigInt(target) <= BigInt(view) || BigInt(target) < BigInt(state.target_view)) continue;
      if (deterministicPrimary(committee, epoch, target) === config.validatorAddress) {
        await viewChange.establish(epoch, target, state.batch_id);
        return;
      }
    }
    const intentKey = `${epoch}:intent:${state.target_view}`;
    if (state.changing_view && !retryAt.has(intentKey)) {
      // First encounter after restart always replays the exact persisted intent.
      retryAt.set(intentKey, clock.now() + 1000);
      await viewChange.retryIntent(epoch, state.target_view);
      return;
    }
    const deadline = new Date(state.changing_view ? state.view_change_at : state.progress_at).getTime() + config.viewTimeoutMs;
    if (clock.now() >= deadline) {
      const result = await viewChange.timeout(epoch, { view, targetView: state.target_view,
        progressRevision: state.progress_revision, now: clock.now() });
      retryAt.set(`${epoch}:intent:${result.envelope.targetView}`, clock.now() + 1000);
      return;
    }
    if (state.changing_view) {
      if (due(intentKey)) await viewChange.retryIntent(epoch, state.target_view);
      return;
    }
    if (view === "0") return;
    if (deterministicPrimary(committee, epoch, view) === config.validatorAddress && due(`${key}:proposal`)) {
      const result = await prePrepare.propose(state.batch_id);
      if (result.result !== "ACCEPTED") return;
    }
    if (stopped) return;
    const accepted = await store.readPrePrepare(epoch, view);
    if (!accepted) return;
    if (due(`${key}:prepare`)) await prepare.cast(epoch);
    if (stopped) return;
    const prepared = await store.readPrepareState(epoch, view);
    if (prepared.prepared && due(`${key}:commit`)) await commit.cast(epoch);
    if (stopped) return;
    const result = await store.readCommitState(epoch, view);
    if (result.certificate) {
      const submitted = await commit.submit(result.certificate);
      if (submitted.result !== "ACCEPTED") throw new Error(`QC finalization failed: ${submitted.reason}`);
    }
  }
  // Startup awaits discovery before opening HTTP. Discovery validates/registers
  // candidates and restores finality, but never casts votes or broadcasts.
  async function discover() {
    const rows = (await sourcePool.query(`SELECT batch_record_id,batch_id,epoch,status FROM ${tableName(config.sourceDatabaseSchema, "message_batches")}
      WHERE source_domain = $1 AND source_gateway = $2 AND status IN ('CONSENSUS_PENDING','COMMITTED') ORDER BY epoch`,
      [config.chainDomain.toString(), config.sourceGateway])).rows;
    const states = await store.readViewStates();
    const registered = new Set(states.map((state) => state.epoch));
    for (const row of rows) {
      if (stopped) return;
      if (row.status === "COMMITTED") {
        const local = states.find((state) => state.epoch === row.epoch);
        if (local && !local.finalized) {
          const snapshot = await lifecycle.readBatch({ batchRecordId: row.batch_record_id });
          await store.finalizeEpoch(snapshot.quorumCertificate);
        }
      } else if (!registered.has(row.epoch)) {
        if (!config.validatorSets.resolveForBatchEpoch(row.epoch).validators.includes(config.validatorAddress)) continue;
        const result = await validation.validatePending(row.batch_id);
        if (result.result !== "VALID") continue;
        await store.registerEpoch({ epoch: row.epoch, batchId: result.snapshot.record.batchId, messageRoot: result.snapshot.record.messageRoot });
      }
    }
  }
  async function tick() {
    await discover();
    const states = await store.readViewStates();
    for (const state of states) {
      if (stopped) return;
      try { await advance(state); }
      catch (error) {
        if (!(error instanceof ViewChangeError)) throw error;
        // A concurrent NEW_VIEW or QC may supersede this scheduler snapshot.
        if (!["STALE_VIEW", "SUPERSEDED_TIMEOUT", "ALREADY_COMMITTED", "WRONG_TARGET_VIEW"].includes(error.code)) throw error;
      }
    }
  }
  function schedule() {
    if (stopped) return;
    timer = clock.schedule(() => {
      pendingTick = tick().catch((error) => {
        // An internal state failure halts the scheduler and makes readiness fail closed.
        stopped = true;
        logger.error(`PBFT scheduler halted: ${error.code ?? "CONSENSUS_STATE_FAILURE"}`);
      }).finally(schedule);
    }, interval);
  }
  return {
    initialize: discover, tick, start: schedule,
    healthy: () => !stopped,
    async close() { stopped = true; clock.cancel(timer); await pendingTick; },
  };
}
