import { decodeEventLog, parseAbiItem } from "viem";

import {
  normalizeAddress,
  normalizeBytes32,
  normalizePayload,
  toUint256,
  validateCanonicalMessage,
} from "./canonical-message.mjs";

export const CROSS_CHAIN_MESSAGE_EVENT = parseAbiItem(
  "event CrossChainMessage(bytes32 indexed messageId, uint8 version, uint256 sourceDomain, address sourceGateway, address indexed sourceSender, uint256 indexed destinationDomain, address destinationGateway, address destinationReceiver, uint256 nonce, bytes payload, uint256 deadline)",
);

function requireLogMetadata(log) {
  if (log.blockNumber === null || log.blockNumber === undefined) {
    throw new Error("CrossChainMessage log is missing block number");
  }
  if (log.blockHash === null || log.blockHash === undefined) {
    throw new Error("CrossChainMessage log is missing block hash");
  }
  if (log.transactionHash === null || log.transactionHash === undefined) {
    throw new Error("CrossChainMessage log is missing transaction hash");
  }
  if (log.logIndex === null || log.logIndex === undefined) {
    throw new Error("CrossChainMessage log is missing log index");
  }
}

export function decodeCrossChainMessageLog(log, { expectedGateway, expectedSourceDomain }) {
  requireLogMetadata(log);

  const gateway = normalizeAddress(expectedGateway, "configured SourceGateway address");
  const emitter = normalizeAddress(log.address, "event emitter");
  if (emitter !== gateway) {
    throw new Error("CrossChainMessage was emitted by an unexpected contract");
  }

  const decoded =
    log.args === undefined
      ? decodeEventLog({
          abi: [CROSS_CHAIN_MESSAGE_EVENT],
          data: log.data,
          topics: log.topics,
          strict: true,
        })
      : { eventName: log.eventName ?? "CrossChainMessage", args: log.args };

  if (decoded.eventName !== "CrossChainMessage") {
    throw new Error("unexpected SourceGateway event");
  }

  const sourceDomain = toUint256(decoded.args.sourceDomain, "event source domain");
  if (sourceDomain !== toUint256(expectedSourceDomain, "configured Chain A domain")) {
    throw new Error("CrossChainMessage source domain does not match configured Chain A domain");
  }

  const eventGateway = normalizeAddress(decoded.args.sourceGateway, "event source gateway");
  if (eventGateway !== gateway) {
    throw new Error("CrossChainMessage source gateway does not match its emitter");
  }

  const canonical = validateCanonicalMessage(
    {
      version: decoded.args.version,
      sourceDomain,
      sourceGateway: eventGateway,
      sourceSender: decoded.args.sourceSender,
      destinationDomain: decoded.args.destinationDomain,
      destinationGateway: decoded.args.destinationGateway,
      destinationReceiver: decoded.args.destinationReceiver,
      nonce: decoded.args.nonce,
      payload: decoded.args.payload,
      deadline: decoded.args.deadline,
    },
    decoded.args.messageId,
  );

  return {
    ...canonical,
    sourceBlockNumber: toUint256(log.blockNumber, "source block number"),
    sourceBlockHash: normalizeBytes32(log.blockHash, "source block hash"),
    sourceTransactionHash: normalizeBytes32(log.transactionHash, "source transaction hash"),
    sourceLogIndex: toUint256(log.logIndex, "source log index"),
  };
}

export function sourceEventToDatabaseRow(event) {
  const payload = normalizePayload(event.payload);

  return {
    messageId: normalizeBytes32(event.messageId, "message ID"),
    version: Number(toUint256(event.version, "message version")),
    sourceDomain: toUint256(event.sourceDomain, "source domain").toString(),
    sourceGateway: normalizeAddress(event.sourceGateway, "source gateway"),
    sourceSender: normalizeAddress(event.sourceSender, "source sender"),
    destinationDomain: toUint256(event.destinationDomain, "destination domain").toString(),
    destinationGateway: normalizeAddress(event.destinationGateway, "destination gateway"),
    destinationReceiver: normalizeAddress(event.destinationReceiver, "destination receiver"),
    nonce: toUint256(event.nonce, "nonce").toString(),
    payload: Buffer.from(payload.slice(2), "hex"),
    payloadHash: normalizeBytes32(event.payloadHash, "payload hash"),
    deadline: toUint256(event.deadline, "deadline").toString(),
    sourceBlockNumber: toUint256(event.sourceBlockNumber, "source block number").toString(),
    sourceBlockHash: normalizeBytes32(event.sourceBlockHash, "source block hash"),
    sourceTransactionHash: normalizeBytes32(event.sourceTransactionHash, "source transaction hash"),
    sourceLogIndex: toUint256(event.sourceLogIndex, "source log index").toString(),
  };
}
