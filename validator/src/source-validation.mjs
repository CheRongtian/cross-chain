import { createBatchLifecycle } from "../../indexer/src/batch-lifecycle.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { buildMessageBatch, normalizeBatchMessage, validateMessageBatch } from "../../indexer/src/message-batch.mjs";
import { buildMessageMerkleTree } from "../../indexer/src/message-merkle.mjs";
import { isFinalizedByDepth } from "../../indexer/src/finality-policy.mjs";
import { decodeCrossChainMessageLog } from "../../indexer/src/source-gateway-event.mjs";
import { createChainClient, validateChainSource } from "../../indexer/src/indexer.mjs";

export class SourceValidationError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

function check(condition, code, message) {
  if (!condition) throw new SourceValidationError(code, message);
}

export async function validateSourceContext(publicClient, config) {
  try { await validateChainSource(publicClient, config); }
  catch (error) {
    if (error.message.startsWith("Chain A domain mismatch") || error.message.startsWith("no contract bytecode")) {
      throw new SourceValidationError("SOURCE_CONTEXT", error.message);
    }
    throw new SourceValidationError("RPC_UNAVAILABLE", "Chain A RPC prerequisite check failed");
  }
}

export function createSourceBatchReader({ config, pool }) {
  const sourceConfig = { ...config, databaseSchema: config.sourceDatabaseSchema };
  const lifecycle = createBatchLifecycle({ config: sourceConfig, pool });
  const batches = tableName(config.sourceDatabaseSchema, "message_batches");
  return {
    async read(batchId) {
      const id = normalizeBytes32(batchId, "batch ID");
      const result = await pool.query(`SELECT batch_record_id FROM ${batches}
        WHERE batch_id = $1 AND source_domain = $2 AND source_gateway = $3`,
      [id, config.chainDomain.toString(), config.sourceGateway]);
      check(result.rowCount === 1, "BATCH_NOT_FOUND", "batch reference was not found in configured source scope");
      return lifecycle.readBatch({ batchRecordId: result.rows[0].batch_record_id });
    },
  };
}

export function validateCandidateSnapshot(snapshot, config, requestedBatchId) {
  check(snapshot && ["SEALED", "CONSENSUS_PENDING"].includes(snapshot.record?.status), "BATCH_STATUS", "only SEALED or CONSENSUS_PENDING snapshots can be validated");
  const batch = validateMessageBatch(snapshot.batch);
  const tree = buildMessageMerkleTree(batch);
  const record = snapshot.record;
  check(batch.sourceDomain === config.chainDomain && batch.sourceGateway === config.sourceGateway &&
    record.sourceDomain === config.chainDomain && record.sourceGateway === config.sourceGateway,
  "SOURCE_CONTEXT", "candidate source scope mismatch");
  check(record.batchId === requestedBatchId && batch.batchId === requestedBatchId && record.epoch === batch.epoch &&
    record.messageCount === BigInt(batch.messages.length) && record.messageRoot === tree.messageRoot,
  "SNAPSHOT_INTEGRITY", "candidate batch ID, epoch, count, or Message Root mismatch");
  check(snapshot.members?.length === batch.messages.length && snapshot.members.every((member, index) =>
    member.position === BigInt(index) && member.messageId === batch.messageIds[index]),
  "SNAPSHOT_INTEGRITY", "candidate member positions or identities mismatch");
  return { batch, tree };
}

export async function validateMembersAgainstChain({ config, publicClient, snapshot, head }) {
  const { batch } = validateCandidateSnapshot(snapshot, config, snapshot.record.batchId);
  const blocks = new Map();
  const receipts = new Map();
  const validated = [];
  for (const member of batch.messages) {
    check(member.sourceBlockNumber <= head.number, "INSUFFICIENT_DEPTH", "source block is above the fixed validation head");
    let block = blocks.get(member.sourceBlockNumber.toString());
    if (!block) {
      block = await publicClient.getBlock({ blockNumber: member.sourceBlockNumber });
      blocks.set(member.sourceBlockNumber.toString(), block);
    }
    check(block.number === member.sourceBlockNumber && normalizeBytes32(block.hash) === member.sourceBlockHash,
      "CANONICAL_BLOCK", "finalized occurrence does not match its canonical Chain A block");
    check(isFinalizedByDepth({ sourceBlockNumber: member.sourceBlockNumber, headBlockNumber: head.number,
      finalityBlockDepth: config.finalityBlockDepth }), "INSUFFICIENT_DEPTH", "source occurrence has not reached configured finality depth");
    let receipt = receipts.get(member.sourceTransactionHash);
    if (!receipt) {
      receipt = await publicClient.getTransactionReceipt({ hash: member.sourceTransactionHash });
      receipts.set(member.sourceTransactionHash, receipt);
    }
    check(receipt.status === "success" && receipt.blockNumber === member.sourceBlockNumber &&
      normalizeBytes32(receipt.blockHash) === member.sourceBlockHash &&
      normalizeBytes32(receipt.transactionHash) === member.sourceTransactionHash,
    "SOURCE_RECEIPT", "source receipt is not the expected canonical successful transaction");
    const matching = receipt.logs.filter((log) => log.logIndex !== null && log.logIndex !== undefined &&
      BigInt(log.logIndex) === member.sourceLogIndex);
    check(matching.length === 1, "SOURCE_LOG", "source log occurrence is missing or ambiguous");
    const log = matching[0];
    // Decode actual RPC bytes/topics, never a caller/database-provided args shortcut.
    const event = decodeCrossChainMessageLog({
      address: log.address, blockNumber: log.blockNumber, blockHash: log.blockHash,
      transactionHash: log.transactionHash, logIndex: log.logIndex, data: log.data, topics: log.topics,
    }, { expectedGateway: config.sourceGateway, expectedSourceDomain: config.chainDomain });
    const actual = normalizeBatchMessage({ ...event, status: "FINALIZED" }, batch);
    check(Object.keys(member).every((field) => actual[field] === member[field]),
      "SOURCE_MESSAGE", "canonical source event differs from persisted batch member");
    validated.push(actual);
  }
  const rebuilt = buildMessageBatch({ ...batch, messages: validated });
  const tree = buildMessageMerkleTree(rebuilt);
  check(rebuilt.batchId === snapshot.record.batchId && tree.messageRoot === snapshot.record.messageRoot,
    "SNAPSHOT_INTEGRITY", "independently reconstructed batch ID or root mismatch");
  const anchor = await publicClient.getBlock({ blockNumber: head.number });
  check(anchor.number === head.number && normalizeBytes32(anchor.hash) === head.hash,
    "HEAD_CHANGED", "fixed Chain A head snapshot changed during validation");
  return { batch: rebuilt, tree };
}

export function createBatchValidationService({ config, sourcePool, store,
  publicClient = createChainClient(config), reader = createSourceBatchReader({ config, pool: sourcePool }), logger = console }) {
  return {
    async validate(batchId) {
      const id = normalizeBytes32(batchId, "batch ID");
      let head;
      let snapshot;
      let integrityChecked = false;
      try {
        await validateSourceContext(publicClient, config);
        const block = await publicClient.getBlock({ blockTag: "latest" });
        check(typeof block.number === "bigint", "RPC_HEAD", "Chain A head has no exact block number");
        head = { number: block.number, hash: normalizeBytes32(block.hash, "source head hash") };
        snapshot = await reader.read(id);
        validateCandidateSnapshot(snapshot, config, id);
        integrityChecked = true;
        await validateMembersAgainstChain({ config, publicClient, snapshot, head });
      } catch (error) {
        const reason = error instanceof SourceValidationError ? error.code : "INVALID_SOURCE_OR_SNAPSHOT";
        let message = error.message;
        for (const secret of [config.privateKey, config.databaseUrl, config.sourceDatabaseUrl]) {
          if (secret) message = message.replaceAll(secret, "<redacted>");
        }
        logger.warn(`Validator local validation rejected (${reason}): ${message}`);
        // Only an integrity-checked candidate can establish a local snapshot binding.
        if (integrityChecked && head && error instanceof SourceValidationError && error.code !== "RPC_UNAVAILABLE") {
          await store.recordObservation({ snapshot, head, result: "INVALID", reason });
        }
        return { validatorAddress: config.validatorAddress, batchId: id, result: "INVALID", reason,
          sourceHeadNumber: head?.number.toString() ?? null, sourceHeadHash: head?.hash ?? null };
      }
      const observation = await store.recordObservation({ snapshot, head, result: "VALID" });
      return { validatorAddress: config.validatorAddress, batchId: id, result: "VALID",
        batchEpoch: snapshot.record.epoch.toString(), messageRoot: snapshot.record.messageRoot,
        sourceHeadNumber: head.number.toString(), sourceHeadHash: head.hash,
        observedAt: observation.validated_at.toISOString() };
    },
  };
}
