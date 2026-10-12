import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { createRelaySubmissionRepository } from "../relayer/repository.mjs";
import { encodeDestinationSubmission } from "../relayer/encoding.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { createTransactionRepository } from "./repository.mjs";
import { createTransactionRpc } from "./rpc.mjs";
import { rpcQuantity, signDeliveryTransaction } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";

export function createTransactionManager({ config, pool, queue = createDeliveryRepository({ config, pool }),
  rpc = createTransactionRpc(config), account = privateKeyToAccount(config.privateKey), repository,
  legacy = createRelaySubmissionRepository({ config, pool, queue }), beforeSignedCommit }) {
  const verification = { validatorSets: config.validatorSets, sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway };
  async function protect(operation) {
    try { return await operation(); }
    catch (error) { const safe = new TransactionError(error?.code ?? "TRANSACTION_MANAGER_FAILED"); safe.message = safeRelayerMessage(error, config); throw safe; }
  }
  async function verifyChain() {
    if (await rpc.verifyChain() !== config.destinationDomain) throw new TransactionError("CHAIN_ID_MISMATCH");
  }
  async function resolveIntent(deliveryJobId) {
    const job = await queue.getDeliveryJob(deliveryJobId);
    if (job.deliveryJobId !== deliveryJobId || job.status !== "READY") throw new TransactionError("TRANSACTION_REQUIRES_READY");
    const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(deliveryJobId), verification);
    const message = encoded.package.message;
    if (encoded.package.deliveryJobId !== deliveryJobId || message.destinationDomain !== config.destinationDomain.toString() ||
        job.destinationDomain !== message.destinationDomain || normalizeAddress(job.destinationGateway) !== message.destinationGateway) {
      throw new TransactionError("DESTINATION_CONTEXT_MISMATCH");
    }
    return Object.freeze({ deliveryJobId, packageDigest: encoded.packageDigest, chainId: message.destinationDomain,
      senderAddress: normalizeAddress(config.relayerAddress), destinationGateway: message.destinationGateway, value: "0", calldata: encoded.data });
  }
  const store = repository ?? createTransactionRepository({ config, pool, resolveIntent, beforeSignedCommit });
  async function prepare(deliveryJobId) {
    const intent = await resolveIntent(deliveryJobId);
    await verifyChain();
    const historicalSubmission = await legacy.getSubmission(deliveryJobId);
    if (historicalSubmission) return Object.freeze({ historicalSubmission, created: false });
    const existing = await store.getTransaction(deliveryJobId, intent);
    if (existing) return Object.freeze({ ...existing, created: false });
    const gasLimit = protocolInteger(await rpc.estimateGas(intent), "gas limit");
    const fees = await rpc.fees();
    const maxFeePerGas = protocolInteger(fees.maxFeePerGas, "max fee");
    const maxPriorityFeePerGas = protocolInteger(fees.maxPriorityFeePerGas, "priority fee");
    if (gasLimit === 0n || maxFeePerGas < maxPriorityFeePerGas) throw new TransactionError("INVALID_TRANSACTION_FIELDS");
    const pendingNonce = protocolInteger(await rpc.pendingNonce(), "pending nonce");
    const stored = await store.persistPrepared({ intent, pendingNonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas,
      sign: (canonical, fields) => signDeliveryTransaction(canonical, fields, account) });
    if (stored.nonceAdvancedFromRpc) console.log(`Transaction account advanced to RPC pending nonce ${stored.attempt.nonce}; account exclusivity must be maintained`);
    return stored;
  }
  async function assertNoUnbroadcast() {
    const [pending] = await store.listTransactions({ status: "SIGNED", limit: 1 });
    if (pending) throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
  }
  async function broadcast(deliveryJobId) {
    await verifyChain();
    return store.broadcastPrepared(deliveryJobId, (raw) => rpc.broadcast(raw));
  }
  return {
    repository: store,
    async resolveIntent(deliveryJobId) { return protect(() => resolveIntent(deliveryJobId)); },
    async verifyChain() { return protect(async () => { await verifyChain(); return config.destinationDomain; }); },
    async assertNoUnbroadcast() { return protect(assertNoUnbroadcast); },
    async prepareDeliveryTransaction(deliveryJobId) { return protect(() => prepare(deliveryJobId)); },
    async broadcastPreparedTransaction(deliveryJobId) { return protect(() => broadcast(deliveryJobId)); },
    async submitDelivery(deliveryJobId) {
      return protect(async () => {
        const intent = await resolveIntent(deliveryJobId);
        await verifyChain();
        const historicalSubmission = await legacy.getSubmission(deliveryJobId);
        if (historicalSubmission) return Object.freeze({ historicalSubmission, submitted: false });
        const existing = await store.getTransaction(deliveryJobId, intent);
        if (existing) {
          if (existing.attempt.status === "SIGNED") throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
          return Object.freeze({ ...existing, submitted: false });
        }
        await assertNoUnbroadcast();
        const prepared = await prepare(deliveryJobId);
        // Another explicit preparation can win this job. Never automatically
        // rebroadcast an attempt that this invocation did not create.
        if (!prepared.created) throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
        const result = await broadcast(deliveryJobId);
        return Object.freeze({ ...result, submitted: result.broadcast });
      });
    },
    async checkReceiptsOnce({ limit = config.maxJobs } = {}) {
      return protect(async () => {
        await verifyChain();
        const head = protocolInteger(await rpc.head(), "head");
        const records = await store.listTransactions({ status: "BROADCAST", limit });
        const results = [];
        for (const stored of records) {
          const { intent, attempt } = stored;
          const receipt = await rpc.receipt(attempt.transactionHash);
          if (receipt === null) { results.push(stored); continue; }
          if (!receipt || normalizeBytes32(receipt.transactionHash) !== attempt.transactionHash) throw new TransactionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
          const blockNumber = rpcQuantity(receipt.blockNumber, "receipt block");
          const blockHash = normalizeBytes32(receipt.blockHash, "receipt block hash");
          const receiptStatus = rpcQuantity(receipt.status, "receipt status");
          if (receiptStatus !== 0n && receiptStatus !== 1n) throw new TransactionError("INVALID_RECEIPT_STATUS");
          if (blockNumber > head) { results.push(stored); continue; }
          const block = await rpc.block(blockNumber);
          if (!block || rpcQuantity(block.number, "canonical block") !== blockNumber || normalizeBytes32(block.hash) !== blockHash) {
            throw new TransactionError("NONCANONICAL_TRANSACTION_RECEIPT");
          }
          const tx = await rpc.transaction(attempt.transactionHash);
          if (!tx || normalizeBytes32(tx.hash) !== attempt.transactionHash || normalizeAddress(tx.from) !== intent.senderAddress ||
              normalizeAddress(tx.to) !== intent.destinationGateway || tx.input?.toLowerCase() !== intent.calldata ||
              rpcQuantity(tx.nonce, "transaction nonce").toString() !== attempt.nonce || rpcQuantity(tx.value, "transaction value") !== 0n ||
              rpcQuantity(tx.type, "transaction type") !== 2n || rpcQuantity(tx.chainId, "transaction chain") !== config.destinationDomain ||
              rpcQuantity(tx.blockNumber, "transaction block") !== blockNumber || normalizeBytes32(tx.blockHash) !== blockHash ||
              rpcQuantity(tx.gas, "transaction gas").toString() !== attempt.gasLimit ||
              rpcQuantity(tx.maxFeePerGas, "transaction fee").toString() !== attempt.maxFeePerGas ||
              rpcQuantity(tx.maxPriorityFeePerGas, "transaction priority fee").toString() !== attempt.maxPriorityFeePerGas) {
            throw new TransactionError("RECEIPT_TRANSACTION_CONTEXT_MISMATCH");
          }
          if (head - blockNumber + 1n < config.destinationConfirmations) { results.push(stored); continue; }
          results.push(await store.recordOutcome(intent.deliveryJobId, { transactionHash: attempt.transactionHash,
            blockNumber, blockHash, status: Number(receiptStatus), head }));
        }
        return Object.freeze({ head: head.toString(), checked: records.length,
          confirmed: results.filter((value) => value.attempt.status === "CONFIRMED").length,
          reverted: results.filter((value) => value.attempt.status === "REVERTED").length, results: Object.freeze(results) });
      });
    },
  };
}
