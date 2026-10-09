import assert from "node:assert/strict";
import test from "node:test";

import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

import { computeCanonicalMessageId, computePayloadHash } from "../src/canonical-message.mjs";
import {
  buildMessageBatch,
  MESSAGE_BATCH_TYPE,
  MESSAGE_BATCH_TYPEHASH,
} from "../src/message-batch.mjs";

const SOURCE_GATEWAY = "0x0000000000000000000000000000000000001001";
const CONTEXT = { sourceDomain: 10_011n, sourceGateway: SOURCE_GATEWAY, epoch: 7n };

function hash(value) {
  return `0x${BigInt(value).toString(16).padStart(64, "0")}`;
}

function finalizedMessage(overrides = {}) {
  const message = {
    version: 2n,
    sourceDomain: CONTEXT.sourceDomain,
    sourceGateway: SOURCE_GATEWAY,
    sourceSender: "0x0000000000000000000000000000000000001002",
    destinationDomain: 2001n,
    destinationGateway: "0x0000000000000000000000000000000000002001",
    destinationReceiver: "0x0000000000000000000000000000000000002002",
    nonce: 1n,
    payload: "0x68656c6c6f",
    deadline: 2_000_000_000n,
    sourceBlockNumber: 10n,
    sourceLogIndex: 0n,
    sourceTransactionHash: hash(100n),
    status: "FINALIZED",
    ...overrides,
  };
  message.sourceBlockHash = overrides.sourceBlockHash ?? hash(BigInt(message.sourceBlockNumber) + 1n);
  message.payloadHash = computePayloadHash(message.payload);
  message.messageId = computeCanonicalMessageId(message);
  return message;
}

function build(messages, context = {}) {
  return buildMessageBatch({ ...CONTEXT, ...context, messages });
}

test("a single finalized message binds the full ABI batch context and message identity", () => {
  const message = finalizedMessage();
  const batch = build([message]);
  const type = "MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)";
  const typeHash = keccak256(stringToHex(type));
  const expectedId = keccak256(encodeAbiParameters(
    parseAbiParameters("bytes32,uint8,uint256,address,uint256,bytes32[]"),
    [typeHash, 1, 10_011n, SOURCE_GATEWAY, 7n, [message.messageId]],
  ));

  assert.equal(MESSAGE_BATCH_TYPE, type);
  assert.equal(MESSAGE_BATCH_TYPEHASH, typeHash);
  assert.equal(batch.version, 1n);
  assert.equal(batch.sourceDomain, CONTEXT.sourceDomain);
  assert.equal(batch.sourceGateway, SOURCE_GATEWAY);
  assert.equal(batch.epoch, 7n);
  assert.deepEqual(batch.messages, [message]);
  assert.deepEqual(batch.messageIds, [message.messageId]);
  assert.equal(batch.batchId, expectedId);
  assert.notEqual(batch.batchId, message.messageId);
});

test("permutations and repeated construction preserve canonical block and log ordering", () => {
  const first = finalizedMessage({ nonce: 1n, sourceBlockNumber: 10n, sourceLogIndex: 2n });
  const second = finalizedMessage({ nonce: 2n, sourceBlockNumber: 10n, sourceLogIndex: 9n });
  const third = finalizedMessage({ nonce: 3n, sourceBlockNumber: 11n, sourceLogIndex: 0n });
  const expected = build([first, second, third]);

  for (const messages of [
    [third, second, first],
    [second, first, third],
    [first, third, second],
    [first, second, third],
  ]) {
    const before = [...messages];
    const actual = build(messages);
    assert.deepEqual(actual, expected);
    assert.deepEqual(messages, before, "builder must not reorder the caller's array");
  }
  assert.deepEqual(expected.messageIds, [first.messageId, second.messageId, third.messageId]);
});

test("operational metadata and object property ordering have no effect on batch identity", () => {
  const message = finalizedMessage();
  const withMetadata = {
    ...message,
    id: "900",
    observed_at: new Date("2000-01-01T00:00:00Z"),
    finalized_at: new Date("2000-01-02T00:00:00Z"),
  };
  const reordered = Object.fromEntries(Object.entries({
    ...withMetadata,
    id: "1",
    observed_at: new Date("2030-01-01T00:00:00Z"),
  }).reverse());

  assert.deepEqual(build([message]), build([withMetadata]));
  assert.deepEqual(build([message]), build([reordered]));
  assert.equal("id" in build([message]).messages[0], false);
  assert.equal("observed_at" in build([message]).messages[0], false);
});

test("changing the epoch or batch membership changes the batch ID", () => {
  const first = finalizedMessage();
  const second = finalizedMessage({ nonce: 2n, sourceBlockNumber: 11n });
  const third = finalizedMessage({ nonce: 3n, sourceBlockNumber: 12n });
  const batch = build([first, second]);

  assert.notEqual(batch.batchId, build([first, second], { epoch: 8n }).batchId);
  assert.notEqual(batch.batchId, build([first]).batchId);
  assert.notEqual(batch.batchId, build([first, second, third]).batchId);
});

test("replacing a valid canonical message ID changes the batch ID", () => {
  const first = finalizedMessage();
  const replacement = finalizedMessage({ nonce: 2n });

  assert.notEqual(first.messageId, replacement.messageId);
  assert.notEqual(build([first]).batchId, build([replacement]).batchId);
});

test("different source contexts produce different batches", () => {
  const original = finalizedMessage();
  const anotherDomain = finalizedMessage({ sourceDomain: 10_012n });
  const anotherGateway = "0x0000000000000000000000000000000000001003";
  const anotherSource = finalizedMessage({ sourceGateway: anotherGateway });

  assert.notEqual(
    build([original]).batchId,
    build([anotherDomain], { sourceDomain: 10_012n }).batchId,
  );
  assert.notEqual(
    build([original]).batchId,
    build([anotherSource], { sourceGateway: anotherGateway }).batchId,
  );
});

test("empty eligible input returns no batch", () => {
  assert.equal(build([]), undefined);
});

test("duplicate canonical message IDs are rejected across different occurrences", () => {
  const message = finalizedMessage();
  const duplicate = { ...message, sourceBlockNumber: 11n, sourceBlockHash: hash(12n) };

  assert.throws(() => build([message, duplicate]), /duplicate message ID/);
});

test("duplicate source occurrence identities are rejected even with different message IDs", () => {
  const message = finalizedMessage();
  const conflicting = finalizedMessage({ nonce: 2n });

  assert.throws(() => build([message, message]), /duplicate source occurrence/);
  assert.throws(() => build([message, conflicting]), /duplicate source occurrence/);
});

test("conflicting canonical block hashes or global log positions are rejected", () => {
  const message = finalizedMessage();
  const anotherBranch = finalizedMessage({
    nonce: 2n,
    sourceBlockHash: hash(999n),
    sourceLogIndex: 1n,
  });
  const conflictingLog = finalizedMessage({
    nonce: 3n,
    sourceTransactionHash: hash(101n),
  });

  assert.throws(() => build([message, anotherBranch]), /conflicting source block hashes/);
  assert.throws(() => build([message, conflictingLog]), /conflicting source log position/);
});

for (const status of ["OBSERVED", "FINALIZING", "REORGED", "UNKNOWN", undefined]) {
  test(`rejects batch membership with status ${String(status)}`, () => {
    assert.throws(
      () => build([finalizedMessage({ status })]),
      /batch messages must be FINALIZED/,
    );
  });
}

test("source scope mismatches fail closed", () => {
  assert.throws(
    () => build([finalizedMessage({ sourceDomain: 10_012n })]),
    /source scope does not match/,
  );
  assert.throws(
    () => build([finalizedMessage({
      sourceGateway: "0x0000000000000000000000000000000000001003",
    })]),
    /source scope does not match/,
  );
});

test("malformed protocol IDs, payloads, and occurrence metadata fail closed", () => {
  const message = finalizedMessage();
  assert.throws(() => build([{ ...message, messageId: hash(999n) }]), /canonical message ID mismatch/);
  assert.throws(() => build([{ ...message, payload: "0x00" }]), /payload hash does not match payload/);
  assert.throws(() => build([{ ...message, payload: undefined }]), /invalid payload/);
  assert.throws(() => build([{ ...message, sourceBlockHash: undefined }]), /invalid source event block hash/);
  assert.throws(() => build([{ ...message, sourceBlockNumber: null }]), /invalid source block number/);
  assert.throws(() => build([{ ...message, sourceLogIndex: -1n }]), /invalid source event log index/);
  assert.throws(() => build([{ ...message, nonce: Number.MAX_SAFE_INTEGER + 1 }]), /invalid nonce/);
  assert.throws(() => build([null]), /invalid batch message/);
  assert.throws(() => build(undefined), /messages must be an array/);
});

test("epoch is explicit and must be an exact uint256", () => {
  for (const epoch of [undefined, null, "", true, -1n, 1n << 256n, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => build([finalizedMessage()], { epoch }), /invalid batch epoch/);
  }
  assert.equal(build([finalizedMessage()], { epoch: 0n }).epoch, 0n);
});

test("large block, log, domain, nonce, and epoch values remain exact", () => {
  const large = (1n << 200n) + 1n;
  const first = finalizedMessage({
    sourceDomain: large,
    destinationDomain: large + 1n,
    nonce: large,
    deadline: large + 2n,
    sourceBlockNumber: large,
    sourceLogIndex: large,
  });
  const second = finalizedMessage({
    ...first,
    nonce: large + 1n,
    sourceLogIndex: large + 1n,
  });
  const stringInput = { ...first };
  for (const field of [
    "version", "sourceDomain", "destinationDomain", "nonce", "deadline", "sourceBlockNumber", "sourceLogIndex",
  ]) {
    stringInput[field] = stringInput[field].toString();
  }
  const expected = build([first, second], { sourceDomain: large, epoch: large });
  const actual = build([second, stringInput], { sourceDomain: large.toString(), epoch: large.toString() });

  assert.deepEqual(actual, expected);
  assert.equal(actual.epoch, large);
  assert.equal(actual.messages[0].sourceBlockNumber, large);
  assert.equal(actual.messages[1].sourceLogIndex, large + 1n);
  assert.equal(actual.messages[0].nonce, large);
});
