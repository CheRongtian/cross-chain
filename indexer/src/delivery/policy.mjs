import { readFileSync } from "node:fs";

export const DELIVERY_POLICY = Object.freeze(JSON.parse(readFileSync(
  new URL("../../../test-vectors/delivery-policy.json", import.meta.url), "utf8")));

export function requireDeliveryBounds(pack) {
  if (!pack || !Array.isArray(pack.batchMessageIds) || pack.batchMessageIds.length > DELIVERY_POLICY.maxBatchMessages) {
    throw new Error("BATCH_MEMBERSHIP_LIMIT_EXCEEDED");
  }
  if (typeof pack.message?.payload !== "string" || (pack.message.payload.length - 2) / 2 > DELIVERY_POLICY.maxPayloadBytes) {
    throw new Error("MESSAGE_PAYLOAD_LIMIT_EXCEEDED");
  }
  if (!Array.isArray(pack.merkleProof?.siblings) || pack.merkleProof.siblings.length > DELIVERY_POLICY.maxMerkleDepth) {
    throw new Error("MERKLE_DEPTH_LIMIT_EXCEEDED");
  }
}
