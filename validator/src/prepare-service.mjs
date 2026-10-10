import { consensusPeers } from "./validator-sets.mjs";
import { validatorFields } from "./protocol.mjs";
import { normalizeAddress } from "../../indexer/src/canonical-message.mjs";
import { protocolInteger } from "./committee.mjs";
import { connectPeer } from "./handshake.mjs";
import { authenticatePrepare, normalizePrepare, PrepareError, signPrepare } from "./prepare.mjs";

export async function broadcastPrepare(config, envelope, { fetchImplementation = fetch, authenticatePeer = connectPeer } = {}) {
  return Promise.all(consensusPeers(config, envelope).filter((peer) => peer.address !== config.validatorAddress).map(async (peer) => {
    try {
      await authenticatePeer(config, peer.address, fetchImplementation);
      const response = await fetchImplementation(`${peer.url}/pbft/prepare`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (body.validatorAddress !== peer.address || body.prepareDigest !== envelope.prepareDigest ||
          !["ACCEPTED", "REJECTED"].includes(body.result) ||
          response.status !== (body.result === "ACCEPTED" ? 200 : 422)) throw new Error("invalid PREPARE delivery response");
      return { peerAddress: peer.address, delivery: "DELIVERED", result: body.result, reason: body.reason ?? null };
    } catch { return { peerAddress: peer.address, delivery: "FAILED" }; }
  }));
}

export function createPrepareService({ config, store, broadcast = broadcastPrepare, sign = signPrepare, logger = console }) {
  function response(record) {
    return { validatorAddress: config.validatorAddress, result: "ACCEPTED", prepareDigest: record.vote.prepareDigest,
      voteCount: record.voteCount, prepared: record.prepared !== null, record };
  }
  async function reject(input, error) {
    if (!(error instanceof PrepareError)) throw error;
    await store.recordPrepareRejection(input, error.code);
    logger.warn(`PREPARE REJECTED: ${error.code}`);
    return { validatorAddress: config.validatorAddress, result: "REJECTED",
      prepareDigest: typeof input?.prepareDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.prepareDigest)
        ? input.prepareDigest.toLowerCase() : null,
      reason: error.code };
  }
  async function requireAccepted(vote) {
    let accepted = await store.readPrePrepare(vote.epoch, vote.view);
    if (!accepted) {
      const sameProposal = await store.readPrePrepareByDigest(vote.proposalDigest);
      if (sameProposal && sameProposal.envelope.epoch !== vote.epoch) throw new PrepareError("WRONG_EPOCH");
      throw new PrepareError("PRE_PREPARE_REQUIRED");
    }
    const proposal = accepted.envelope;
    if (vote.batchId !== proposal.batchId) throw new PrepareError("WRONG_BATCH_ID");
    if (vote.messageRoot !== proposal.messageRoot) throw new PrepareError("WRONG_ROOT");
    if (vote.proposalDigest !== proposal.proposalDigest) throw new PrepareError("WRONG_PROPOSAL");
    return accepted;
  }
  return {
    async list() { return { validatorAddress: config.validatorAddress, states: await store.readPrepareStates() }; },
    async cast(epoch) {
      let evidence;
      try {
        let normalizedEpoch;
        try { normalizedEpoch = protocolInteger(epoch).toString(); } catch { throw new PrepareError("MALFORMED"); }
        if (store.castPrepareVote) {
          const record = await store.castPrepareVote(normalizedEpoch, sign);
          return { ...response(record), deliveries: await broadcast(config, record.vote) };
        }
        const view = store.currentView ? await store.currentView(normalizedEpoch) : "0";
        if (store.checkActive) await store.checkActive(normalizedEpoch, view, PrepareError);
        const accepted = await store.readPrePrepare(normalizedEpoch, view);
        if (!accepted) throw new PrepareError("PRE_PREPARE_REQUIRED");
        evidence = accepted.envelope;
        const existing = await store.readPrepareVote(normalizedEpoch, config.validatorAddress, view);
        if (existing) {
          const vote = existing.vote;
          const proposal = accepted.envelope;
          if (vote.protocolVersion !== proposal.protocolVersion || vote.sourceDomain !== proposal.sourceDomain ||
              vote.sourceGateway !== proposal.sourceGateway || vote.epoch !== proposal.epoch || vote.view !== proposal.view ||
              vote.batchId !== proposal.batchId || vote.messageRoot !== proposal.messageRoot ||
              vote.proposalDigest !== proposal.proposalDigest || vote.voterIdentity !== config.validatorAddress) {
            throw new PrepareError("DOUBLE_VOTE");
          }
          const deliveries = await broadcast(config, existing.vote);
          return { ...response(existing), deliveries };
        }
        const vote = normalizePrepare({ messageType: "PREPARE", protocolVersion: accepted.envelope.protocolVersion,
          sourceDomain: accepted.envelope.sourceDomain, sourceGateway: accepted.envelope.sourceGateway,
          epoch: accepted.envelope.epoch, view: accepted.envelope.view, ...validatorFields(accepted.envelope), batchId: accepted.envelope.batchId, messageRoot: accepted.envelope.messageRoot,
          proposalDigest: accepted.envelope.proposalDigest, voterIdentity: config.validatorAddress });
        const envelope = await sign(config, vote);
        const record = await store.savePrepareVote(envelope);
        const deliveries = await broadcast(config, record.vote);
        return { ...response(record), deliveries };
      } catch (error) { return reject(evidence, error); }
    },
    async receive(input) {
      try {
        const vote = await authenticatePrepare(config, input);
        if (store.checkActive) await store.checkActive(vote.epoch, vote.view, PrepareError);
        const voter = normalizeAddress(vote.voterIdentity);
        const existing = await store.readPrepareVote(vote.epoch, voter, vote.view);
        if (existing) {
          if (existing.vote.prepareDigest !== vote.prepareDigest) throw new PrepareError("CONFLICTING_PREPARE");
          return response(existing);
        }
        await requireAccepted(vote);
        return response(await store.savePrepareVote(vote));
      } catch (error) { return reject(input, error); }
    },
  };
}
