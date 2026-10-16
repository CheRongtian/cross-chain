import { computeCanonicalMessageId, computePayloadHash } from "../../src/canonical-message.mjs";
import { buildMessageBatch } from "../../src/message-batch.mjs";
import { buildMessageMerkleTree } from "../../src/message-merkle.mjs";
import { buildQuorumCertificate, expectedCommitStatement } from "../../../validator/src/quorum-certificate.mjs";
import { commitConfigs, signedCommitFixture } from "../../../validator/test/helpers/commit-fixtures.mjs";

export const deliveryValidatorSets = commitConfigs[0].validatorSets;
export const deliveryScope = { chainDomain: 10011n, sourceGateway: commitConfigs[0].sourceGateway };
export function fixtureHash(value) { return `0x${BigInt(value).toString(16).padStart(64,"0")}`; }

export function deliveryMessage(index = 0, overrides = {}) {
  const message = { version: 2n, sourceDomain: deliveryScope.chainDomain, sourceGateway: deliveryScope.sourceGateway,
    sourceSender: "0x0000000000000000000000000000000000001002", destinationDomain: 2001n,
    destinationGateway: "0x0000000000000000000000000000000000002001",
    destinationReceiver: "0x0000000000000000000000000000000000002002", nonce: BigInt(index + 1),
    payload: "0x00ff80", deadline: (1n << 200n) + 123n, sourceBlockNumber: 10n,
    sourceBlockHash: fixtureHash(11), sourceTransactionHash: fixtureHash(100 + index), sourceLogIndex: BigInt(index),
    status: "FINALIZED", ...overrides };
  message.payloadHash = computePayloadHash(message.payload);
  message.messageId = computeCanonicalMessageId(message);
  return message;
}

export async function deliveryFixture({ count = 3, epoch = 23n, validatorSets = deliveryValidatorSets,
  protocolVersion = "3", multiDestination = false, messageOffset = 0,sourceBlockNumber = 10n } = {}) {
  const messages = Array.from({ length: count }, (_, index) => deliveryMessage(index + messageOffset,{
    sourceBlockNumber,sourceBlockHash: fixtureHash(sourceBlockNumber + 1n),
    ...(multiDestination && index === 1 ? { destinationDomain: 3001n,
      destinationGateway: "0x0000000000000000000000000000000000003001",
      destinationReceiver: "0x0000000000000000000000000000000000003002" } : {}) }));
  const batch = buildMessageBatch({ sourceDomain: deliveryScope.chainDomain, sourceGateway: deliveryScope.sourceGateway, epoch, messages });
  const tree = buildMessageMerkleTree(batch);
  const statement = expectedCommitStatement({ protocolVersion, sourceDomain: batch.sourceDomain,
    sourceGateway: batch.sourceGateway, epoch, batchId: batch.batchId, messageRoot: tree.messageRoot }, commitConfigs[0].peers, validatorSets);
  const commits = await Promise.all(commitConfigs.slice(0,3).map((config) => signedCommitFixture(statement, config)));
  const certificate = await buildQuorumCertificate(commits, { peers: commitConfigs[0].peers, validatorSets, expected: statement });
  return { record: { batchRecordId: "1", status: "COMMITTED", batchId: batch.batchId, sourceDomain: batch.sourceDomain,
    sourceGateway: batch.sourceGateway, epoch, messageCount: BigInt(count), messageRoot: tree.messageRoot }, batch, tree,
    members: batch.messages.map((message,index) => ({ sourceMessageId: String(index + 1), messageId: message.messageId, position: BigInt(index) })),
    quorumCertificate: certificate, consensusBinding: protocolVersion === "3" ? {
      protocolVersion, validatorEpoch: certificate.validatorEpoch, committeeDigest: certificate.committeeDigest } : null };
}
