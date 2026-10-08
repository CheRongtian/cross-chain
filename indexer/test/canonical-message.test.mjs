import assert from "node:assert/strict";
import test from "node:test";

import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";

import {
  computeCanonicalMessageId,
  computePayloadHash,
  validateCanonicalMessage,
} from "../src/canonical-message.mjs";
import {
  CROSS_CHAIN_MESSAGE_EVENT,
  decodeCrossChainMessageLog,
  sourceEventToDatabaseRow,
} from "../src/source-gateway-event.mjs";

const SOURCE_GATEWAY = "0x0000000000000000000000000000000000001001";
const SOURCE_SENDER = "0x0000000000000000000000000000000000001002";
const DESTINATION_GATEWAY = "0x0000000000000000000000000000000000002001";
const DESTINATION_RECEIVER = "0x0000000000000000000000000000000000002002";
const BLOCK_HASH = `0x${"ab".repeat(32)}`;
const TRANSACTION_HASH = `0x${"cd".repeat(32)}`;
const PAYLOAD = "0x68656c6c6f";

function canonicalMessage() {
  return {
    version: 2,
    sourceDomain: 10_011n,
    sourceGateway: SOURCE_GATEWAY,
    sourceSender: SOURCE_SENDER,
    destinationDomain: 2001n,
    destinationGateway: DESTINATION_GATEWAY,
    destinationReceiver: DESTINATION_RECEIVER,
    nonce: 1n,
    payload: PAYLOAD,
    deadline: 2_000_000_000n,
  };
}

function rawEventLog(messageId = computeCanonicalMessageId(canonicalMessage())) {
  const message = canonicalMessage();
  return {
    address: SOURCE_GATEWAY,
    topics: encodeEventTopics({
      abi: [CROSS_CHAIN_MESSAGE_EVENT],
      eventName: "CrossChainMessage",
      args: {
        messageId,
        sourceSender: message.sourceSender,
        destinationDomain: message.destinationDomain,
      },
    }),
    data: encodeAbiParameters(
      parseAbiParameters("uint8,uint256,address,address,address,uint256,bytes,uint256"),
      [
        message.version,
        message.sourceDomain,
        message.sourceGateway,
        message.destinationGateway,
        message.destinationReceiver,
        message.nonce,
        message.payload,
        message.deadline,
      ],
    ),
    blockNumber: 123n,
    blockHash: BLOCK_HASH,
    transactionHash: TRANSACTION_HASH,
    logIndex: 7,
  };
}

test("computes payload hash and canonical message ID", () => {
  const message = canonicalMessage();
  const messageId = computeCanonicalMessageId(message);

  assert.equal(computePayloadHash(PAYLOAD), "0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8");
  assert.match(messageId, /^0x[0-9a-f]{64}$/);
  assert.equal(validateCanonicalMessage(message, messageId).messageId, messageId);
});

test("decodes CrossChainMessage and maps it to a database row", () => {
  const event = decodeCrossChainMessageLog(rawEventLog(), {
    expectedGateway: SOURCE_GATEWAY,
    expectedSourceDomain: 10_011n,
  });
  const row = sourceEventToDatabaseRow(event);

  assert.equal(event.sourceBlockNumber, 123n);
  assert.equal(event.sourceLogIndex, 7n);
  assert.equal(row.sourceDomain, "10011");
  assert.equal(row.destinationDomain, "2001");
  assert.equal(row.nonce, "1");
  assert.equal(row.payload.toString("hex"), PAYLOAD.slice(2));
  assert.equal(row.sourceBlockHash, BLOCK_HASH);
  assert.equal(row.sourceTransactionHash, TRANSACTION_HASH);
});

test("rejects an event whose message ID does not match its canonical fields", () => {
  assert.throws(
    () =>
      decodeCrossChainMessageLog(rawEventLog(`0x${"11".repeat(32)}`), {
        expectedGateway: SOURCE_GATEWAY,
        expectedSourceDomain: 10_011n,
      }),
    /canonical message ID mismatch/,
  );
});

test("rejects an event from another contract or source domain", () => {
  assert.throws(
    () =>
      decodeCrossChainMessageLog(
        { ...rawEventLog(), address: "0x0000000000000000000000000000000000009999" },
        { expectedGateway: SOURCE_GATEWAY, expectedSourceDomain: 10_011n },
      ),
    /unexpected contract/,
  );

  assert.throws(
    () =>
      decodeCrossChainMessageLog(rawEventLog(), {
        expectedGateway: SOURCE_GATEWAY,
        expectedSourceDomain: 10_012n,
      }),
    /source domain does not match/,
  );
});
