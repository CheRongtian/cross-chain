import { normalizeBytes32, normalizeAddress, validateCanonicalMessage } from "../canonical-message.mjs";
import { databaseRowToBatchMessage } from "../message-batch.mjs";
import { tableName } from "../db.mjs";
import { createBatchLifecycle } from "../batch-lifecycle.mjs";
import { readDeliveryProjection } from "../delivery/repository.mjs";
import { encodeGatewaySubmission } from "../relayer/encoding.mjs";
import { formatRelayerSummary } from "../relayer/summary.mjs";
import { createTransactionRepository } from "../transaction-manager/repository.mjs";
import { readSnapshot } from "./read-snapshot.mjs";
import { readValidatorEvidence } from "./validator-evidence.mjs";
import { evidenceRead, inconsistent, MessageQueryError } from "./errors.mjs";

const iso = value => value == null ? null : new Date(value).toISOString();
const receipt = value => value ? { transactionHash: value.transactionHash, blockNumber: value.blockNumber,
  blockHash: value.blockHash, status: value.status, confirmedHead: value.confirmedHead, confirmedAt: value.confirmedAt,
  orphaned: value.orphaned, replacementBlockHash: value.replacementBlockHash ?? null,
  observedHead: value.observedHead ?? null, observedHeadHash: value.observedHeadHash ?? null } : null;

function provenance(row) {
  return { occurrenceId: row.id, status: row.status, transactionHash: normalizeBytes32(row.source_tx_hash),
    logIndex: BigInt(row.source_log_index), blockNumber: BigInt(row.source_block_number), blockHash: normalizeBytes32(row.source_block_hash),
    observedAt: iso(row.observed_at), reorgedAt: iso(row.reorged_at) };
}

// Explicit public projection. Neither raw database rows nor signed bytes pass
// through this boundary. All future sections begin empty, not fabricated.
export function projectMessageLifecycle({ config, source, occurrences, block, snapshot, member, entry, stored, legacy, lease, encoded, consensus }) {
  const message = validateCanonicalMessage(databaseRowToBatchMessage(source), source.message_id);
  const origin = provenance(source);
  const response = { apiVersion: "1", authority: "OBSERVATIONAL", observedAt: new Date().toISOString(), message,
    sourceTransaction: { transactionHash: origin.transactionHash, logIndex: origin.logIndex, sourceGateway: message.sourceGateway },
    sourceBlock: { blockNumber: origin.blockNumber, blockHash: origin.blockHash, parentHash: block?.parent_hash ?? null },
    sourceOccurrences: occurrences.map(provenance),
    finality: { status: source.status, requiredDepth: config.finalityBlockDepth, finalizingAt: iso(source.finalizing_at),
      finalizedAt: iso(source.finalized_at), finalizedAtHead: source.finalized_at_head, reorgedAt: iso(source.reorged_at) },
    batch: null, merkle: null, pbft: null, validatorVotes: [], qc: null, delivery: null, deliveryAttempts: [],
    destinationTransaction: null, execution: null };
  if (snapshot) {
    const record = snapshot.record;
    response.batch = { batchId: record.batchId, batchEpoch: record.epoch, status: record.status,
      position: member.position, memberCount: record.messageCount ?? BigInt(snapshot.members.length),
      sourceDomain: record.sourceDomain, sourceGateway: record.sourceGateway };
    response.merkle = record.messageRoot ? { root: record.messageRoot, position: member.position, memberCount: record.messageCount,
      siblings: entry?.package.merkleProof.siblings ?? null } : null;
    response.pbft = consensus.pbft; response.validatorVotes = consensus.validatorVotes;
    const qc = snapshot.quorumCertificate;
    // QC is authenticated protocol evidence with exact version-dependent fields.
    // Reconstruct the allowlist so even an injected extra property cannot leak.
    if (qc) response.qc = { protocolVersion: qc.protocolVersion, sourceDomain: qc.sourceDomain, sourceGateway: qc.sourceGateway,
      epoch: qc.epoch, validatorEpoch: qc.validatorEpoch ?? null, view: qc.view ?? null, batchId: qc.batchId,
      messageRoot: qc.messageRoot, proposalDigest: qc.proposalDigest, committeeDigest: qc.committeeDigest, qcDigest: qc.qcDigest,
      quorum: 3, signers: qc.commits.map(value => value.voterIdentity) };
  }
  if (entry) response.delivery = { deliveryJobId: entry.job.deliveryJobId, status: entry.job.status,
    messageId: entry.job.messageId, sourceDomain: entry.job.sourceDomain, destinationDomain: entry.job.destinationDomain,
    batchId: entry.job.batchId, position: String(entry.job.messageIndex), destinationGateway: entry.job.destinationGateway,
    destinationReceiver: entry.job.destinationReceiver, ownership: lease ? { workerId: lease.owner_id,
      fencingToken: lease.fencing_token, acquiredAt: iso(lease.lease_acquired_at), expiresAt: iso(lease.lease_expires_at),
      releasedAt: iso(lease.released_at),
      preparationRetryAt: iso(lease.preparation_retry_at), preparationDeferReason: lease.preparation_defer_reason } : null };
  if (stored) {
    const summary = formatRelayerSummary(stored);
    const winner = stored.winningAttempt;
    response.delivery.intent = { intentId: stored.intent.intentId, sender: stored.intent.senderAddress, nonce: stored.intent.nonce,
      packageDigest: stored.intent.packageDigest, status: summary.status, retryAt: stored.intent.nextActionAt,
      retryStoppedAt: stored.intent.retryStoppedAt, retryStopReason: stored.intent.retryStopReason };
    response.deliveryAttempts = stored.attempts.map(attempt => ({ attemptId: attempt.attemptId, attemptIndex: String(attempt.attemptNumber),
      replacementOfAttemptId: attempt.replacementOfAttemptId, status: attempt.status, transactionHash: attempt.transactionHash,
      nonce: attempt.nonce, gasLimit: attempt.gasLimit, maxFeePerGas: attempt.maxFeePerGas,
      maxPriorityFeePerGas: attempt.maxPriorityFeePerGas, transactionType: String(attempt.transactionType),
      broadcastAttemptCount: attempt.broadcastAttemptCount, broadcastAt: attempt.broadcastAt,
      lastBroadcastAttemptAt: attempt.lastBroadcastAttemptAt, lastErrorClass: attempt.lastErrorClass,
      broadcasts: stored.broadcastEvents.filter(event => event.attemptId === attempt.attemptId).map(event => ({
        sequence: event.broadcastSequence, parentEventId: event.parentEventId, endpointLabel: event.endpointLabel,
        startedAt: event.startedAt, completedAt: event.completedAt, resultClass: event.resultClass,
        errorClass: event.errorClass, returnedTransactionHash: event.returnedTransactionHash })),
      receipts: stored.receipts.filter(value => value.attemptId === attempt.attemptId).map(receipt) }));
    const canonicality = winner ? "PERSISTED_CANONICAL" : stored.intent.reorgRecovery ? "REORG_RECOVERY" : "UNCONFIRMED";
    response.destinationTransaction = { state: summary.intentStatus, canonicality,
      transactionHash: winner?.transactionHash ?? null, candidateTransactionHash: stored.attempt.transactionHash,
      nonce: stored.intent.nonce, sender: stored.intent.senderAddress, gateway: stored.intent.destinationGateway,
      blockNumber: winner?.receiptBlockNumber ?? null, blockHash: winner?.receiptBlockHash ?? null,
      confirmedHead: winner?.confirmedHead ?? null, requiredDepth: config.destinationConfirmations,
      observedConfirmations: winner ? (BigInt(winner.confirmedHead) - BigInt(winner.receiptBlockNumber) + 1n).toString() : null };
    const gatewayCall = stored.intent.calldata === encoded.calldata && message.destinationGateway === config.productionDestinationGateway;
    response.execution = { status: winner ? summary.intentStatus === "REVERTED" ? "REVERTED" : gatewayCall ? "CONFIRMED" : "TRANSPORT_CONFIRMED" :
      stored.intent.reorgRecovery ? "REORG_RECOVERY" : "PENDING", basis: "PERSISTED_TRANSACTION_OBSERVATION",
      gatewayCall: gatewayCall ? "execute(bytes)" : null, receiver: message.destinationReceiver,
      businessResult: null, receipt: receipt(stored.currentReceipt) };
  } else if (legacy) {
    response.delivery.historicalSubmission = { transactionHash: normalizeBytes32(legacy.transaction_hash), submittedAt: iso(legacy.submitted_at) };
    response.destinationTransaction = { state: "HISTORICAL", canonicality: "UNCONFIRMED", transactionHash: null,
      candidateTransactionHash: normalizeBytes32(legacy.transaction_hash) };
    response.execution = { status: "HISTORICAL", basis: "SUBMISSION_ONLY", businessResult: null };
  }
  return response;
}

export function createMessageQuery({ config, pool, validatorReaders = [] }) {
  const t = name => tableName(config.databaseSchema, name);
  const lifecycle = createBatchLifecycle({ config, pool });
  return {
    async getMessageLifecycle(input) {
      let id;
      try { id = normalizeBytes32(input, "message ID"); }
      catch { throw new MessageQueryError("INVALID_MESSAGE_ID", 400); }
      const data = await evidenceRead(() => readSnapshot(pool, async client => {
        const occurrences = (await client.query(`SELECT * FROM ${t("source_messages")}
          WHERE message_id = $1 AND source_domain = $2 AND source_gateway = $3 ORDER BY id DESC`,
        [id, config.chainDomain.toString(), config.sourceGateway])).rows;
        if (!occurrences.length) throw new MessageQueryError("MESSAGE_NOT_FOUND", 404);
        const current = occurrences.filter(row => row.status !== "REORGED");
        if (current.length > 1) throw inconsistent();
        const source = current[0] ?? occurrences[0];
        for (const row of occurrences) validateCanonicalMessage(databaseRowToBatchMessage(row), id);
        if (!["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"].includes(source.status)) throw inconsistent();
        const indexedBlock = (await client.query(`SELECT parent_hash,block_hash FROM ${t("indexed_source_blocks")}
          WHERE source_domain = $1 AND source_gateway = $2 AND block_number = $3`,
        [source.source_domain, source.source_gateway, source.source_block_number])).rows[0] ?? null;
        const matchesBlock = indexedBlock && normalizeBytes32(indexedBlock.block_hash) === normalizeBytes32(source.source_block_hash);
        if (source.status !== "REORGED" && indexedBlock && !matchesBlock) throw inconsistent();
        const block = matchesBlock ? { parent_hash: normalizeBytes32(indexedBlock.parent_hash) } : null;
        const memberships = (await client.query(`SELECT batch_record_id FROM ${t("message_batch_members")}
          WHERE source_message_id = $1`, [source.id])).rows;
        if (memberships.length > 1 || (memberships.length && source.status !== "FINALIZED")) throw inconsistent();
        let snapshot = null; let member = null; let entry = null; let encoded = null; let stored = null; let legacy = null; let lease = null;
        const jobs = (await client.query(`SELECT delivery_job_id,batch_record_id,source_message_id FROM ${t("delivery_jobs")}
          WHERE message_id = $1 AND source_domain = $2 AND source_gateway = $3`, [id, source.source_domain, source.source_gateway])).rows;
        if (jobs.length > 1 || (jobs.length && (!memberships.length || jobs[0].source_message_id !== source.id))) throw inconsistent();
        if (memberships.length) {
          const batchRecordId = memberships[0].batch_record_id;
          snapshot = await lifecycle.readBatchObservation({ batchRecordId }, client);
          member = snapshot.members.find(value => value.sourceMessageId === source.id);
          if (!member || member.messageId !== id) throw inconsistent();
          const projection = (await client.query(`SELECT batch_record_id FROM ${t("delivery_batches")} WHERE batch_record_id = $1`, [batchRecordId])).rows[0];
          if (projection) {
            if (snapshot.record.status !== "COMMITTED") throw inconsistent();
            const entries = await readDeliveryProjection({ config, client, snapshot, batchRecordId });
            entry = entries.find(value => value.job.messageId === id);
            if (!entry || jobs.length !== 1 || entry.job.deliveryJobId !== jobs[0].delivery_job_id) throw inconsistent();
          } else if (jobs.length) throw inconsistent();
        }
        if (entry) {
          const jobId = entry.job.deliveryJobId;
          encoded = await encodeGatewaySubmission(entry.package, { validatorSets: config.validatorSets,
            sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway });
          const rows = (await client.query(`SELECT sender_address,chain_id FROM ${t("transaction_intents")} WHERE delivery_job_id = $1`, [jobId])).rows;
          if (rows.length) {
            const sender = normalizeAddress(rows[0].sender_address);
            if (rows[0].chain_id !== entry.job.destinationDomain) throw inconsistent();
            const expected = { deliveryJobId: jobId, packageDigest: encoded.packageDigest, chainId: entry.job.destinationDomain,
              senderAddress: sender, destinationGateway: entry.job.destinationGateway, value: "0", calldata: encoded.calldata, historicalCalldata: encoded.data };
            const repository = createTransactionRepository({ config: { ...config, destinationDomain: BigInt(rows[0].chain_id), relayerAddress: sender }, pool });
            stored = await repository.readTransactionObservation(jobId, expected, client);
          }
          legacy = (await client.query(`SELECT * FROM ${t("relayer_submissions")} WHERE delivery_job_id = $1`, [jobId])).rows[0] ?? null;
          if (legacy && (stored || legacy.package_digest !== encoded.packageDigest || legacy.destination_domain !== entry.job.destinationDomain ||
            legacy.destination_gateway !== entry.job.destinationGateway)) throw inconsistent();
          lease = (await client.query(`SELECT * FROM ${t("relayer_job_leases")} WHERE delivery_job_id = $1`, [jobId])).rows[0] ?? null;
        }
        return { source, occurrences, block, snapshot, member, entry, encoded, stored, legacy, lease };
      }));
      const consensus = data.snapshot ? await readValidatorEvidence({ config, readers: validatorReaders, snapshot: data.snapshot }) : null;
      return evidenceRead(() => projectMessageLifecycle({ config, ...data, consensus }));
    },
  };
}
