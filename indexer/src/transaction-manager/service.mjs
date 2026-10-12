import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "../canonical-message.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { createRelaySubmissionRepository } from "../relayer/repository.mjs";
import { encodeDestinationSubmission } from "../relayer/encoding.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { createTransactionRepository } from "./repository.mjs";
import { createTransactionRpc } from "./rpc.mjs";
import { signDeliveryTransaction, rpcQuantity } from "./transaction.mjs";
import { inspectIntentReceipts, verifyRpcTransaction } from "./receipts.mjs";
import { operationTime, replacementDue, replacementFees } from "./retry-policy.mjs";
import { processTransactionRetriesOnce } from "./retry.mjs";
import { TransactionError } from "./config.mjs";

export function createTransactionManager({ config,pool,queue = createDeliveryRepository({ config,pool }),
  rpc = createTransactionRpc(config),account = privateKeyToAccount(config.privateKey),repository,
  legacy = createRelaySubmissionRepository({ config,pool,queue }),beforeSignedCommit,clock = { now: Date.now } }) {
  const verification = { validatorSets: config.validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway };
  async function protect(operation) {
    try { return await operation(); }
    catch (error) { const safe = new TransactionError(error?.code ?? "TRANSACTION_MANAGER_FAILED"); safe.message = safeRelayerMessage(error,config); throw safe; }
  }
  async function verifyChain() {
    if (await rpc.verifyChain() !== config.destinationDomain) throw new TransactionError("CHAIN_ID_MISMATCH");
  }
  async function resolveIntent(id) {
    const job = await queue.getDeliveryJob(id);
    if (job.deliveryJobId !== id || job.status !== "READY") throw new TransactionError("TRANSACTION_REQUIRES_READY");
    const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(id),verification);
    const message = encoded.package.message;
    if (encoded.package.deliveryJobId !== id || message.destinationDomain !== config.destinationDomain.toString() ||
        job.destinationDomain !== message.destinationDomain || normalizeAddress(job.destinationGateway) !== message.destinationGateway) throw new TransactionError("DESTINATION_CONTEXT_MISMATCH");
    return Object.freeze({ deliveryJobId: id,packageDigest: encoded.packageDigest,chainId: message.destinationDomain,
      senderAddress: normalizeAddress(config.relayerAddress),destinationGateway: message.destinationGateway,value: "0",calldata: encoded.data });
  }
  const store = repository ?? createTransactionRepository({ config,pool,resolveIntent,beforeSignedCommit,clock });
  const sign = (intent,fields) => signDeliveryTransaction(intent,fields,account);
  const inspect = (stored,head,forceAll = false) => inspectIntentReceipts({ stored,rpc,store,config,head: protocolInteger(head,"head"),forceAll });

  async function prepare(id) {
    const intent = await resolveIntent(id);
    await verifyChain();
    const historicalSubmission = await legacy.getSubmission(id);
    if (historicalSubmission) return Object.freeze({ historicalSubmission,created: false });
    const existing = await store.getTransaction(id,intent);
    if (existing) return Object.freeze({ ...existing,created: false });
    const gasLimit = protocolInteger(await rpc.estimateGas(intent),"gas limit");
    const market = await rpc.fees();
    const maxFeePerGas = protocolInteger(market.maxFeePerGas,"max fee");
    const maxPriorityFeePerGas = protocolInteger(market.maxPriorityFeePerGas,"priority fee");
    if (gasLimit === 0n || maxFeePerGas < maxPriorityFeePerGas) throw new TransactionError("INVALID_TRANSACTION_FIELDS");
    if (maxFeePerGas > config.maxFeePerGasCap || maxPriorityFeePerGas > config.maxPriorityFeePerGasCap) throw new TransactionError("FEE_CAP_EXCEEDED");
    const pendingNonce = protocolInteger(await rpc.pendingNonce(),"pending nonce");
    const stored = await store.persistPrepared({ intent,pendingNonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas,sign });
    if (stored.nonceAdvancedFromRpc) console.log(`Transaction account advanced to RPC pending nonce ${stored.intent.nonce}; maintain account exclusivity`);
    return stored;
  }
  async function assertNoUnbroadcast() {
    const [pending] = await store.listTransactions({ status: "SIGNED",limit: 1 });
    if (pending) throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
  }
  async function ownTransactions(stored) {
    const known = [];
    for (const attempt of stored.attempts) {
      const tx = await rpc.transaction(attempt.transactionHash);
      if (tx === null) continue;
      verifyRpcTransaction(stored.intent,attempt,tx);
      if (tx.blockNumber !== null && tx.blockNumber !== undefined) {
        const number = rpcQuantity(tx.blockNumber,"transaction block");
        const block = await rpc.block(number);
        if (!block || block.hash?.toLowerCase() !== tx.blockHash?.toLowerCase() || rpcQuantity(block.number) !== number) throw new TransactionError("NONCANONICAL_TRANSACTION_RECEIPT");
      }
      known.push({ attempt,tx,mined: tx.blockNumber != null });
    }
    return known;
  }
  async function reconcile(stored,head) {
    const [latest,pending] = await Promise.all([rpc.latestNonce(),rpc.pendingNonce()]);
    const observation = await inspect(stored,head,true);
    if (observation.mined) return observation;
    const known = await ownTransactions(stored);
    if (protocolInteger(latest) > BigInt(stored.intent.nonce) && !known.some(value => value.mined)) {
      await store.stopRetry(stored.intent.deliveryJobId,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    const current = known.find(value => value.attempt.attemptId === stored.attempt.attemptId);
    if (current) {
      const record = await store.markKnownAttempt(stored.intent.deliveryJobId,current.attempt.attemptId);
      return { stored: record,mined: known.some(value => value.mined),finalized: false,known: true };
    }
    if (known.length) return { stored,mined: known.some(value => value.mined),finalized: false,known: false };
    if (protocolInteger(pending) > BigInt(stored.intent.nonce)) {
      await store.stopRetry(stored.intent.deliveryJobId,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    return { stored,mined: false,finalized: false,known: false };
  }
  async function send(id,options = {}) {
    await verifyChain();
    const result = await store.broadcastPrepared(id,raw => rpc.broadcast(raw),options);
    if (["ALREADY_KNOWN","NONCE_TOO_LOW"].includes(result.errorClass)) {
      const reconciled = await reconcile(result,options.receiptHead ?? await rpc.head());
      if (reconciled.mined || reconciled.known) return Object.freeze({ ...reconciled.stored,broadcast: true,reconciled: true,errorClass: null,errorMessage: null,errorCode: null });
    }
    if (result.errorClass === "DETERMINISTIC_REJECTION") {
      const error = new TransactionError(result.errorCode ?? result.errorClass); error.message = result.errorMessage; throw error;
    }
    return result;
  }
  function reportBroadcast(result) {
    if (result.errorClass) {
      const error = new TransactionError(result.errorCode ?? result.errorClass); error.message = result.errorMessage; throw error;
    }
    return result;
  }
  async function replace(id,parentAttemptId,head) {
    await verifyChain();
    let stored = await store.getTransaction(id);
    if (!stored) throw new TransactionError("TRANSACTION_NOT_PREPARED");
    if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null ||
        (parentAttemptId !== undefined && stored.attempt.attemptId !== parentAttemptId)) return Object.freeze({ ...stored,created: false });
    const expectedParent = stored.attempt.attemptId;
    const now = operationTime(clock);
    if (new Date(stored.intent.nextActionAt).getTime() > now || !replacementDue(stored.attempt,now,config)) throw new TransactionError("REPLACEMENT_NOT_DUE");
    const snapshotHead = head === undefined ? await rpc.head() : head;
    const [latest,pending] = await Promise.all([rpc.latestNonce(),rpc.pendingNonce()]);
    const observation = await inspect(stored,snapshotHead,true);
    if (observation.mined) return Object.freeze({ ...observation.stored,created: false });
    const known = await ownTransactions(stored);
    if (known.some(value => value.mined)) return Object.freeze({ ...stored,created: false });
    if (protocolInteger(latest) > BigInt(stored.intent.nonce) || (!known.length && protocolInteger(pending) > BigInt(stored.intent.nonce))) {
      await store.stopRetry(id,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    if (stored.attempts.length >= config.maxAttempts) return Object.freeze({ ...await store.stopRetry(id,"MAX_ATTEMPTS_REACHED",{ parentAttemptId: stored.attempt.attemptId }),created: false });
    let fees;
    try { fees = replacementFees(stored.attempt,await rpc.fees(),config); }
    catch (error) {
      if (error.code === "INVALID_MAX_FEE") {
        await store.stopRetry(id,"REPLACEMENT_FEE_OVERFLOW",{ parentAttemptId: expectedParent });
        throw new TransactionError("REPLACEMENT_FEE_OVERFLOW");
      }
      if (["FEE_CAP_EXCEEDED","REPLACEMENT_FEE_OVERFLOW"].includes(error.code)) await store.stopRetry(id,error.code,{ parentAttemptId: stored.attempt.attemptId });
      throw error;
    }
    // Recheck all candidate receipts after fee RPC, immediately before insertion.
    stored = await store.getTransaction(id);
    if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null || stored.attempt.attemptId !== expectedParent) {
      return Object.freeze({ ...stored,created: false });
    }
    const recheck = await inspect(stored,snapshotHead,true);
    if (recheck.mined) return Object.freeze({ ...recheck.stored,created: false });
    return store.persistReplacement({ id,parentAttemptId: expectedParent,fees,sign });
  }
  return {
    repository: store,
    async resolveIntent(id) { return protect(() => resolveIntent(id)); },
    async verifyChain() { return protect(async () => { await verifyChain(); return config.destinationDomain; }); },
    async assertNoUnbroadcast() { return protect(assertNoUnbroadcast); },
    async prepareDeliveryTransaction(id) { return protect(() => prepare(id)); },
    async broadcastPreparedTransaction(id) { return protect(async () => reportBroadcast(await send(id))); },
    async rebroadcastTransaction(id) { return protect(async () => reportBroadcast(await send(id,{ rebroadcast: true }))); },
    async prepareReplacement(id,parentAttemptId) { return protect(() => replace(id,parentAttemptId)); },
    async processTransactionRetriesOnce({ limit = config.maxJobs } = {}) {
      return protect(() => processTransactionRetriesOnce({ config,store,rpc,verifyChain,inspect,send,replace,clock,limit }));
    },
    async submitDelivery(id) {
      return protect(async () => {
        const intent = await resolveIntent(id); await verifyChain();
        const historicalSubmission = await legacy.getSubmission(id);
        if (historicalSubmission) return Object.freeze({ historicalSubmission,submitted: false });
        const existing = await store.getTransaction(id,intent);
        if (existing) {
          if (existing.attempt.status === "SIGNED" && existing.intent.status === "PENDING") throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
          return Object.freeze({ ...existing,submitted: false });
        }
        await assertNoUnbroadcast();
        const prepared = await prepare(id);
        if (!prepared.created) throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
        const result = reportBroadcast(await send(id,{ expectedAttemptId: prepared.attempt.attemptId }));
        return Object.freeze({ ...result,submitted: result.broadcast });
      });
    },
    async checkReceiptsOnce({ limit = config.maxJobs } = {}) {
      return protect(async () => {
        await verifyChain(); const head = protocolInteger(await rpc.head(),"head");
        const records = await store.listTrackingIntents({ limit });
        const results = [];
        for (const stored of records) results.push((await inspect(stored,head)).stored);
        return Object.freeze({ head: head.toString(),checked: records.length,
          confirmed: results.filter(value => value.intent.status === "CONFIRMED").length,
          reverted: results.filter(value => value.intent.status === "REVERTED").length,results: Object.freeze(results) });
      });
    },
  };
}
