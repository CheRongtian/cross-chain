import { normalizeAddress, normalizeBytes32, normalizePayload, validateCanonicalMessage } from "../canonical-message.mjs";
import { validateMessageBatch } from "../message-batch.mjs";
import { buildMessageMerkleTree, verifyCommittedMessageMerkleProof } from "../message-merkle.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { verifyQuorumCertificate } from "../../../validator/src/quorum-certificate.mjs";

export class DeliveryError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function deliveryLimit(value = 100) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 1000) throw new DeliveryError("INVALID_DELIVERY_LIMIT");
  return value;
}

export function deliveryIndex(value, label = "message index") {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) throw new DeliveryError("INVALID_DELIVERY_INDEX");
    value = BigInt(value);
  }
  const exact = protocolInteger(value, label);
  if (exact > BigInt(Number.MAX_SAFE_INTEGER)) throw new DeliveryError("INVALID_DELIVERY_INDEX");
  return Number(exact);
}

export function deliveryJobId({ sourceDomain, sourceGateway, batchId, messageIndex }) {
  return `${protocolInteger(sourceDomain, "source domain")}:${normalizeAddress(sourceGateway)}:${normalizeBytes32(batchId)}:${deliveryIndex(messageIndex)}`;
}

export function deliveryJson(value) {
  return JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item);
}

function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}

const MESSAGE_FIELDS = ["version", "sourceDomain", "sourceGateway", "sourceSender", "destinationDomain",
  "destinationGateway", "destinationReceiver", "nonce", "payload", "payloadHash", "deadline", "messageId"];
const PACKAGE_FIELDS = ["deliveryJobId", "message", "batchVersion", "batchEpoch", "batchId", "batchMessageIds",
  "messageIndex", "leafCount", "messageRoot", "merkleProof", "validatorEpoch", "committeeDigest", "quorumCertificate"];
const PROOF_FIELDS = ["batchId", "messageId", "index", "leafCount", "siblings"];

function exactFields(input, fields) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).sort().join(",") !== [...fields].sort().join(",")) throw new DeliveryError("MALFORMED_DELIVERY_PACKAGE");
}

function canonicalMessage(input) {
  exactFields(input, MESSAGE_FIELDS);
  for (const field of ["version", "sourceDomain", "destinationDomain", "nonce", "deadline"]) protocolInteger(input[field], field);
  normalizePayload(input.payload);
  return validateCanonicalMessage(input, input.messageId);
}

export async function verifyDeliveryPackage(input, { validatorSets, sourceDomain, sourceGateway } = {}) {
  if (!validatorSets) throw new DeliveryError("VALIDATOR_HISTORY_REQUIRED");
  exactFields(input, PACKAGE_FIELDS);
  const message = canonicalMessage(input.message);
  if (sourceDomain !== undefined && message.sourceDomain !== protocolInteger(sourceDomain, "source domain")) throw new DeliveryError("WRONG_DELIVERY_SOURCE");
  if (sourceGateway !== undefined && message.sourceGateway !== normalizeAddress(sourceGateway)) throw new DeliveryError("WRONG_DELIVERY_SOURCE");
  const batchEpoch = protocolInteger(input.batchEpoch, "batch epoch").toString();
  const batchVersion = protocolInteger(input.batchVersion, "batch version").toString();
  const batchId = normalizeBytes32(input.batchId, "batch ID");
  const messageRoot = normalizeBytes32(input.messageRoot, "Message Root");
  const committeeDigest = normalizeBytes32(input.committeeDigest, "committee digest");
  if (!Number.isSafeInteger(input.messageIndex) || input.messageIndex < 0 ||
      !Number.isSafeInteger(input.leafCount) || input.leafCount < 1 || input.messageIndex >= input.leafCount) throw new DeliveryError("INVALID_DELIVERY_INDEX");
  exactFields(input.merkleProof, PROOF_FIELDS);
  if (input.merkleProof.index !== input.messageIndex || input.merkleProof.leafCount !== input.leafCount ||
      !Array.isArray(input.batchMessageIds) || input.batchMessageIds.length !== input.leafCount) throw new DeliveryError("WRONG_DELIVERY_MEMBERSHIP");
  const commitment = { version: batchVersion, sourceDomain: message.sourceDomain, sourceGateway: message.sourceGateway,
    epoch: batchEpoch, batchId, messageIds: input.batchMessageIds };
  if (!verifyCommittedMessageMerkleProof({ commitment, message, proof: input.merkleProof, messageRoot })) throw new DeliveryError("INVALID_DELIVERY_MERKLE_PROOF");
  const certificate = input.quorumCertificate;
  if (!certificate || !["1", "2", "3"].includes(certificate.protocolVersion)) throw new DeliveryError("INVALID_DELIVERY_QC");
  const validatorEpoch = certificate.protocolVersion === "3" ? protocolInteger(input.validatorEpoch, "validator epoch").toString() : null;
  if (certificate.protocolVersion !== "3" && input.validatorEpoch !== null) throw new DeliveryError("UNSIGNED_VALIDATOR_EPOCH");
  if (certificate.protocolVersion === "3" && certificate.validatorEpoch !== validatorEpoch) throw new DeliveryError("WRONG_DELIVERY_VALIDATOR_EPOCH");
  if (certificate.committeeDigest !== committeeDigest) throw new DeliveryError("WRONG_DELIVERY_COMMITTEE");
  // Trusted public history is supplied by the operator, never by the package.
  const peers = validatorSets.history[0].validators.map((address) => ({ address }));
  const quorumCertificate = await verifyQuorumCertificate(certificate, { peers, validatorSets, expected: {
    protocolVersion: certificate.protocolVersion, sourceDomain: message.sourceDomain,
    sourceGateway: message.sourceGateway, epoch: batchEpoch, view: certificate.view ?? "0",
    validatorEpoch, committeeDigest, batchId, messageRoot,
  } });
  const id = deliveryJobId({ ...message, batchId, messageIndex: input.messageIndex });
  if (input.deliveryJobId !== id) throw new DeliveryError("WRONG_DELIVERY_JOB_ID");
  const merkleProof = { ...input.merkleProof, batchId, messageId: message.messageId,
    siblings: input.merkleProof.siblings.map((sibling) => normalizeBytes32(sibling)) };
  return immutable(JSON.parse(deliveryJson({ deliveryJobId: id, message, batchVersion, batchEpoch, batchId,
    batchMessageIds: input.batchMessageIds.map((id) => normalizeBytes32(id)), messageIndex: input.messageIndex,
    leafCount: input.leafCount, messageRoot, merkleProof, validatorEpoch, committeeDigest, quorumCertificate })));
}

export async function buildDeliveryPackages(snapshot, options) {
  if (snapshot?.record?.status !== "COMMITTED") throw new DeliveryError("DELIVERY_REQUIRES_COMMITTED");
  if (!snapshot.quorumCertificate) throw new DeliveryError("DELIVERY_REQUIRES_QC");
  const batch = validateMessageBatch(snapshot.batch);
  const record = snapshot.record;
  if (normalizeBytes32(record.batchId) !== batch.batchId || protocolInteger(record.epoch) !== batch.epoch ||
      protocolInteger(record.sourceDomain) !== batch.sourceDomain || normalizeAddress(record.sourceGateway) !== batch.sourceGateway ||
      protocolInteger(record.messageCount) !== BigInt(batch.messages.length)) throw new DeliveryError("WRONG_COMMITTED_BATCH");
  const tree = buildMessageMerkleTree(batch);
  if (normalizeBytes32(record.messageRoot) !== tree.messageRoot) throw new DeliveryError("WRONG_COMMITTED_ROOT");
  if (!Array.isArray(snapshot.members) || snapshot.members.length !== batch.messages.length) throw new DeliveryError("WRONG_DELIVERY_MEMBERSHIP");
  const certificate = snapshot.quorumCertificate;
  if (certificate.protocolVersion === "3" && (!snapshot.consensusBinding || snapshot.consensusBinding.protocolVersion !== "3" ||
      snapshot.consensusBinding.validatorEpoch !== certificate.validatorEpoch || snapshot.consensusBinding.committeeDigest !== certificate.committeeDigest)) throw new DeliveryError("WRONG_DELIVERY_VALIDATOR_EPOCH");
  const packages = [];
  for (let index = 0; index < batch.messages.length; index++) {
    const member = snapshot.members[index];
    if (protocolInteger(member.position, "sealed position") !== BigInt(index) ||
        normalizeBytes32(member.messageId) !== batch.messageIds[index]) throw new DeliveryError("WRONG_DELIVERY_MEMBERSHIP");
    const message = Object.fromEntries(MESSAGE_FIELDS.map((field) => [field, batch.messages[index][field]]));
    packages.push(await verifyDeliveryPackage({
      deliveryJobId: deliveryJobId({ ...message, batchId: batch.batchId, messageIndex: index }), message,
      batchVersion: batch.version, batchEpoch: batch.epoch, batchId: batch.batchId, batchMessageIds: batch.messageIds,
      messageIndex: index, leafCount: batch.messages.length, messageRoot: tree.messageRoot, merkleProof: tree.proofs[index],
      validatorEpoch: certificate.validatorEpoch ?? null, committeeDigest: certificate.committeeDigest, quorumCertificate: certificate,
    }, options));
  }
  return Object.freeze(packages);
}
