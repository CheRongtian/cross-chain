import { consensusPeers } from "./validator-sets.mjs";
import { protocolInteger } from "./committee.mjs";
import { connectPeer } from "./handshake.mjs";
import { authenticateCommit, CommitError, signCommit } from "./commit.mjs";
import { QuorumCertificateError, verifyQuorumCertificate } from "./quorum-certificate.mjs";

export async function broadcastCommit(config, envelope, { fetchImplementation = fetch, authenticatePeer = connectPeer } = {}) {
  return Promise.all(consensusPeers(config, envelope).filter((peer) => peer.address !== config.validatorAddress).map(async (peer) => {
    try {
      await authenticatePeer(config, peer.address, fetchImplementation);
      const response = await fetchImplementation(`${peer.url}/pbft/commit`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (body.validatorAddress !== peer.address || body.commitDigest !== envelope.commitDigest ||
          !["ACCEPTED", "REJECTED"].includes(body.result) ||
          response.status !== (body.result === "ACCEPTED" ? 200 : 422)) throw new Error("invalid COMMIT delivery response");
      return { peerAddress: peer.address, delivery: "DELIVERED", result: body.result, reason: body.reason ?? null };
    } catch { return { peerAddress: peer.address, delivery: "FAILED" }; }
  }));
}

export function createCommitService({ config, store, lifecycle, broadcast = broadcastCommit, sign = signCommit, logger = console }) {
  function accepted(state, voter) {
    const vote = state.votes.find((entry) => entry.voterIdentity === voter);
    return { validatorAddress: config.validatorAddress, result: "ACCEPTED", commitDigest: vote.commitDigest,
      voteCount: state.voteCount, commitQuorum: state.quorum !== null, record: { vote, state } };
  }
  async function rejected(input, error) {
    if (!(error instanceof CommitError) && !(error instanceof QuorumCertificateError)) throw error;
    await store.recordCommitRejection(input, error.code);
    logger.warn(`COMMIT/QC REJECTED: ${error.code}`);
    return { validatorAddress: config.validatorAddress, result: "REJECTED", reason: error.code,
      commitDigest: typeof input?.commitDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.commitDigest)
        ? input.commitDigest.toLowerCase() : null };
  }
  function epoch(value) {
    try { return protocolInteger(value).toString(); } catch { throw new CommitError("MALFORMED"); }
  }
  return {
    async list() { return { validatorAddress: config.validatorAddress, states: await store.readCommitStates() }; },
    async cast(value) {
      try {
        const state = await store.castCommitVote(epoch(value), sign);
        const result = accepted(state, config.validatorAddress);
        const deliveries = await broadcast(config, result.record.vote);
        return { ...result, deliveries };
      } catch (error) { return rejected({ epoch: value }, error); }
    },
    async receive(input) {
      try {
        const vote = await authenticateCommit(config, input);
        return accepted(await store.saveCommitVote(vote), vote.voterIdentity);
      } catch (error) { return rejected(input, error); }
    },
    async certificate(value, view) {
      try {
        if (view !== undefined) {
          try { view = protocolInteger(view, "view").toString(); } catch { throw new CommitError("MALFORMED"); }
        }
        const state = await store.readCommitState(epoch(value), view);
        if (!state.certificate) throw new CommitError("COMMIT_QUORUM_REQUIRED");
        return { validatorAddress: config.validatorAddress, result: "ACCEPTED", certificate: state.certificate };
      } catch (error) { return rejected({ epoch: value }, error); }
    },
    async verify(certificate) {
      try {
        const verified = await verifyQuorumCertificate(certificate, { peers: config.peers, validatorSets: config.validatorSets,
          expected: { protocolVersion: certificate.protocolVersion, sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway,
            epoch: certificate.epoch, validatorEpoch: certificate.validatorEpoch, view: certificate.view ?? "0",
            batchId: certificate.batchId, messageRoot: certificate.messageRoot } });
        return { validatorAddress: config.validatorAddress, result: "ACCEPTED", qcDigest: verified.qcDigest, certificate: verified };
      } catch (error) {
        if (!(error instanceof QuorumCertificateError)) throw error;
        return { validatorAddress: config.validatorAddress, result: "REJECTED", reason: error.code };
      }
    },
    async submit(certificate) {
      try {
        const snapshot = await lifecycle.commitWithCertificate({ certificate });
        if (store.finalizeEpoch) await store.finalizeEpoch(snapshot.quorumCertificate);
        return { validatorAddress: config.validatorAddress, result: "ACCEPTED", batchId: snapshot.record.batchId,
          status: snapshot.record.status, qcDigest: snapshot.quorumCertificate.qcDigest, certificate: snapshot.quorumCertificate };
      } catch (error) { return rejected(certificate, error); }
    },
  };
}
