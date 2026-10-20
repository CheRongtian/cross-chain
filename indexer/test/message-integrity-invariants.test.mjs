import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { decodeAbiParameters } from "viem";
import { computeCanonicalMessageId, computePayloadHash, normalizeCanonicalMessage } from "../src/canonical-message.mjs";
import { buildMessageBatch, computeMessageBatchId } from "../src/message-batch.mjs";
import { buildMessageMerkleTree, verifyCommittedMessageMerkleProof } from "../src/message-merkle.mjs";
import { deliveryJson } from "../src/delivery/package.mjs";
import { encodeGatewaySubmission, ENVELOPE_PARAMETERS, MESSAGE_PARAMETERS } from "../src/relayer/encoding.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { assertCanonicalIdentity, assertMerkleIntegrity, assertCommittedPackageIntegrity, canonicalFieldMutations } from "./helpers/message-integrity.mjs";
import { deliveryMessage, deliveryScope } from "./helpers/delivery-fixtures.mjs";

const golden = JSON.parse(readFileSync(new URL("../../test-vectors/merkle-golden-vectors.json", import.meta.url), "utf8"));
const wire = JSON.parse(readFileSync(new URL("../../test-vectors/destination-transport.json", import.meta.url), "utf8"));

test("canonical message ID is deterministic across equivalent objects, operational metadata and a fresh process", () => {
  for (const vector of golden.vectors) for (const message of vector.batch.messages) {
    assertCanonicalIdentity(message, message.messageId);
    const child = execFileSync(process.execPath, [fileURLToPath(new URL("./helpers/read-canonical-message.mjs", import.meta.url))],
      { input: deliveryJson(message), encoding: "utf8" });
    assert.deepEqual(JSON.parse(child), { messageId: message.messageId, payloadHash: message.payloadHash });
  }
  console.log("VALID: canonical message IDs match the read-only shared frozen matrix across repeated computation, property ordering, operational metadata and fresh processes");
});

test("source and destination domain mutations change only their own field and remain exact above 2^53", () => {
  const base = wire.package.message;
  const wide = { ...base, sourceDomain: (1n << 200n) + 10011n, destinationDomain: (1n << 200n) + 2001n,
    nonce: (1n << 240n) + 7n, deadline: (1n << 255n) + 3600n };
  for (const input of [base, wide]) {
    const id = computeCanonicalMessageId(input);
    assertCanonicalIdentity(input, id);
    const canonical = normalizeCanonicalMessage(input);
    for (const { field, message } of canonicalFieldMutations(input).filter(value => ["sourceDomain", "destinationDomain"].includes(value.field))) {
      assert.equal(message[field], canonical[field] + 1n);
      assert.notEqual(message.messageId, id);
      for (const name of Object.keys(canonical).filter(name => name !== field)) assert.equal(message[name], canonical[name]);
    }
  }
  console.log("VALID: isolated source-domain and destination-domain mutations change the actual message ID without changing unrelated fields");
  console.log("VALID: full-width uint256 domains, nonce and deadline remain exact; adjacent domain values cannot collide through Number truncation");
});

test("frozen committed membership rejects canonical field and payload mutations under the original root and proof", () => {
  for (const vector of golden.vectors) {
    const batch = buildMessageBatch(vector.batch); const tree = buildMessageMerkleTree(batch);
    assert.equal(tree.messageRoot, vector.messageRoot); assert.deepEqual(tree.leaves, vector.leaves);
    for (let index = 0; index < batch.messages.length; index++) assertMerkleIntegrity({ batch, tree, index });
  }
  console.log("VALID: original frozen messages verify under their original proofs; each selected field mutation changes the ID/leaf/root commitment");
  console.log("EXPECTED FAILURE: a payload-mutated canonical message with stale or recomputed ID cannot reuse the original membership proof/root");
});

test("a same-length mutation at the 4096-byte payload boundary is an integrity rejection, not a size rejection", () => {
  const base = golden.vectors[0].batch;
  const message = { ...base.messages[0], payload: `0x${"ab".repeat(4096)}` };
  message.payloadHash = computePayloadHash(message.payload); message.messageId = computeCanonicalMessageId(message);
  const batch = buildMessageBatch({ ...base, messages: [message] });
  const result = assertMerkleIntegrity({ batch });
  assert.equal((result.changedPayload.payload.length - 2) / 2, 4096);
  console.log("VALID: a one-byte content mutation remains within the unchanged payload bound and still invalidates the original proof");
});

test("a nonce mutation matching an existing member rejects the old position and duplicate batch without invalidating the other member", () => {
  const maximum = (1n << 256n) - 1n;
  for (const { nonces, expectedMembers } of [
    { nonces: [1n, 2n], expectedMembers: [1, -1] },
    { nonces: [1n, 2n, 3n], expectedMembers: [1, 2, -1] },
    { nonces: [maximum - 1n, maximum], expectedMembers: [1, 0] },
  ]) {
    const count = nonces.length;
    const batch = buildMessageBatch({ sourceDomain: deliveryScope.chainDomain, sourceGateway: deliveryScope.sourceGateway,
      epoch: 23n, messages: nonces.map((nonce, index) => deliveryMessage(index, { nonce })) });
    const tree = buildMessageMerkleTree(batch);
    const before = deliveryJson({ batch, tree });
    for (let index = 0; index < count; index++) {
      const evidence = assertMerkleIntegrity({ batch, tree, index });
      const changed = evidence.mutations.find(mutation => mutation.field === "nonce").message;
      const ids = batch.messageIds.map((id, position) => position === index ? changed.messageId : id);
      const other = expectedMembers[index];
      if (other >= 0) {
        assert.equal(changed.messageId, batch.messageIds[other]);
        assert.throws(() => computeMessageBatchId({ ...batch, messageIds: ids }), { message: "duplicate message ID in batch" });
        assert.equal(verifyCommittedMessageMerkleProof({ commitment: batch, message: changed,
          proof: tree.proofs[index], messageRoot: tree.messageRoot }), false);
        // That existing member remains legitimate at its own committed position.
        assert.equal(verifyCommittedMessageMerkleProof({ commitment: batch, message: changed,
          proof: tree.proofs[other], messageRoot: tree.messageRoot }), true);
      } else {
        assert.equal(batch.messageIds.includes(changed.messageId), false);
        assert.notEqual(computeMessageBatchId({ ...batch, messageIds: ids }), batch.batchId);
      }
    }
    assert.equal(deliveryJson({ batch, tree }), before);
  }
  console.log("VALID: existing-member substitutions fail at the original proof position; duplicate replacement batches are explicitly rejected, while legitimate original members still verify");
});

test("the frozen portable message retains its identity through production wire encoding and destination reconstruction", async () => {
  const options = { validatorSets: createValidatorSetResolver(wire.validatorHistory) };
  const encoded = await encodeGatewaySubmission(wire.package, options);
  assert.equal(encoded.data, wire.canonicalPackageBytes); assert.equal(encoded.calldata, wire.gatewayCalldata);
  assert.equal(encoded.packageDigest, wire.packageDigest);
  const envelope = decodeAbiParameters(ENVELOPE_PARAMETERS, encoded.data);
  const values = decodeAbiParameters(MESSAGE_PARAMETERS, envelope[3]);
  const [version, sourceDomain, sourceGateway, sourceSender, destinationDomain, destinationGateway, destinationReceiver,
    nonce, payload, payloadHash, deadline, messageId] = values;
  const reconstructed = { version, sourceDomain, sourceGateway, sourceSender, destinationDomain, destinationGateway,
    destinationReceiver, nonce, payload, payloadHash, deadline };
  assertCanonicalIdentity(reconstructed, wire.package.message.messageId);
  assert.equal(messageId, wire.package.message.messageId);
  console.log("VALID: production transport bytes and destination message reconstruction preserve the independently frozen message identity");
});

test("a genuinely signed committed portable fixture cannot substitute payload before or after recomputing its ID", async () => {
  const { deliveryFixture } = await import("./helpers/delivery-fixtures.mjs");
  const { buildDeliveryPackages } = await import("../src/delivery/package.mjs");
  const validatorSets = createValidatorSetResolver(wire.validatorHistory);
  const snapshot = await deliveryFixture({ validatorSets, count: 3 });
  const [pack] = await buildDeliveryPackages(snapshot, { validatorSets });
  await assertCommittedPackageIntegrity({ snapshot: { ...snapshot, tree: buildMessageMerkleTree(snapshot.batch) }, pack, validatorSets });
  console.log("VALID: the original message/proof/root/QC remain valid after rejected in-memory payload substitution candidates");
});
