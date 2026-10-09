import { encodeAbiParameters, keccak256, parseAbiParameters, stringToHex } from "viem";

import {
  normalizeAddress,
  normalizePayload,
  toUint256,
  validateCanonicalMessage,
} from "./canonical-message.mjs";
import { createFinalityStore } from "./db.mjs";
import { MESSAGE_STATUS } from "./finality-policy.mjs";
import {
  normalizeSourceEventIdentity,
  sourceEventIdentityKey,
} from "./source-event-identity.mjs";

export const MESSAGE_BATCH_VERSION = 1n;
export const MESSAGE_BATCH_TYPE =
  "MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)";
export const MESSAGE_BATCH_TYPEHASH = keccak256(stringToHex(MESSAGE_BATCH_TYPE));

const BATCH_PARAMETERS = parseAbiParameters("bytes32,uint8,uint256,address,uint256,bytes32[]");

function requiredUint256(value, label) {
  if (
    typeof value !== "bigint" &&
    !(typeof value === "string" && /^[0-9]+$/.test(value)) &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    throw new Error(`invalid ${label}`);
  }
  return toUint256(value, label);
}

function normalizeBatchMessage(message, scope) {
  if (message === null || typeof message !== "object") {
    throw new Error("invalid batch message");
  }
  if (message.status !== MESSAGE_STATUS.FINALIZED) {
    throw new Error("batch messages must be FINALIZED");
  }

  const canonical = validateCanonicalMessage({
    ...message,
    version: requiredUint256(message.version, "message version"),
    sourceDomain: requiredUint256(message.sourceDomain, "source domain"),
    destinationDomain: requiredUint256(message.destinationDomain, "destination domain"),
    nonce: requiredUint256(message.nonce, "nonce"),
    deadline: requiredUint256(message.deadline, "deadline"),
    payload: normalizePayload(message.payload),
  }, message.messageId);

  if (
    canonical.sourceDomain !== scope.sourceDomain ||
    canonical.sourceGateway !== scope.sourceGateway
  ) {
    throw new Error("batch message source scope does not match batch context");
  }

  const identity = normalizeSourceEventIdentity({
    ...canonical,
    sourceBlockHash: message.sourceBlockHash,
    sourceTransactionHash: message.sourceTransactionHash,
    sourceLogIndex: requiredUint256(message.sourceLogIndex, "source event log index"),
  });
  return {
    ...canonical,
    sourceBlockNumber: requiredUint256(message.sourceBlockNumber, "source block number"),
    sourceBlockHash: identity.sourceBlockHash,
    sourceTransactionHash: identity.sourceTransactionHash,
    sourceLogIndex: BigInt(identity.sourceLogIndex),
    status: MESSAGE_STATUS.FINALIZED,
  };
}

function compareSourceOccurrences(left, right) {
  for (const field of ["sourceBlockNumber", "sourceLogIndex"]) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  for (const field of ["sourceBlockHash", "sourceTransactionHash", "messageId"]) {
    if (left[field] !== right[field]) {
      return left[field] < right[field] ? -1 : 1;
    }
  }
  return 0;
}

// Pure protocol builder. The runtime entry below obtains membership from PostgreSQL.
export function buildMessageBatch({ sourceDomain, sourceGateway, epoch, messages }) {
  const scope = {
    sourceDomain: requiredUint256(sourceDomain, "batch source domain"),
    sourceGateway: normalizeAddress(sourceGateway, "batch source gateway"),
  };
  const normalizedEpoch = requiredUint256(epoch, "batch epoch");
  if (!Array.isArray(messages)) {
    throw new Error("batch messages must be an array");
  }
  if (messages.length === 0) {
    return undefined;
  }

  const normalizedMessages = messages.map((message) => normalizeBatchMessage(message, scope));
  const messageIds = new Set();
  const occurrenceKeys = new Set();
  const blockHashes = new Map();
  const logPositions = new Set();
  for (const message of normalizedMessages) {
    const occurrenceKey = sourceEventIdentityKey(message);
    if (occurrenceKeys.has(occurrenceKey)) {
      throw new Error("duplicate source occurrence in batch");
    }
    if (messageIds.has(message.messageId)) {
      throw new Error("duplicate message ID in batch");
    }
    const height = message.sourceBlockNumber.toString();
    const trackedHash = blockHashes.get(height);
    if (trackedHash !== undefined && trackedHash !== message.sourceBlockHash) {
      throw new Error("conflicting source block hashes in batch");
    }
    const position = `${height}:${message.sourceLogIndex}`;
    if (logPositions.has(position)) {
      throw new Error("conflicting source log position in batch");
    }
    occurrenceKeys.add(occurrenceKey);
    messageIds.add(message.messageId);
    blockHashes.set(height, message.sourceBlockHash);
    logPositions.add(position);
  }

  const orderedMessages = normalizedMessages.sort(compareSourceOccurrences);
  const orderedMessageIds = orderedMessages.map((message) => message.messageId);
  const encoded = encodeAbiParameters(BATCH_PARAMETERS, [
    MESSAGE_BATCH_TYPEHASH,
    Number(MESSAGE_BATCH_VERSION),
    scope.sourceDomain,
    scope.sourceGateway,
    normalizedEpoch,
    orderedMessageIds,
  ]);

  return Object.freeze({
    version: MESSAGE_BATCH_VERSION,
    ...scope,
    epoch: normalizedEpoch,
    messages: Object.freeze(orderedMessages.map(Object.freeze)),
    messageIds: Object.freeze(orderedMessageIds),
    batchId: keccak256(encoded).toLowerCase(),
  });
}

function databaseRowToBatchMessage(row) {
  if (!Buffer.isBuffer(row.payload) && !(row.payload instanceof Uint8Array)) {
    throw new Error("stored batch message payload must be bytes");
  }
  return {
    messageId: row.message_id,
    version: row.version,
    sourceDomain: row.source_domain,
    sourceGateway: row.source_gateway,
    sourceSender: row.source_sender,
    destinationDomain: row.destination_domain,
    destinationGateway: row.destination_gateway,
    destinationReceiver: row.destination_receiver,
    nonce: row.nonce,
    payload: `0x${Buffer.from(row.payload).toString("hex")}`,
    payloadHash: row.payload_hash,
    deadline: row.deadline,
    sourceBlockNumber: row.source_block_number,
    sourceBlockHash: row.source_block_hash,
    sourceTransactionHash: row.source_tx_hash,
    sourceLogIndex: row.source_log_index,
    status: row.status,
  };
}

export function createMessageBatcher({ config, pool }) {
  const scope = {
    chainDomain: requiredUint256(config.chainDomain, "batch source domain"),
    sourceGateway: normalizeAddress(config.sourceGateway, "batch source gateway"),
  };
  const finalityStore = createFinalityStore(pool, config.databaseSchema);

  return {
    async buildBatch({ epoch }) {
      const normalizedEpoch = requiredUint256(epoch, "batch epoch");
      const rows = await finalityStore.listBatchEligibleMessages(scope);
      return buildMessageBatch({
        sourceDomain: scope.chainDomain,
        sourceGateway: scope.sourceGateway,
        epoch: normalizedEpoch,
        messages: rows.map(databaseRowToBatchMessage),
      });
    },
  };
}
