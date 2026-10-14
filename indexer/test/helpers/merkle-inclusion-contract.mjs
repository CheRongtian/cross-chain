import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeAddress, normalizeBytes32 } from "../../src/canonical-message.mjs";
import { computeMessageBatchId } from "../../src/message-batch.mjs";
import { computeMessageMerkleLeaf, computeMessageMerkleNode } from "../../src/message-merkle.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export const flipMerkleHash = (hash) => `0x${(BigInt(hash) ^ 1n).toString(16).padStart(64, "0")}`;

function exactUint(value, label) {
  if (typeof value === "number") {
    assert.ok(Number.isSafeInteger(value) && value >= 0, `${label} must be an exact uint256`);
    value = BigInt(value);
  }
  return protocolInteger(value, label);
}

// Verification-only ABI adapter. No index/count is narrowed to Number, even for rejection cases.
export function inclusionArguments(input) {
  const batch = input.batchContext;
  const version = exactUint(batch.version, "batch version");
  assert.ok(version <= 255n, "batch version must fit uint8");
  return [{ version: Number(version), sourceDomain: exactUint(batch.sourceDomain, "source domain"),
    sourceGateway: normalizeAddress(batch.sourceGateway), epoch: exactUint(batch.epoch, "batch epoch"),
    batchId: normalizeBytes32(batch.batchId) }, normalizeBytes32(input.messageRoot),
  normalizeBytes32(input.messageId), exactUint(input.index, "expected index"),
  input.orderedMessageIds.map((id) => normalizeBytes32(id)),
  { batchId: normalizeBytes32(input.proof.batchId), messageId: normalizeBytes32(input.proof.messageId),
    index: exactUint(input.proof.index, "proof index"), leafCount: exactUint(input.proof.leafCount, "proof count"),
    siblings: input.proof.siblings.map((hash) => normalizeBytes32(hash, "Merkle proof sibling")) }];
}

export function goldenInclusion(vector, index) {
  return { batchContext: { version: vector.batch.version, sourceDomain: vector.batch.sourceDomain,
    sourceGateway: vector.batch.sourceGateway, epoch: vector.batch.epoch, batchId: vector.batch.batchId },
  messageRoot: vector.messageRoot, messageId: vector.batch.messageIds[index], index,
  orderedMessageIds: vector.batch.messageIds, proof: vector.proofs[index] };
}

// The caller must first authenticate this exact expected context/root with the independent QC verifier.
// Use the already reconstructed committed snapshot once; do not rebuild a full tree for each member.
export function snapshotInclusions(snapshot, expected) {
  assert.equal(snapshot.record.status, "COMMITTED");
  assert.equal(snapshot.batch.batchId, expected.batchId);
  assert.equal(snapshot.record.batchId, expected.batchId);
  assert.equal(snapshot.record.messageRoot, expected.messageRoot);
  assert.equal(snapshot.tree.messageRoot, expected.messageRoot);
  assert.equal(snapshot.batch.sourceDomain.toString(), expected.sourceDomain.toString());
  assert.equal(snapshot.batch.sourceGateway, expected.sourceGateway);
  assert.equal(snapshot.batch.epoch.toString(), expected.batchEpoch.toString());
  const ids = snapshot.batch.messageIds;
  assert.equal(BigInt(ids.length), BigInt(snapshot.record.messageCount));
  assert.equal(snapshot.tree.proofs.length, ids.length);
  assert.equal(snapshot.members.length, ids.length);
  return ids.map((messageId, index) => {
    assert.equal(snapshot.members[index].messageId, messageId);
    assert.equal(BigInt(snapshot.members[index].position), BigInt(index));
    return { batchContext: { version: snapshot.batch.version, sourceDomain: expected.sourceDomain,
      sourceGateway: expected.sourceGateway, epoch: expected.batchEpoch, batchId: expected.batchId },
    messageRoot: expected.messageRoot, messageId, index, orderedMessageIds: ids, proof: snapshot.tree.proofs[index] };
  });
}

// Test-only construction of a forged matching root. It intentionally omits odd-sibling enforcement.
export function forgedPathRoot(input, proof = input.proof) {
  let position = exactUint(proof.index, "forgery index");
  assert.ok(position < BigInt(input.orderedMessageIds.length), "forgery index outside actual membership");
  let node = computeMessageMerkleLeaf({ batchId: input.batchContext.batchId,
    index: Number(position), messageId: input.messageId });
  for (const sibling of proof.siblings) {
    node = position % 2n === 0n ? computeMessageMerkleNode(node, sibling) : computeMessageMerkleNode(sibling, node);
    position /= 2n;
  }
  return node;
}

export async function createMerkleInclusionChecks({ client, address }) {
  const artifact = JSON.parse(readFileSync(new URL(
    "../../../contracts/out/MerkleInclusionVerifier.sol/MerkleInclusionVerifier.json", import.meta.url), "utf8"));
  const abi = artifact.abi;
  const read = (input) => client.readContract({ address, abi, functionName: "verifyInclusion", args: inclusionArguments(input) });
  async function accept(input, label) {
    assert.equal(await read(input), true, label);
    console.log(`VALID: Chain B Merkle inclusion / ${label}`);
  }
  async function reject(input, errorName, errorArgs, label) {
    await assert.rejects(() => read(input), (error) => {
      // Timeout, unrelated revert and successful acceptance must never satisfy a negative case.
      for (let cause = error; cause; cause = cause.cause) {
        if (cause.data?.errorName === errorName) {
          assert.deepEqual(cause.data.args ?? [], errorArgs, `${label}: custom-error arguments`);
          return true;
        }
      }
      return false;
    }, label);
    console.log(`EXPECTED FAILURE: Chain B Merkle inclusion / ${label} (${errorName})`);
  }
  async function members(inputs, label) {
    for (const input of inputs) await accept(input, `${label} / member ${input.index} of ${inputs.length}`);
  }
  async function negatives(inputs, label) {
    const input = inputs[0];
    const count = BigInt(input.orderedMessageIds.length);
    const index = BigInt(input.index);
    const root = input.messageRoot;
    const batchId = input.batchContext.batchId;
    const changedBatchId = flipMerkleHash(batchId);
    await reject({ ...input, messageRoot: flipMerkleHash(root) }, "MerkleRootMismatch", [flipMerkleHash(root), root], `${label} / wrong trusted root`);
    await reject({ ...input, messageId: flipMerkleHash(input.messageId) }, "MemberMessageIdMismatch",
      [index, flipMerkleHash(input.messageId), input.messageId], `${label} / wrong message ID`);
    for (const badIndex of [count, (1n << 53n) + 1n, (1n << 256n) - 1n]) {
      await reject({ ...input, index: badIndex }, "MessageIndexOutOfBounds", [badIndex, count], `${label} / out-of-range uint256 position ${badIndex}`);
    }
    await reject({ ...input, proof: { ...input.proof, index: count } }, "ProofIndexMismatch", [index, count], `${label} / inconsistent proof position`);
    await reject({ ...input, proof: { ...input.proof, batchId: changedBatchId } }, "ProofBatchIdMismatch",
      [batchId, changedBatchId], `${label} / proof from another batch`);
    await reject({ ...input, proof: { ...input.proof, messageId: flipMerkleHash(input.messageId) } }, "ProofMessageIdMismatch",
      [input.messageId, flipMerkleHash(input.messageId)], `${label} / inconsistent proof message`);
    for (const claimedCount of [0n, count + 1n]) {
      await reject({ ...input, proof: { ...input.proof, leafCount: claimedCount } }, "ProofLeafCountMismatch",
        [count, claimedCount], `${label} / untrusted proof count ${claimedCount}`);
    }
    await reject({ ...input, batchContext: { ...input.batchContext, batchId: changedBatchId } }, "BatchIdMismatch",
      [changedBatchId, batchId], `${label} / supplied batch ID not canonical`);
    for (const [field, value] of [["sourceDomain", BigInt(input.batchContext.sourceDomain) ^ 1n],
      ["sourceGateway", "0x000000000000000000000000000000000000bEEF"],
      ["epoch", BigInt(input.batchContext.epoch) ^ 1n]]) {
      const batchContext = { ...input.batchContext, [field]: value };
      const actual = computeMessageBatchId({ ...batchContext, messageIds: input.orderedMessageIds });
      await reject({ ...input, batchContext }, "BatchIdMismatch", [batchId, actual], `${label} / wrong batch ${field}`);
    }
    const changedIds = [...input.orderedMessageIds];
    changedIds[changedIds.length - 1] = flipMerkleHash(changedIds.at(-1));
    await reject({ ...input, orderedMessageIds: changedIds }, "BatchIdMismatch",
      [batchId, computeMessageBatchId({ ...input.batchContext, messageIds: changedIds })], `${label} / changed ordered membership`);
    await reject({ ...input, orderedMessageIds: [] }, "EmptyMessageBatch", [], `${label} / empty batch`);
    await reject({ ...input, batchContext: { ...input.batchContext, version: 2 } }, "UnsupportedBatchVersion", [2], `${label} / unsupported batch encoding`);
    if (count > 1n) {
      const reversed = [...input.orderedMessageIds].reverse();
      await reject({ ...input, orderedMessageIds: reversed }, "BatchIdMismatch",
        [batchId, computeMessageBatchId({ ...input.batchContext, messageIds: reversed })], `${label} / reordered membership`);
      const duplicated = [...input.orderedMessageIds];
      duplicated[duplicated.length - 1] = duplicated[0];
      await reject({ ...input, orderedMessageIds: duplicated }, "DuplicateMessageId", [duplicated[0]], `${label} / duplicate membership`);
      await reject({ ...input, index: 1n }, "MemberMessageIdMismatch", [1n, input.messageId, input.orderedMessageIds[1]], `${label} / wrong in-range position`);
    }
    const depth = BigInt(input.proof.siblings.length);
    await reject({ ...input, proof: { ...input.proof, siblings: [...input.proof.siblings, flipMerkleHash(root)] } },
      "InvalidProofLength", [depth, depth + 1n], `${label} / extended path`);
    if (depth > 0n) {
      await reject({ ...input, proof: { ...input.proof, siblings: input.proof.siblings.slice(0, -1) } },
        "InvalidProofLength", [depth, depth - 1n], `${label} / truncated path`);
      const proof = { ...input.proof, siblings: [flipMerkleHash(input.proof.siblings[0]), ...input.proof.siblings.slice(1)] };
      await reject({ ...input, proof }, "MerkleRootMismatch", [root, forgedPathRoot(input, proof)], `${label} / tampered sibling`);
    }
    if (depth > 1n) {
      const proof = { ...input.proof, siblings: [...input.proof.siblings].reverse() };
      await reject({ ...input, proof }, "MerkleRootMismatch", [root, forgedPathRoot(input, proof)], `${label} / reordered path`);
    }
    const last = inputs.at(-1);
    let position = BigInt(last.index);
    let width = count;
    for (let level = 0; level < last.proof.siblings.length; level += 1) {
      if (position % 2n === 0n && position === width - 1n) {
        const proof = { ...last.proof, siblings: [...last.proof.siblings] };
        const expected = proof.siblings[level];
        proof.siblings[level] = flipMerkleHash(expected);
        await reject({ ...last, proof, messageRoot: forgedPathRoot(last, proof) }, "InvalidOddSibling",
          [BigInt(level), expected, proof.siblings[level]], `${label} / odd-duplication forgery at level ${level}, matching forged root`);
      }
      position /= 2n;
      width = width / 2n + width % 2n;
    }
  }
  return { accept, reject, members, negatives,
    readPrimitive: (functionName, args) => client.readContract({ address, abi, functionName, args }) };
}
