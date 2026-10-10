import { consensusBinding, consensusPeers } from "./validator-sets.mjs";
import { CONSENSUS_VERSION } from "./protocol.mjs";
import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { deterministicPrimary, protocolInteger } from "./committee.mjs";
import { connectPeer } from "./handshake.mjs";
import { authenticatePrePrepare, normalizePrePrepare, PrePrepareError, signPrePrepare } from "./pre-prepare.mjs";

const SOURCE_REASONS = { BATCH_NOT_FOUND: "UNKNOWN_BATCH", BATCH_STATUS: "INVALID_LIFECYCLE" };

export async function broadcastPrePrepare(config, envelope, { fetchImplementation = fetch, authenticatePeer = connectPeer } = {}) {
  return Promise.all(consensusPeers(config, envelope).filter((peer) => peer.address !== config.validatorAddress).map(async (peer) => {
    try {
      await authenticatePeer(config, peer.address, fetchImplementation);
      const response = await fetchImplementation(`${peer.url}/pbft/pre-prepare`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (body.validatorAddress !== peer.address || body.proposalDigest !== envelope.proposalDigest ||
          !["ACCEPTED", "REJECTED"].includes(body.result) ||
          response.status !== (body.result === "ACCEPTED" ? 200 : 422)) throw new Error("invalid delivery response");
      return { peerAddress: peer.address, delivery: "DELIVERED", result: body.result, reason: body.reason ?? null };
    } catch { return { peerAddress: peer.address, delivery: "FAILED" }; }
  }));
}

export function createPrePrepareService({ config, validation, store, broadcast = broadcastPrePrepare, logger = console }) {
  function accepted(record) {
    return { validatorAddress: config.validatorAddress, result: "ACCEPTED", proposalDigest: record.envelope.proposalDigest, record };
  }
  async function reject(input, error) {
    if (!(error instanceof PrePrepareError)) throw error; // Storage failures must remain fail-fast.
    await store.recordPrePrepareRejection(input, error.code);
    logger.warn(`PRE-PREPARE REJECTED: ${error.code}`);
    return { validatorAddress: config.validatorAddress, result: "REJECTED",
      proposalDigest: typeof input?.proposalDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.proposalDigest) ? input.proposalDigest.toLowerCase() : null,
      reason: error.code };
  }
  async function validatePending(batchId) {
    const result = await validation.validatePending(batchId);
    if (result.result !== "VALID") throw new PrePrepareError(SOURCE_REASONS[result.reason] ?? "INVALID_SOURCE_STATE");
    return result.snapshot;
  }
  return {
    primary(epoch, view = "0") {
      return { validatorAddress: config.validatorAddress, epoch: protocolInteger(epoch).toString(), view: protocolInteger(view, "view").toString(),
        ...consensusBinding(config, epoch), committee: config.validatorSets.resolveForBatchEpoch(epoch).validators,
        primaryIdentity: deterministicPrimary(config.validatorSets.resolveForBatchEpoch(epoch).validators, epoch, view) };
    },
    async propose(batchId) {
      let envelope;
      let evidence;
      try {
        let id;
        try { id = normalizeBytes32(batchId); } catch { throw new PrePrepareError("MALFORMED"); }
        const snapshot = await validatePending(id);
        const view = store.currentView ? await store.currentView(snapshot.record.epoch.toString()) : "0";
        if (store.checkActive) await store.checkActive(snapshot.record.epoch.toString(), view, PrePrepareError);
        const old = await store.readPrePrepare(snapshot.record.epoch.toString(), view);
        const states = store.readViewStates ? await store.readViewStates() : [];
        const legacy = states.find((state) => state.epoch === snapshot.record.epoch.toString())?.protocol_version === 2;
        const version = old?.envelope.protocolVersion ?? (legacy ? "2" : CONSENSUS_VERSION);
        const proposal = normalizePrePrepare({ messageType: "PRE_PREPARE", protocolVersion: version, view,
          ...(version === "3" ? consensusBinding(config, snapshot.record.epoch) : {}),
          sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway, epoch: snapshot.record.epoch,
          batchId: snapshot.batch.batchId, messageRoot: snapshot.tree.messageRoot,
          primaryIdentity: deterministicPrimary(version === "3" ? config.validatorSets.resolveForBatchEpoch(snapshot.record.epoch).validators : config.validatorSets.history[0].validators, snapshot.record.epoch, view) });
        evidence = proposal;
        if (proposal.primaryIdentity !== config.validatorAddress) throw new PrePrepareError("WRONG_PRIMARY");
        const previous = await store.readPrePrepare(proposal.epoch, proposal.view);
        if (previous && (previous.envelope.batchId !== proposal.batchId || previous.envelope.messageRoot !== proposal.messageRoot)) {
          throw new PrePrepareError("CONFLICTING_PRE_PREPARE");
        }
        envelope = previous?.envelope ?? await signPrePrepare(config, proposal);
        // Persistence is the safety boundary, including concurrent proposals and recovery.
        const record = await store.savePrePrepare(envelope, "ISSUED");
        const deliveries = await broadcast(config, record.envelope);
        return { ...accepted(record), deliveries }; // Delivery responses are never votes/quorum.
      } catch (error) { return reject(envelope ?? evidence, error); }
    },
    async receive(input) {
      try {
        const envelope = await authenticatePrePrepare(config, input);
        if (store.checkActive) await store.checkActive(envelope.epoch, envelope.view, PrePrepareError);
        const previous = await store.readPrePrepare(envelope.epoch, envelope.view);
        if (previous) {
          if (previous.envelope.proposalDigest !== envelope.proposalDigest) throw new PrePrepareError("CONFLICTING_PRE_PREPARE");
          return accepted(previous);
        }
        const snapshot = await validatePending(envelope.batchId);
        if (snapshot.record.epoch.toString() !== envelope.epoch) throw new PrePrepareError("WRONG_EPOCH");
        if (snapshot.batch.batchId !== envelope.batchId) throw new PrePrepareError("WRONG_BATCH_ID");
        if (snapshot.tree.messageRoot !== envelope.messageRoot) throw new PrePrepareError("WRONG_ROOT");
        return accepted(await store.savePrePrepare(envelope,
          envelope.primaryIdentity === config.validatorAddress ? "ISSUED" : "ACCEPTED"));
      } catch (error) { return reject(input, error); }
    },
  };
}
