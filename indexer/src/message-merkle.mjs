import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

import { normalizeBytes32 } from "./canonical-message.mjs";
import { normalizeBatchMessage, validateMessageBatch } from "./message-batch.mjs";

export const MESSAGE_MERKLE_LEAF_TYPE =
  "MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)";
export const MESSAGE_MERKLE_NODE_TYPE =
  "MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)";
export const MESSAGE_MERKLE_LEAF_DOMAIN = keccak256(stringToHex(MESSAGE_MERKLE_LEAF_TYPE));
export const MESSAGE_MERKLE_NODE_DOMAIN = keccak256(stringToHex(MESSAGE_MERKLE_NODE_TYPE));

const LEAF_PARAMETERS = parseAbiParameters("bytes32,bytes32,uint256,bytes32");
const NODE_PARAMETERS = parseAbiParameters("bytes32,bytes32,bytes32");

function validateIndex(index, leafCount) {
  if (!Number.isSafeInteger(index) || index < 0 || (leafCount !== undefined && index >= leafCount)) {
    throw new Error("Merkle message index must be a non-negative safe integer within batch bounds");
  }
}

export function computeMessageMerkleLeaf({ batchId, index, messageId }) {
  validateIndex(index);
  return keccak256(encodeAbiParameters(LEAF_PARAMETERS, [
    MESSAGE_MERKLE_LEAF_DOMAIN,
    normalizeBytes32(batchId, "batch ID"),
    BigInt(index),
    normalizeBytes32(messageId, "message ID"),
  ])).toLowerCase();
}

export function computeMessageMerkleNode(leftChild, rightChild) {
  return keccak256(encodeAbiParameters(NODE_PARAMETERS, [
    MESSAGE_MERKLE_NODE_DOMAIN,
    normalizeBytes32(leftChild, "left Merkle child"),
    normalizeBytes32(rightChild, "right Merkle child"),
  ])).toLowerCase();
}

export function buildMessageMerkleTree(batch) {
  const canonical = validateMessageBatch(batch);
  const leaves = canonical.messageIds.map((messageId, index) => computeMessageMerkleLeaf({
    batchId: canonical.batchId,
    index,
    messageId,
  }));
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const children = levels.at(-1);
    const parents = [];
    for (let index = 0; index < children.length; index += 2) {
      parents.push(computeMessageMerkleNode(
        children[index],
        children[index + 1] ?? children[index],
      ));
    }
    levels.push(parents);
  }

  const proofs = canonical.messageIds.map((messageId, index) => {
    let position = index;
    const siblings = [];
    for (const level of levels.slice(0, -1)) {
      const siblingIndex = position % 2 === 0 ? position + 1 : position - 1;
      siblings.push(level[siblingIndex] ?? level[position]);
      position = Math.floor(position / 2);
    }
    return Object.freeze({
      batchId: canonical.batchId,
      messageId,
      index,
      leafCount: leaves.length,
      siblings: Object.freeze(siblings),
    });
  });

  return Object.freeze({
    batchId: canonical.batchId,
    leafCount: leaves.length,
    messageRoot: levels.at(-1)[0],
    leaves: Object.freeze(leaves),
    proofs: Object.freeze(proofs),
  });
}

// Invalid proof inputs return false. Expected batch and root are caller-supplied expectations.
export function verifyMessageMerkleProof(input) {
  try {
    const { batch, message, proof, messageRoot } = input;
    const canonical = validateMessageBatch(batch);
    const expectedRoot = normalizeBytes32(messageRoot, "Message Root");
    if (proof === null || typeof proof !== "object") {
      return false;
    }
    validateIndex(proof.index, canonical.messages.length);
    if (
      !Number.isSafeInteger(proof.leafCount) ||
      proof.leafCount !== canonical.messages.length ||
      normalizeBytes32(proof.batchId, "proof batch ID") !== canonical.batchId ||
      !Array.isArray(proof.siblings)
    ) {
      return false;
    }
    const expectedMessage = canonical.messages[proof.index];
    const candidate = normalizeBatchMessage(message, canonical);
    if (
      normalizeBytes32(proof.messageId, "proof message ID") !== expectedMessage.messageId ||
      Object.keys(expectedMessage).some((field) => candidate[field] !== expectedMessage[field])
    ) {
      return false;
    }

    let pathLength = 0;
    for (let width = proof.leafCount; width > 1; width = Math.ceil(width / 2)) {
      pathLength += 1;
    }
    if (proof.siblings.length !== pathLength) {
      return false;
    }

    let node = computeMessageMerkleLeaf({
      batchId: canonical.batchId,
      index: proof.index,
      messageId: candidate.messageId,
    });
    let position = proof.index;
    let width = proof.leafCount;
    for (const rawSibling of proof.siblings) {
      const sibling = normalizeBytes32(rawSibling, "Merkle proof sibling");
      if (position % 2 === 0) {
        if (position + 1 >= width && sibling !== node) {
          return false;
        }
        node = computeMessageMerkleNode(node, sibling);
      } else {
        node = computeMessageMerkleNode(sibling, node);
      }
      position = Math.floor(position / 2);
      width = Math.ceil(width / 2);
    }
    return node === expectedRoot;
  } catch {
    return false;
  }
}
