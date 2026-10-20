import { buildDeliveryPackages } from "../../src/delivery/package.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { deliveryFixture, deliveryMessage, fixtureHash } from "./delivery-fixtures.mjs";
import { transactionConfig } from "./transaction-fixtures.mjs";

export function querySourceRow(message = deliveryMessage(), status = "FINALIZED") {
  const now = new Date("2026-01-01T00:00:00Z");
  return { id: "1", message_id: message.messageId, version: Number(message.version), source_domain: message.sourceDomain.toString(),
    source_gateway: message.sourceGateway, source_sender: message.sourceSender, destination_domain: message.destinationDomain.toString(),
    destination_gateway: message.destinationGateway, destination_receiver: message.destinationReceiver, nonce: message.nonce.toString(),
    payload: Buffer.from(message.payload.slice(2), "hex"), payload_hash: message.payloadHash, deadline: message.deadline.toString(),
    source_block_number: message.sourceBlockNumber.toString(), source_block_hash: message.sourceBlockHash,
    source_tx_hash: message.sourceTransactionHash, source_log_index: message.sourceLogIndex.toString(), status,
    observed_at: now, finalizing_at: ["FINALIZING", "FINALIZED", "REORGED"].includes(status) ? now : null,
    finalized_at: status === "FINALIZED" ? now : null, finalized_at_head: status === "FINALIZED" ? (message.sourceBlockNumber + 2n).toString() : null,
    reorged_at: status === "REORGED" ? now : null };
}

export async function queryProjectionFixture(protocolVersion = "3") {
  const config = { ...transactionConfig(), finalityBlockDepth: 2n };
  const snapshot = await deliveryFixture({ count: 1, protocolVersion });
  const [pack] = await buildDeliveryPackages(snapshot, { validatorSets: config.validatorSets });
  const source = querySourceRow(snapshot.batch.messages[0]);
  const entry = { package: pack, job: { deliveryJobId: pack.deliveryJobId, status: "READY", messageId: source.message_id,
    sourceDomain: source.source_domain, destinationDomain: source.destination_domain, batchId: pack.batchId,
    messageIndex: 0, destinationGateway: pack.message.destinationGateway, destinationReceiver: pack.message.destinationReceiver } };
  const encoded = await encodeGatewaySubmission(pack, { validatorSets: config.validatorSets });
  const nonce = (1n << 110n).toString(); const hash = fixtureHash(111);
  const attempt = { attemptId: "1", attemptNumber: 0, replacementOfAttemptId: null, status: "CONFIRMED", transactionHash: hash,
    rawSignedTransaction: "RAW_SIGNED_SECRET_SENTINEL", nonce, gasLimit: "500000", maxFeePerGas: "3000000000", maxPriorityFeePerGas: "1000000000",
    transactionType: 2, broadcastAttemptCount: "1", receiptBlockNumber: (1n << 100n).toString(), receiptBlockHash: fixtureHash(112),
    confirmedHead: ((1n << 100n) + 2n).toString(), receiptStatus: 1 };
  const currentReceipt = { attemptId: "1", transactionHash: hash, blockNumber: attempt.receiptBlockNumber,
    blockHash: attempt.receiptBlockHash, confirmedHead: attempt.confirmedHead, status: 1, confirmedAt: "2026-01-01T00:00:00.000Z", orphaned: false };
  const stored = { intent: { intentId: pack.deliveryJobId, deliveryJobId: pack.deliveryJobId, senderAddress: config.relayerAddress,
    nonce, packageDigest: encoded.packageDigest, status: "CONFIRMED", calldata: encoded.calldata, retryStoppedAt: null },
    attempt, attempts: [attempt], winningAttempt: attempt, currentReceipt, receipts: [currentReceipt], broadcastEvents: [] };
  return { config: { ...config, productionDestinationGateway: source.destination_gateway, destinationConfirmations: 3n },
    source, occurrences: [source], block: null, snapshot, member: snapshot.members[0], entry, encoded, stored,
    legacy: null, lease: null, consensus: { pbft: { status: "COMMITTED", validatorEpoch: snapshot.quorumCertificate.validatorEpoch ?? null },
      validatorVotes: snapshot.quorumCertificate.commits.map(value => ({ signer: value.voterIdentity, phase: "COMMIT", digest: value.commitDigest })) } };
}
