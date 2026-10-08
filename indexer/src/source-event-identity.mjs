import { normalizeAddress, normalizeBytes32, toUint256 } from "./canonical-message.mjs";

export function normalizeSourceEventIdentity(event) {
  return {
    sourceDomain: toUint256(event.sourceDomain, "source event domain").toString(),
    sourceGateway: normalizeAddress(event.sourceGateway, "source event gateway"),
    sourceBlockHash: normalizeBytes32(event.sourceBlockHash, "source event block hash"),
    sourceTransactionHash: normalizeBytes32(
      event.sourceTransactionHash,
      "source event transaction hash",
    ),
    sourceLogIndex: toUint256(event.sourceLogIndex, "source event log index").toString(),
  };
}

export function sourceEventIdentityKey(event) {
  const identity = normalizeSourceEventIdentity(event);
  return [
    identity.sourceDomain,
    identity.sourceGateway,
    identity.sourceBlockHash,
    identity.sourceTransactionHash,
    identity.sourceLogIndex,
  ].join(":");
}

export function sameSourceEventIdentity(left, right) {
  return sourceEventIdentityKey(left) === sourceEventIdentityKey(right);
}
