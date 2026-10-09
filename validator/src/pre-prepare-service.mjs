import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { canonicalCommittee, deterministicPrimary, protocolInteger } from "./committee.mjs";
import { connectPeer } from "./handshake.mjs";
import { authenticatePrePrepare, normalizePrePrepare, PrePrepareError, signPrePrepare } from "./pre-prepare.mjs";

const SOURCE_REASONS = { BATCH_NOT_FOUND: "UNKNOWN_BATCH", BATCH_STATUS: "INVALID_LIFECYCLE" };

export async function broadcastPrePrepare(config, envelope, { fetchImplementation = fetch, authenticatePeer = connectPeer } = {}) {
  return Promise.all(config.peers.filter((peer) => peer.address !== config.validatorAddress).map(async (peer) => {
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
    primary(epoch) {
      return { validatorAddress: config.validatorAddress, epoch: protocolInteger(epoch).toString(),
        committee: canonicalCommittee(config.peers), primaryIdentity: deterministicPrimary(config.peers, epoch) };
    },
    async propose(batchId) {
      let envelope;
      let evidence;
      try {
        let id;
        try { id = normalizeBytes32(batchId); } catch { throw new PrePrepareError("MALFORMED"); }
        const snapshot = await validatePending(id);
        const proposal = normalizePrePrepare({ messageType: "PRE_PREPARE", protocolVersion: "1",
          sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway, epoch: snapshot.record.epoch,
          batchId: snapshot.batch.batchId, messageRoot: snapshot.tree.messageRoot,
          primaryIdentity: deterministicPrimary(config.peers, snapshot.record.epoch) });
        evidence = proposal;
        if (proposal.primaryIdentity !== config.validatorAddress) throw new PrePrepareError("WRONG_PRIMARY");
        const previous = await store.readPrePrepare(proposal.epoch);
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
        const previous = await store.readPrePrepare(envelope.epoch);
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
