import {
  encodeAbiParameters,
  getAddress,
  isAddress,
  keccak256,
  parseAbiParameters,
  size,
  stringToHex,
} from "viem";

export const CROSS_CHAIN_MESSAGE_TYPE =
  "CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)";

export const CROSS_CHAIN_MESSAGE_TYPEHASH = keccak256(stringToHex(CROSS_CHAIN_MESSAGE_TYPE));

const MESSAGE_PARAMETERS = parseAbiParameters(
  "bytes32,uint8,uint256,address,address,uint256,address,address,uint256,bytes32,uint256",
);
const UINT256_LIMIT = 1n << 256n;

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function normalizeAddress(value, label = "address") {
  requireCondition(typeof value === "string" && isAddress(value, { strict: false }), `invalid ${label}`);
  return getAddress(value.toLowerCase()).toLowerCase();
}

export function normalizeBytes32(value, label = "bytes32") {
  requireCondition(typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value), `invalid ${label}`);
  requireCondition(size(value) === 32, `invalid ${label}`);
  return value.toLowerCase();
}

export function normalizePayload(value) {
  requireCondition(typeof value === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(value), "invalid payload");
  return value.toLowerCase();
}

export function toUint256(value, label) {
  let result;

  try {
    result = BigInt(value);
  } catch {
    throw new Error(`invalid ${label}`);
  }

  requireCondition(result >= 0n && result < UINT256_LIMIT, `invalid ${label}`);
  return result;
}

export function computePayloadHash(payload) {
  return keccak256(normalizePayload(payload)).toLowerCase();
}

export function normalizeCanonicalMessage(message) {
  const version = toUint256(message.version, "message version");
  requireCondition(version <= 255n, "invalid message version");

  const payload = message.payload === undefined ? undefined : normalizePayload(message.payload);
  const suppliedPayloadHash =
    message.payloadHash === undefined ? undefined : normalizeBytes32(message.payloadHash, "payload hash");
  const computedPayloadHash = payload === undefined ? undefined : computePayloadHash(payload);

  requireCondition(suppliedPayloadHash !== undefined || computedPayloadHash !== undefined, "payload hash is required");
  if (suppliedPayloadHash !== undefined && computedPayloadHash !== undefined) {
    requireCondition(suppliedPayloadHash === computedPayloadHash, "payload hash does not match payload");
  }

  return {
    version,
    sourceDomain: toUint256(message.sourceDomain, "source domain"),
    sourceGateway: normalizeAddress(message.sourceGateway, "source gateway"),
    sourceSender: normalizeAddress(message.sourceSender, "source sender"),
    destinationDomain: toUint256(message.destinationDomain, "destination domain"),
    destinationGateway: normalizeAddress(message.destinationGateway, "destination gateway"),
    destinationReceiver: normalizeAddress(message.destinationReceiver, "destination receiver"),
    nonce: toUint256(message.nonce, "nonce"),
    payload,
    payloadHash: suppliedPayloadHash ?? computedPayloadHash,
    deadline: toUint256(message.deadline, "deadline"),
  };
}

export function computeCanonicalMessageId(message) {
  const normalized = normalizeCanonicalMessage(message);
  const encoded = encodeAbiParameters(MESSAGE_PARAMETERS, [
    CROSS_CHAIN_MESSAGE_TYPEHASH,
    Number(normalized.version),
    normalized.sourceDomain,
    normalized.sourceGateway,
    normalized.sourceSender,
    normalized.destinationDomain,
    normalized.destinationGateway,
    normalized.destinationReceiver,
    normalized.nonce,
    normalized.payloadHash,
    normalized.deadline,
  ]);

  return keccak256(encoded).toLowerCase();
}

export function validateCanonicalMessage(message, eventMessageId) {
  const normalized = normalizeCanonicalMessage(message);
  const expectedMessageId = normalizeBytes32(eventMessageId, "message ID");
  const actualMessageId = computeCanonicalMessageId(normalized);

  requireCondition(actualMessageId === expectedMessageId, "canonical message ID mismatch");
  return { ...normalized, messageId: expectedMessageId };
}
