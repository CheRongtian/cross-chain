import assert from "node:assert/strict";
import test from "node:test";

import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import { buildMessageBatch, MESSAGE_BATCH_TYPEHASH } from "../src/message-batch.mjs";
import {
  buildMessageMerkleTree,
  computeMessageMerkleLeaf,
  computeMessageMerkleNode,
  MESSAGE_MERKLE_LEAF_DOMAIN,
  MESSAGE_MERKLE_NODE_DOMAIN,
  verifyMessageMerkleProof,
} from "../src/message-merkle.mjs";

const CONTEXT = {
  sourceDomain: 10_011n,
  sourceGateway: "0x0000000000000000000000000000000000001001",
  epoch: 7n,
};

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function finalizedMessage(index, overrides = {}) {
  const message = {
    version: 2n,
    sourceDomain: CONTEXT.sourceDomain,
    sourceGateway: CONTEXT.sourceGateway,
    sourceSender: "0x0000000000000000000000000000000000001002",
    destinationDomain: 2001n,
    destinationGateway: "0x0000000000000000000000000000000000002001",
    destinationReceiver: "0x0000000000000000000000000000000000002002",
    nonce: BigInt(index) + 1n,
    payload: "0x68656c6c6f",
    deadline: 2_000_000_000n,
    sourceBlockNumber: 10n,
    sourceBlockHash: hash(11n),
    sourceTransactionHash: hash(BigInt(index) + 100n),
    sourceLogIndex: BigInt(index),
    status: "FINALIZED",
    ...overrides,
  };
  message.payloadHash = computePayloadHash(message.payload);
  message.messageId = computeCanonicalMessageId(message);
  return message;
}

function makeBatch(count, context = {}) {
  return buildMessageBatch({
    ...CONTEXT,
    ...context,
    messages: Array.from({ length: count }, (_, index) => finalizedMessage(index)),
  });
}

function proofInput(batch, tree, index = 0) {
  return {
    batch,
    message: batch.messages[index],
    proof: tree.proofs[index],
    messageRoot: tree.messageRoot,
  };
}

test("leaf and node use distinct ABI domains and exact left/right encoding", () => {
  const batch = makeBatch(2);
  const leafDomain = keccak256(stringToHex(
    "MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)",
  ));
  const nodeDomain = keccak256(stringToHex(
    "MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)",
  ));
  const expectedLeaf = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,bytes32,uint256,bytes32"),
    [leafDomain, batch.batchId, 0n, batch.messageIds[0]],
  ));
  const expectedNode = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,bytes32,bytes32"),
    [nodeDomain, hash(1n), hash(2n)],
  ));

  assert.equal(MESSAGE_MERKLE_LEAF_DOMAIN, leafDomain);
  assert.equal(MESSAGE_MERKLE_NODE_DOMAIN, nodeDomain);
  assert.notEqual(leafDomain, nodeDomain);
  assert.notEqual(leafDomain, MESSAGE_BATCH_TYPEHASH);
  assert.notEqual(nodeDomain, MESSAGE_BATCH_TYPEHASH);
  assert.equal(computeMessageMerkleLeaf({
    batchId: batch.batchId, index: 0, messageId: batch.messageIds[0],
  }), expectedLeaf);
  assert.equal(computeMessageMerkleNode(hash(1n), hash(2n)), expectedNode);
  assert.notEqual(
    computeMessageMerkleNode(hash(1n), hash(2n)),
    computeMessageMerkleNode(hash(2n), hash(1n)),
  );
});

for (const count of [1, 2, 3, 4, 5, 7]) {
  test(`${count} messages produce deterministic roots and proofs for every position`, () => {
    const batch = makeBatch(count);
    const before = structuredClone(batch);
    const first = buildMessageMerkleTree(batch);
    const second = buildMessageMerkleTree(batch);
    const freshBatch = buildMessageBatch({ ...batch, messages: [...batch.messages].reverse() });
    const freshTree = buildMessageMerkleTree(freshBatch);

    assert.deepEqual(first, second);
    assert.deepEqual(first, freshTree);
    assert.deepEqual(batch, before);
    assert.equal(first.leafCount, count);
    assert.equal(first.proofs.length, count);
    assert.match(first.messageRoot, /^0x[0-9a-f]{64}$/);
    for (let index = 0; index < count; index += 1) {
      assert.equal(first.proofs[index].index, index);
      assert.equal(first.proofs[index].leafCount, count);
      assert.equal(verifyMessageMerkleProof(proofInput(batch, first, index)), true);
    }
  });
}

test("a single leaf is the root and has an empty proof path", () => {
  const batch = makeBatch(1);
  const tree = buildMessageMerkleTree(batch);
  assert.equal(tree.messageRoot, tree.leaves[0]);
  assert.deepEqual(tree.proofs[0].siblings, []);
  assert.equal(verifyMessageMerkleProof(proofInput(batch, tree)), true);
});

test("three leaves duplicate the last leaf and preserve ordered siblings", () => {
  const batch = makeBatch(3);
  const tree = buildMessageMerkleTree(batch);
  const [first, second, third] = tree.leaves;
  const left = computeMessageMerkleNode(first, second);
  const right = computeMessageMerkleNode(third, third);
  assert.equal(tree.messageRoot, computeMessageMerkleNode(left, right));
  assert.deepEqual(tree.proofs[0].siblings, [second, right]);
  assert.deepEqual(tree.proofs[1].siblings, [first, right]);
  assert.deepEqual(tree.proofs[2].siblings, [third, left]);
});

test("odd node duplication applies at every layer of a five-message tree", () => {
  const batch = makeBatch(5);
  const tree = buildMessageMerkleTree(batch);
  const [first, second, third, fourth, fifth] = tree.leaves;
  const firstParent = computeMessageMerkleNode(first, second);
  const secondParent = computeMessageMerkleNode(third, fourth);
  const lastParent = computeMessageMerkleNode(fifth, fifth);
  const left = computeMessageMerkleNode(firstParent, secondParent);
  const right = computeMessageMerkleNode(lastParent, lastParent);
  assert.equal(tree.messageRoot, computeMessageMerkleNode(left, right));
  assert.deepEqual(tree.proofs[4].siblings, [fifth, lastParent, left]);
});

test("leaf identity binds batch, position, and canonical message ID", () => {
  const batch = makeBatch(2);
  const input = { batchId: batch.batchId, index: 0, messageId: batch.messageIds[0] };
  const leaf = computeMessageMerkleLeaf(input);
  assert.notEqual(leaf, computeMessageMerkleLeaf({ ...input, index: 1 }));
  assert.notEqual(leaf, computeMessageMerkleLeaf({ ...input, batchId: makeBatch(2, { epoch: 8n }).batchId }));
  assert.notEqual(leaf, computeMessageMerkleLeaf({ ...input, messageId: batch.messageIds[1] }));
});

test("epoch, membership changes, and valid source-position changes alter the root", () => {
  const batch = makeBatch(3);
  const root = buildMessageMerkleTree(batch).messageRoot;
  assert.notEqual(root, buildMessageMerkleTree(makeBatch(3, { epoch: 8n })).messageRoot);
  assert.notEqual(root, buildMessageMerkleTree(makeBatch(2)).messageRoot);
  assert.notEqual(root, buildMessageMerkleTree(makeBatch(4)).messageRoot);
  const replaced = buildMessageBatch({
    ...batch,
    messages: [batch.messages[0], finalizedMessage(1, { nonce: 100n }), batch.messages[2]],
  });
  assert.notEqual(root, buildMessageMerkleTree(replaced).messageRoot);
  const swapped = buildMessageBatch({
    ...batch,
    messages: [
      { ...batch.messages[0], sourceLogIndex: 1n },
      { ...batch.messages[1], sourceLogIndex: 0n },
      batch.messages[2],
    ],
  });
  assert.deepEqual(swapped.messageIds, [batch.messageIds[1], batch.messageIds[0], batch.messageIds[2]]);
  assert.notEqual(root, buildMessageMerkleTree(swapped).messageRoot);
});

test("operational metadata and object property order do not affect the tree", () => {
  const batch = makeBatch(3);
  const decorated = Object.fromEntries(Object.entries({
    ...batch,
    id: "database batch metadata",
    messages: batch.messages.map((message) => Object.fromEntries(Object.entries({
      ...message, id: "99", observed_at: "2000-01-01", finalized_at: "2030-01-01",
    }).reverse())),
  }).reverse());
  assert.deepEqual(buildMessageMerkleTree(decorated), buildMessageMerkleTree(batch));
});

test("tree construction rejects empty, forged, reordered, and non-finalized batches", () => {
  const batch = makeBatch(3);
  const invalidBatches = [
    undefined,
    { ...batch, messages: [], messageIds: [] },
    { ...batch, batchId: hash(999n) },
    { ...batch, epoch: 8n },
    { ...batch, messageIds: ["0x00", ...batch.messageIds.slice(1)] },
    { ...batch, messages: [...batch.messages].reverse() },
    { ...batch, messages: [...batch.messages].reverse(), messageIds: [...batch.messageIds].reverse() },
    { ...batch, messages: [batch.messages[0], ...batch.messages], messageIds: [batch.messageIds[0], ...batch.messageIds] },
    { ...batch, messages: [{ ...batch.messages[0], nonce: 99n }, ...batch.messages.slice(1)] },
    { ...batch, messages: [{ ...batch.messages[0], status: "REORGED" }, ...batch.messages.slice(1)] },
  ];
  for (const invalid of invalidBatches) {
    assert.throws(() => buildMessageMerkleTree(invalid));
  }
});

test("message mutation with a stale canonical ID fails proof verification", () => {
  const batch = makeBatch(3);
  const tree = buildMessageMerkleTree(batch);
  const input = proofInput(batch, tree, 1);
  const changedPayload = "0x00";
  for (const message of [
    { ...input.message, nonce: input.message.nonce + 1n },
    { ...input.message, deadline: input.message.deadline + 1n },
    { ...input.message, payload: changedPayload, payloadHash: computePayloadHash(changedPayload) },
    { ...input.message, sourceBlockHash: hash(999n) },
    { ...input.message, status: "REORGED" },
  ]) {
    assert.equal(verifyMessageMerkleProof({ ...input, message }), false);
  }
});

test("wrong roots, batch contexts, message proofs, and indices fail closed", () => {
  const batch = makeBatch(3);
  const tree = buildMessageMerkleTree(batch);
  const input = proofInput(batch, tree, 1);
  const anotherBatch = makeBatch(3, { epoch: 8n });
  const anotherTree = buildMessageMerkleTree(anotherBatch);
  const invalidInputs = [
    { ...input, messageRoot: hash(999n) },
    { ...input, proof: tree.proofs[0] },
    { ...input, message: batch.messages[0] },
    { ...input, proof: anotherTree.proofs[1] },
    { ...input, batch: anotherBatch },
    { ...input, batch: { ...batch, epoch: 8n } },
    { ...input, proof: { ...input.proof, batchId: hash(999n) } },
    { ...input, proof: { ...input.proof, messageId: batch.messageIds[0] } },
    { ...input, proof: { ...input.proof, index: 0 } },
    { ...input, proof: { ...input.proof, leafCount: 4 } },
  ];
  for (const invalid of invalidInputs) {
    assert.equal(verifyMessageMerkleProof(invalid), false);
  }
});

test("tampered, truncated, extended, and malformed proof paths fail closed", () => {
  const batch = makeBatch(3);
  const tree = buildMessageMerkleTree(batch);
  const input = proofInput(batch, tree);
  for (const siblings of [
    [hash(999n), input.proof.siblings[1]],
    [...input.proof.siblings].reverse(),
    input.proof.siblings.slice(0, -1),
    [...input.proof.siblings, hash(999n)],
    ["0x00", input.proof.siblings[1]],
    ["00".repeat(32), input.proof.siblings[1]],
    [`0x${"zz".repeat(32)}`, input.proof.siblings[1]],
    [null, input.proof.siblings[1]],
    undefined,
  ]) {
    assert.equal(verifyMessageMerkleProof({ ...input, proof: { ...input.proof, siblings } }), false);
  }
});

test("odd-node verification enforces duplication even with a matching forged root", () => {
  const batch = makeBatch(3);
  const tree = buildMessageMerkleTree(batch);
  const input = proofInput(batch, tree, 2);
  const fakeSibling = hash(999n);
  const fakeParent = computeMessageMerkleNode(tree.leaves[2], fakeSibling);
  const forgedRoot = computeMessageMerkleNode(input.proof.siblings[1], fakeParent);
  assert.equal(verifyMessageMerkleProof({
    ...input,
    proof: { ...input.proof, siblings: [fakeSibling, input.proof.siblings[1]] },
    messageRoot: forgedRoot,
  }), false);
});

test("index and bytes32 validation rejects coercion and out-of-range inputs", () => {
  const batch = makeBatch(2);
  const tree = buildMessageMerkleTree(batch);
  const input = proofInput(batch, tree);
  for (const index of [-1, 0.5, "0", 0n, null, 2, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(verifyMessageMerkleProof({ ...input, proof: { ...input.proof, index } }), false);
  }
  for (const root of [null, "0x00", "00".repeat(32), `0x${"gg".repeat(32)}`]) {
    assert.equal(verifyMessageMerkleProof({ ...input, messageRoot: root }), false);
  }
  assert.equal(verifyMessageMerkleProof(undefined), false);
  assert.equal(verifyMessageMerkleProof({ ...input, proof: null }), false);
  assert.throws(() => computeMessageMerkleLeaf({ batchId: batch.batchId, index: "0", messageId: batch.messageIds[0] }));
  assert.throws(() => computeMessageMerkleLeaf({ batchId: "0x00", index: 0, messageId: batch.messageIds[0] }));
  assert.throws(() => computeMessageMerkleNode(hash(1n), "0x00"));
});

test("large protocol integers stay exact while proof indices remain safe array positions", () => {
  const large = (1n << 200n) + 1n;
  const batch = buildMessageBatch({
    ...CONTEXT,
    sourceDomain: large,
    epoch: large + 1n,
    messages: [finalizedMessage(0, {
      sourceDomain: large,
      destinationDomain: large + 2n,
      nonce: large + 3n,
      deadline: large + 4n,
      sourceBlockNumber: large + 5n,
      sourceLogIndex: large + 6n,
    })],
  });
  const tree = buildMessageMerkleTree(batch);
  assert.equal(batch.epoch, large + 1n);
  assert.equal(batch.messages[0].sourceBlockNumber, large + 5n);
  assert.equal(tree.proofs[0].index, 0);
  assert.equal(verifyMessageMerkleProof(proofInput(batch, tree)), true);
});
