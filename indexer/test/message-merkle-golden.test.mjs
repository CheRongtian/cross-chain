import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { encodeAbiParameters, encodePacked, keccak256, parseAbiParameters } from "viem";

import { buildMessageBatch } from "../src/message-batch.mjs";
import {
  buildMessageMerkleTree, computeMessageMerkleLeaf, computeMessageMerkleNode,
  MESSAGE_MERKLE_LEAF_DOMAIN, MESSAGE_MERKLE_LEAF_TYPE,
  MESSAGE_MERKLE_NODE_DOMAIN, MESSAGE_MERKLE_NODE_TYPE, verifyMessageMerkleProof,
} from "../src/message-merkle.mjs";
import {
  generateMerkleVectors, MERKLE_GOLDEN_PATH, serializeMerkleVectors,
} from "../scripts/generate-merkle-golden-vectors.mjs";

const source = await readFile(MERKLE_GOLDEN_PATH, "utf8");
const fixture = JSON.parse(source);
const LEAF_ABI = parseAbiParameters("bytes32,bytes32,uint256,bytes32");
const NODE_ABI = parseAbiParameters("bytes32,bytes32,bytes32");
const flip = (hash) => `0x${(BigInt(hash) ^ 1n).toString(16).padStart(64, "0")}`;

function proofInput(vector, index) {
  const batch = buildMessageBatch(vector.batch);
  return { batch, message: batch.messages[index], proof: vector.proofs[index], messageRoot: vector.messageRoot };
}

test("committed golden fixture is deterministic, fixed, and never rewritten", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.protocol, "ordered-message-merkle-abi-keccak-v1");
  assert.deepEqual(fixture.vectors.map((vector) => vector.leafCount), [1, 2, 3, 4, 5]);
  assert.equal(source, serializeMerkleVectors(generateMerkleVectors(fixture.input)));
  assert.equal(fixture.leafType, MESSAGE_MERKLE_LEAF_TYPE);
  assert.equal(fixture.nodeType, MESSAGE_MERKLE_NODE_TYPE);
  assert.equal(fixture.leafDomain, MESSAGE_MERKLE_LEAF_DOMAIN);
  assert.equal(fixture.nodeDomain, MESSAGE_MERKLE_NODE_DOMAIN);
  assert.ok(fixture.vectors.some((vector) => vector.batch.messageIds.some((id) => BigInt(id) >= (1n << 255n))));
  assert.ok(BigInt(fixture.input.context.epoch) > BigInt(Number.MAX_SAFE_INTEGER));
  console.log("VALID: committed Merkle golden fixture is stable; domains match fixed bytes32 values");
});

for (const [vectorIndex, vector] of fixture.vectors.entries()) {
  test(`${vector.name}: leaves, internal nodes, roots, and every proof match shared golden values`, () => {
    const batch = buildMessageBatch(vector.batch);
    assert.equal(serializeMerkleVectors(batch), serializeMerkleVectors(vector.batch));
    const tree = buildMessageMerkleTree(batch);
    assert.deepEqual(tree.leaves, vector.leaves);
    assert.equal(tree.messageRoot, vector.messageRoot);
    assert.deepEqual(tree.proofs.map((proof) => ({ ...proof, expectedValid: true })), vector.proofs);
    assert.deepEqual(vector.levels[0], vector.leaves);
    assert.deepEqual(vector.levels.at(-1), [vector.messageRoot]);
    for (let index = 0; index < vector.leafCount; index += 1) {
      const encoded = encodeAbiParameters(LEAF_ABI, [fixture.leafDomain, batch.batchId, BigInt(index), batch.messageIds[index]]);
      assert.equal(encoded, vector.leafPreimages[index]);
      assert.equal(keccak256(encoded), vector.leaves[index]);
      assert.equal(computeMessageMerkleLeaf({ batchId: batch.batchId, index, messageId: batch.messageIds[index] }), vector.leaves[index]);
      assert.equal(verifyMessageMerkleProof(proofInput(vector, index)), vector.proofs[index].expectedValid);
    }
    for (let level = 0; level < vector.levels.length - 1; level += 1) {
      const children = vector.levels[level];
      for (let index = 0; index < children.length; index += 2) {
        const left = children[index];
        const right = children[index + 1] ?? left;
        const expected = vector.levels[level + 1][index / 2];
        assert.equal(computeMessageMerkleNode(left, right), expected);
        assert.equal(keccak256(encodeAbiParameters(NODE_ABI, [fixture.nodeDomain, left, right])), expected);
        if (left !== right) assert.notEqual(computeMessageMerkleNode(right, left), expected);
      }
    }
    console.log(`VALID: off-chain Merkle leaves, nodes, root, and proofs match shared golden vector ${vector.name}`);
  });

  test(`${vector.name}: shared-fixture proof mutations fail closed`, () => {
    const otherVector = fixture.vectors[(vectorIndex + 1) % fixture.vectors.length];
    for (let index = 0; index < vector.leafCount; index += 1) {
      const input = proofInput(vector, index);
      const proof = input.proof;
      const mutations = [
        { ...input, proof: { ...proof, batchId: flip(proof.batchId) } },
        { ...input, proof: { ...proof, messageId: flip(proof.messageId) } },
        { ...input, proof: { ...proof, index: vector.leafCount === 1 ? 1 : (index + 1) % vector.leafCount } },
        { ...input, proof: { ...proof, leafCount: proof.leafCount + 1 } },
        { ...input, proof: { ...proof, leafCount: 0 } },
        { ...input, messageRoot: flip(vector.messageRoot) },
        { ...input, proof: { ...proof, siblings: [...proof.siblings, flip(vector.messageRoot)] } },
        { ...input, proof: otherVector.proofs[0] },
      ];
      if (vector.leafCount > 1) mutations.push({ ...input, proof: vector.proofs[(index + 1) % vector.leafCount] });
      if (proof.siblings.length > 0) {
        mutations.push({ ...input, proof: { ...proof, siblings: proof.siblings.slice(0, -1) } });
        mutations.push({ ...input, proof: { ...proof, siblings: [flip(proof.siblings[0]), ...proof.siblings.slice(1)] } });
      }
      if (proof.siblings.length > 1) {
        mutations.push({ ...input, proof: { ...proof, siblings: [...proof.siblings].reverse() } });
      }
      for (const invalid of mutations) assert.equal(verifyMessageMerkleProof(invalid), false);
    }
  });
}

test("odd duplication rejects an alternate sibling even with its matching forged root", () => {
  for (const vector of fixture.vectors.filter((entry) => entry.leafCount === 3 || entry.leafCount === 5)) {
    const input = proofInput(vector, vector.leafCount - 1);
    const siblings = [flip(input.proof.siblings[0]), ...input.proof.siblings.slice(1)];
    let node = vector.leaves.at(-1);
    let position = input.proof.index;
    for (const sibling of siblings) {
      node = position % 2 === 0 ? computeMessageMerkleNode(node, sibling) : computeMessageMerkleNode(sibling, node);
      position = Math.floor(position / 2);
    }
    assert.equal(verifyMessageMerkleProof({ ...input, proof: { ...input.proof, siblings }, messageRoot: node }), false);
  }
});

test("fixed preimages detect SHA3, narrowed index, and sorted-pair drift", () => {
  const probe = fixture.encodingProbe;
  const args = [fixture.leafDomain, probe.batchId, BigInt(probe.index), probe.messageId];
  assert.equal(encodeAbiParameters(LEAF_ABI, args), probe.preimage);
  assert.equal(computeMessageMerkleLeaf(probe), probe.expectedLeaf);
  assert.equal(keccak256(probe.preimage), probe.expectedLeaf);
  const sha3 = `0x${createHash("sha3-256").update(Buffer.from(probe.preimage.slice(2), "hex")).digest("hex")}`;
  assert.equal(sha3, probe.sha3LeafHash);
  assert.notEqual(sha3, probe.expectedLeaf);
  const truncatedIndex = BigInt(probe.index) % (1n << 32n);
  assert.notEqual(keccak256(encodeAbiParameters(parseAbiParameters("bytes32,bytes32,uint32,bytes32"), [
    fixture.leafDomain, probe.batchId, truncatedIndex, probe.messageId,
  ])), probe.expectedLeaf);
  assert.notEqual(keccak256(encodePacked(["bytes32", "bytes32", "uint32", "bytes32"], [
    fixture.leafDomain, probe.batchId, Number(truncatedIndex), probe.messageId,
  ])), probe.expectedLeaf);
  // These specific all-32-byte inputs have identical packed and standard bytes.
  assert.equal(encodePacked(["bytes32", "bytes32", "uint256", "bytes32"], args), probe.preimage);
  let descendingPair = false;
  for (const vector of fixture.vectors) {
    for (let level = 0; level < vector.levels.length - 1; level += 1) {
      const children = vector.levels[level];
      for (let index = 0; index + 1 < children.length; index += 2) {
        if (children[index] > children[index + 1]) {
          descendingPair = true;
          assert.notEqual(computeMessageMerkleNode(children[index + 1], children[index]), vector.levels[level + 1][index / 2]);
        }
      }
    }
  }
  assert.equal(descendingPair, true, "golden cases must expose sorted-pair drift");
});
