import assert from "node:assert/strict";
import { computeCanonicalMessageId, computePayloadHash, normalizeCanonicalMessage, validateCanonicalMessage } from "../../src/canonical-message.mjs";
import { computeMessageBatchId, validateMessageBatch } from "../../src/message-batch.mjs";
import { buildMessageMerkleTree, computeMessageMerkleLeaf, computeMessageMerkleNode, computeMessageMerkleRoot,
  verifyCommittedMessageMerkleProof, verifyMessageMerkleProof } from "../../src/message-merkle.mjs";
import { deliveryJson, verifyDeliveryPackage } from "../../src/delivery/package.mjs";

const maximum = (1n << 256n) - 1n;
const otherInteger = value => value === maximum ? value - 1n : value + 1n;
const otherAddress = value => `0x${(BigInt(value) ^ 1n).toString(16).padStart(40, "0")}`;
export const integrityClone = value => JSON.parse(deliveryJson(value));

// Assertions/attacker candidates only. All normalization, identity, payload,
// batch, leaf, node and proof operations call the existing production helpers.
export function assertCanonicalIdentity(message, expectedId) {
  const canonical = validateCanonicalMessage(message, expectedId);
  const baseline = normalizeCanonicalMessage(canonical);
  assert.equal(computeCanonicalMessageId(message), expectedId);
  assert.equal(computeCanonicalMessageId({ ...message }), expectedId);
  assert.equal(computeCanonicalMessageId(integrityClone(message)), expectedId);
  const reversed = Object.fromEntries(Object.entries(message).reverse());
  assert.equal(computeCanonicalMessageId(reversed), expectedId);
  assert.equal(computeCanonicalMessageId({ ...message, status: "UNRELATED_OPERATIONAL_STATE", observedAt: "2030-01-01T00:00:00Z",
    sourceBlockNumber: 999999999999999999999n, sourceBlockHash: `0x${"ab".repeat(32)}`,
    sourceTransactionHash: `0x${"cd".repeat(32)}`, sourceLogIndex: 99n, databaseId: "123", batchId: "operational", position: 77,
    relayerMetadata: { worker: "unrelated" } }), expectedId);
  assert.deepEqual(normalizeCanonicalMessage(reversed), baseline);
  return baseline;
}

export function canonicalFieldMutations(message) {
  const canonical = normalizeCanonicalMessage(message);
  return ["sourceDomain", "destinationDomain", "sourceGateway", "sourceSender", "destinationGateway", "destinationReceiver", "nonce", "deadline", "version"]
    .map(field => {
      const value = field === "version" ? (canonical.version === 2n ? 1n : 2n) :
        typeof canonical[field] === "bigint" ? otherInteger(canonical[field]) : otherAddress(canonical[field]);
      const candidate = { ...canonical, [field]: value };
      assert.deepEqual(Object.keys(canonical).filter(key => canonical[key] !== candidate[key]), [field]);
      const messageId = computeCanonicalMessageId(candidate);
      assert.notEqual(messageId, computeCanonicalMessageId(canonical), `${field} must change the authenticated ID`);
      return { field, message: { ...candidate, messageId } };
    });
}

export function payloadMutation(message) {
  const canonical = normalizeCanonicalMessage(message);
  assert.ok(canonical.payload.length > 2, "the fixed integrity probe needs one payload byte");
  const byte = (BigInt(canonical.payload.slice(0, 4)) ^ 1n).toString(16).padStart(2, "0");
  const payload = `0x${byte}${canonical.payload.slice(4)}`;
  assert.equal(payload.length, canonical.payload.length, "mutation must not become a payload-size rejection");
  const payloadHash = computePayloadHash(payload);
  assert.notEqual(payloadHash, canonical.payloadHash);
  assert.throws(() => validateCanonicalMessage({ ...canonical, payload }, message.messageId), /payload hash does not match/);
  const candidate = { ...canonical, payload, payloadHash };
  const messageId = computeCanonicalMessageId(candidate);
  assert.notEqual(messageId, message.messageId);
  assert.throws(() => validateCanonicalMessage(candidate, message.messageId), /canonical message ID mismatch/);
  for (const field of Object.keys(canonical).filter(key => !["payload", "payloadHash"].includes(key))) assert.equal(candidate[field], canonical[field]);
  return { ...candidate, messageId };
}

// Fold attacker evidence with production leaf/node functions. This is not an
// acceptance verifier: acceptance is checked separately by production verifiers.
export function rootUsingOriginalPath(messageId, proof) {
  let position = BigInt(proof.index);
  let node = computeMessageMerkleLeaf({ batchId: proof.batchId, index: proof.index, messageId });
  for (const sibling of proof.siblings) {
    node = position % 2n === 0n ? computeMessageMerkleNode(node, sibling) : computeMessageMerkleNode(sibling, node);
    position /= 2n;
  }
  return node;
}

export function assertMerkleIntegrity({ batch, tree = buildMessageMerkleTree(batch), index = 0 }) {
  const before = deliveryJson({ batch, tree });
  const canonical = validateMessageBatch(batch);
  const original = canonical.messages[index]; const proof = tree.proofs[index];
  assertCanonicalIdentity(original, canonical.messageIds[index]);
  assert.equal(computeMessageMerkleRoot(canonical), tree.messageRoot);
  const leaf = computeMessageMerkleLeaf({ batchId: canonical.batchId, index, messageId: original.messageId });
  assert.equal(leaf, tree.leaves[index]);
  assert.equal(rootUsingOriginalPath(original.messageId, proof), tree.messageRoot);
  const commitment = { version: canonical.version, sourceDomain: canonical.sourceDomain, sourceGateway: canonical.sourceGateway,
    epoch: canonical.epoch, batchId: canonical.batchId, messageIds: canonical.messageIds };
  const verify = message => verifyCommittedMessageMerkleProof({ commitment, message, proof, messageRoot: tree.messageRoot });
  assert.equal(verify(original), true);
  assert.equal(verifyMessageMerkleProof({ batch: canonical, message: original, proof, messageRoot: tree.messageRoot }), true);
  const changedPayload = payloadMutation(original);
  assert.equal(verify({ ...changedPayload, messageId: original.messageId }), false);
  const mutations = [...canonicalFieldMutations(original), { field: "payload", message: changedPayload }];
  for (const { field, message } of mutations) {
    assert.equal(verify(message), false, `${field} mutation must not reuse the committed proof`);
    assert.equal(verifyMessageMerkleProof({ batch: canonical, message: { ...original, ...message }, proof, messageRoot: tree.messageRoot }), false);
    const changedLeaf = computeMessageMerkleLeaf({ batchId: canonical.batchId, index, messageId: message.messageId });
    assert.notEqual(changedLeaf, leaf);
    assert.notEqual(rootUsingOriginalPath(message.messageId, proof), tree.messageRoot);
    const ids = canonical.messageIds.map((id, position) => position === index ? message.messageId : id);
    const changedBatch = { ...commitment, messageIds: ids };
    if (new Set(ids).size !== ids.length) {
      // A one-field mutation can become another existing member (e.g. nonce
      // 1 -> 2). Its old position/proof still fails above; a replacement batch
      // containing that ID twice is rejected by the production constructor.
      assert.throws(() => computeMessageBatchId(changedBatch), { message: "duplicate message ID in batch" });
    } else {
      changedBatch.batchId = computeMessageBatchId(changedBatch);
      assert.notEqual(changedBatch.batchId, canonical.batchId);
      assert.notEqual(computeMessageMerkleRoot(changedBatch), tree.messageRoot);
    }
  }
  assert.equal(verify(original), true);
  assert.equal(deliveryJson({ batch, tree }), before, "negative candidates must not change the original immutable evidence");
  return { original, proof, leaf, messageRoot: tree.messageRoot, changedPayload, mutations };
}

export async function assertCommittedPackageIntegrity({ snapshot, pack, validatorSets }) {
  assert.equal(snapshot.record.status, "COMMITTED");
  assert.equal(snapshot.record.messageRoot, snapshot.tree.messageRoot);
  assert.equal(snapshot.quorumCertificate.messageRoot, snapshot.record.messageRoot);
  const before = deliveryJson({ snapshot, pack });
  assert.deepEqual(await verifyDeliveryPackage(pack, { validatorSets }), pack);
  const evidence = assertMerkleIntegrity({ batch: snapshot.batch, tree: snapshot.tree, index: pack.messageIndex });
  assert.equal(snapshot.members[pack.messageIndex].messageId, evidence.original.messageId);
  assert.equal(BigInt(snapshot.members[pack.messageIndex].position), BigInt(pack.messageIndex));
  assert.equal(pack.message.messageId, evidence.original.messageId);
  assert.equal(pack.messageRoot, evidence.messageRoot);
  assert.deepEqual(pack.merkleProof, integrityClone(evidence.proof));
  for (const staleHash of [true, false]) {
    const candidate = integrityClone(pack);
    candidate.message.payload = evidence.changedPayload.payload;
    if (!staleHash) candidate.message.payloadHash = evidence.changedPayload.payloadHash;
    await assert.rejects(() => verifyDeliveryPackage(candidate, { validatorSets }),
      staleHash ? /payload hash does not match/ : /canonical message ID mismatch/);
  }
  const candidate = integrityClone(pack);
  candidate.message = integrityClone(evidence.changedPayload);
  await assert.rejects(() => verifyDeliveryPackage(candidate, { validatorSets }), { code: "INVALID_DELIVERY_MERKLE_PROOF" });
  candidate.merkleProof.messageId = candidate.message.messageId;
  await assert.rejects(() => verifyDeliveryPackage(candidate, { validatorSets }), { code: "INVALID_DELIVERY_MERKLE_PROOF" });
  assert.deepEqual(await verifyDeliveryPackage(pack, { validatorSets }), pack);
  assert.equal(deliveryJson({ snapshot, pack }), before);
  return evidence;
}
