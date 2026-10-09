import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encodeAbiParameters, parseAbiParameters } from "viem";

import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import { buildMessageBatch } from "../src/message-batch.mjs";
import {
  buildMessageMerkleTree, computeMessageMerkleLeaf, computeMessageMerkleNode,
  MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_LEAF_TYPE,
  MESSAGE_MERKLE_NODE_DOMAIN, MESSAGE_MERKLE_NODE_TYPE,
} from "../src/message-merkle.mjs";

export const MERKLE_GOLDEN_PATH = fileURLToPath(new URL("../../test-vectors/merkle-golden-vectors.json", import.meta.url));
const LEAF_ABI = parseAbiParameters("bytes32,bytes32,uint256,bytes32");

// JSON is fixture transport, never a protocol hash preimage. Sort keys explicitly.
export function serializeMerkleVectors(value) {
  function ordered(item) {
    if (typeof item === "bigint") return item.toString();
    if (Array.isArray(item)) return item.map(ordered);
    if (item !== null && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, ordered(item[key])]));
    }
    return item;
  }
  return `${JSON.stringify(ordered(value), null, 2)}\n`;
}

export function generateMerkleVectors(input) {
  if (input?.messages?.length !== 5) throw new Error("golden inputs require exactly five fixed messages");
  const messages = input.messages.map((fields) => {
    const message = { ...input.messageDefaults, ...fields };
    message.payloadHash = computePayloadHash(message.payload);
    message.messageId = computeCanonicalMessageId(message);
    return message;
  });
  const vectors = [1, 2, 3, 4, 5].map((count) => {
    const batch = buildMessageBatch({ ...input.context, messages: messages.slice(0, count) });
    const tree = buildMessageMerkleTree(batch);
    // Retain a trace using the existing node primitive, not another hash protocol.
    const levels = [[...tree.leaves]];
    while (levels.at(-1).length > 1) {
      const children = levels.at(-1);
      const parents = [];
      for (let index = 0; index < children.length; index += 2) {
        parents.push(computeMessageMerkleNode(children[index], children[index + 1] ?? children[index]));
      }
      levels.push(parents);
    }
    if (levels.at(-1)[0] !== tree.messageRoot) throw new Error("golden node trace differs from Merkle builder");
    return {
      name: `ordered-${count}-messages`, batch, leafCount: count, leaves: tree.leaves, levels,
      leafPreimages: batch.messageIds.map((messageId, index) => encodeAbiParameters(
        LEAF_ABI, [MESSAGE_MERKLE_LEAF_DOMAIN, batch.batchId, BigInt(index), messageId],
      )),
      messageRoot: tree.messageRoot,
      proofs: tree.proofs.map((proof) => ({ ...proof, expectedValid: true })),
    };
  });
  const batch = vectors.at(-1).batch;
  // A standalone leaf probe catches truncating an index to uint32. Not a tree position.
  const index = 4_294_967_297;
  const preimage = encodeAbiParameters(LEAF_ABI, [MESSAGE_MERKLE_LEAF_DOMAIN, batch.batchId, BigInt(index), batch.messageIds[0]]);
  const encodingProbe = {
    batchId: batch.batchId, messageId: batch.messageIds[0], index, preimage,
    expectedLeaf: computeMessageMerkleLeaf({ batchId: batch.batchId, messageId: batch.messageIds[0], index }),
    sha3LeafHash: `0x${createHash("sha3-256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`,
  };
  return {
    schemaVersion: 1,
    protocol: "ordered-message-merkle-abi-keccak-v1",
    leafType: MESSAGE_MERKLE_LEAF_TYPE, leafDomain: MESSAGE_MERKLE_LEAF_DOMAIN,
    nodeType: MESSAGE_MERKLE_NODE_TYPE, nodeDomain: MESSAGE_MERKLE_NODE_DOMAIN,
    input, encodingProbe, vectors,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const mode = process.argv[2];
  if (mode !== undefined && mode !== "--check") throw new Error("usage: generate-merkle-golden-vectors.mjs [--check]");
  const source = await readFile(MERKLE_GOLDEN_PATH, "utf8");
  const fixture = JSON.parse(source);
  const generated = serializeMerkleVectors(generateMerkleVectors(fixture.input));
  if (mode === "--check") {
    if (source !== generated) throw new Error("committed Merkle golden fixture drift; expected values were not overwritten");
    process.stdout.write("VALID: committed Merkle golden fixture is stable; no fixture overwritten\n");
  } else {
    // Explicit developer generation emits stdout only. Verification always uses --check.
    process.stdout.write(generated);
  }
}
