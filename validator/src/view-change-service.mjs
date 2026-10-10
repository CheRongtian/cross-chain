import { connectPeer } from "./handshake.mjs";
import { deterministicPrimary } from "./committee.mjs";
import { proposalIdentity, ViewChangeError } from "./prepared-certificate.mjs";
import { authenticateNewView, authenticateViewChange, selectSafeProposal, signNewView } from "./view-change.mjs";

export async function broadcastViewMessage(config, envelope, { fetchImplementation = fetch, authenticatePeer = connectPeer } = {}) {
  const route = envelope.messageType === "VIEW_CHANGE" ? "view-change" : "new-view";
  return Promise.all(config.peers.filter((peer) => peer.address !== config.validatorAddress).map(async (peer) => {
    try {
      await authenticatePeer(config, peer.address, fetchImplementation);
      const response = await fetchImplementation(`${peer.url}/pbft/${route}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(envelope), signal: AbortSignal.timeout(5000),
      });
      const body = await response.json();
      if (body.validatorAddress !== peer.address || !["ACCEPTED", "REJECTED"].includes(body.result) ||
          response.status !== (body.result === "ACCEPTED" ? 200 : 422)) throw new Error("invalid view delivery response");
      return { peerAddress: peer.address, delivery: "DELIVERED", result: body.result, reason: body.reason ?? null };
    } catch { return { peerAddress: peer.address, delivery: "FAILED" }; }
  }));
}
export function createViewChangeService({ config, store, validation, broadcast = broadcastViewMessage }) {
  function accepted(envelope) { return { validatorAddress: config.validatorAddress, result: "ACCEPTED", envelope }; }
  function rejection(error) {
    // Cryptographic normalization errors become protocol rejection; storage errors escape.
    return { validatorAddress: config.validatorAddress, result: "REJECTED", reason: error.code ?? "MALFORMED_VIEW_MESSAGE" };
  }
  async function pending(batchId) {
    const result = await validation.validatePending(batchId);
    if (result.result !== "VALID") {
      if (result.reason === "BATCH_STATUS") {
        const snapshot = await validation.readCommitted(batchId);
        if (snapshot) {
          await store.finalizeEpoch(snapshot.quorumCertificate);
          throw new ViewChangeError("ALREADY_COMMITTED");
        }
      }
      throw new ViewChangeError("INVALID_SOURCE_STATE");
    }
    return proposalIdentity({ sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway,
      epoch: result.snapshot.record.epoch.toString(), batchId: result.snapshot.batch.batchId, messageRoot: result.snapshot.tree.messageRoot });
  }
  return {
    async timeout(epoch, expected) {
      const vote = await store.castViewChange(epoch, expected);
      return { ...accepted(vote), deliveries: await broadcast(config, vote) };
    },
    async retryIntent(epoch, targetView) {
      const votes = await store.readViewChanges(epoch, targetView);
      const vote = votes.find((entry) => entry.voterIdentity === config.validatorAddress);
      if (!vote) throw new ViewChangeError("MISSING_VIEW_CHANGE");
      return { ...accepted(vote), deliveries: await broadcast(config, vote) };
    },
    async replay(epoch, batchId) {
      const message = await store.readLatestIssuedNewView(epoch);
      if (!message) return null;
      const canonical = await pending(batchId);
      const verified = await authenticateNewView(config, message, canonical);
      return { ...accepted(verified), deliveries: await broadcast(config, verified) };
    },
    async receiveViewChange(input) {
      let vote;
      try { vote = await authenticateViewChange(config, input); } catch (error) { return rejection(error); }
      try { return accepted(await store.saveViewChange(vote)); }
      catch (error) { if (!(error instanceof ViewChangeError)) throw error; return rejection(error); }
    },
    async establish(epoch, targetView, batchId) {
      if (deterministicPrimary(config.peers, epoch, targetView) !== config.validatorAddress) throw new ViewChangeError("WRONG_PRIMARY");
      const canonical = await pending(batchId);
      if (canonical.epoch !== String(epoch)) throw new ViewChangeError("WRONG_EPOCH");
      let message = await store.readNewView(epoch, targetView);
      if (message) message = await authenticateNewView(config, message, canonical);
      else {
        const votes = await store.readViewChanges(epoch, targetView);
        if (votes.length < 3) throw new ViewChangeError("QUORUM_REQUIRED");
        // Store the exact selected quorum once. Extra evidence cannot rewrite NEW_VIEW.
        const viewChanges = votes.slice(0, 3);
        message = await signNewView(config, { epoch: String(epoch), view: String(targetView), viewChanges,
          selectedProposal: selectSafeProposal(viewChanges, canonical) }, canonical);
        message = await store.acceptNewView(message, canonical);
      }
      return { ...accepted(message), deliveries: await broadcast(config, message) };
    },
    async receiveNewView(input) {
      let message;
      try {
        // Verify cryptography before expensive source access. With no prepared evidence,
        // the subsequent canonical batch validation supplies the independent authority.
        message = await authenticateNewView(config, input, input.selectedProposal);
      } catch (error) { return rejection(error); }
      try {
        if (store.checkSafeProposal) await store.checkSafeProposal(message.selectedProposal);
        const canonical = await pending(message.selectedProposal.batchId);
        return accepted(await store.acceptNewView(message, canonical));
      } catch (error) { if (!(error instanceof ViewChangeError)) throw error; return rejection(error); }
    },
  };
}
