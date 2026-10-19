import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "../canonical-message.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { createRelaySubmissionRepository } from "../relayer/repository.mjs";
import { encodeGatewaySubmission } from "../relayer/encoding.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { createTransactionRepository } from "./repository.mjs";
import { createTransactionRpc } from "./rpc.mjs";
import { signDeliveryTransaction, rpcQuantity } from "./transaction.mjs";
import { inspectIntentReceipts, observeIntentReceipts, verifyRpcTransaction } from "./receipts.mjs";
import { revalidateTerminalReceipts } from "./receipt-reconciliation.mjs";
import { operationTime, replacementDue, replacementFees } from "./retry-policy.mjs";
import { processTransactionRetriesOnce } from "./retry.mjs";
import { TransactionError } from "./config.mjs";
import { recoverTransactionsOnce } from "./recovery.mjs";
import { BROADCAST_ERROR_CLASSES, ESTIMATE_EXECUTION_REVERT } from "./rpc-errors.mjs";
import { DestinationRpcError } from "./rpc-pool.mjs";

export function createTransactionManager({ config,pool,queue = createDeliveryRepository({ config,pool }),
  rpc = createTransactionRpc(config),account = privateKeyToAccount(config.privateKey),repository,
  legacy = createRelaySubmissionRepository({ config,pool,queue }),beforeSignedCommit,hooks = {},clock = { now: Date.now } }) {
  const verification = { validatorSets: config.validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway };
  async function protect(operation) {
    try { return await operation(); }
    catch (error) {
      const safe = new TransactionError(error?.code ?? "TRANSACTION_MANAGER_FAILED");
      safe.message = safeRelayerMessage(error,config); safe.observations = error?.observations ?? [];
      if (BROADCAST_ERROR_CLASSES.includes(error?.errorClass)) safe.errorClass = error.errorClass;
      throw safe;
    }
  }
  async function verifyChain() {
    if (await rpc.verifyChain() !== config.destinationDomain) throw new TransactionError("CHAIN_ID_MISMATCH");
  }
  async function resolveIntent(id) {
    const [{ job,package: deliveryPackage }] = await queue.getDeliveryEntries([id]);
    if (job.deliveryJobId !== id || job.status !== "READY") throw new TransactionError("TRANSACTION_REQUIRES_READY");
    const encoded = await encodeGatewaySubmission(deliveryPackage,verification);
    const message = encoded.package.message;
    if (encoded.package.deliveryJobId !== id || message.destinationDomain !== config.destinationDomain.toString() ||
        job.destinationDomain !== message.destinationDomain || normalizeAddress(job.destinationGateway) !== message.destinationGateway) throw new TransactionError("DESTINATION_CONTEXT_MISMATCH");
    return Object.freeze({ deliveryJobId: id,packageDigest: encoded.packageDigest,chainId: message.destinationDomain,
      senderAddress: normalizeAddress(config.relayerAddress),destinationGateway: message.destinationGateway,value: "0",
      calldata: encoded.calldata,historicalCalldata: encoded.data });
  }
  const store = repository ?? createTransactionRepository({ config,pool,resolveIntent,beforeSignedCommit,hooks,clock });
  const sign = (intent,fields) => signDeliveryTransaction(intent,fields,account);
  const inspect = (stored,view,forceAll = false,fence) => inspectIntentReceipts({ stored,rpc,store,config,view,forceAll,fence,hooks });
  const recover = (id,fence,receiptView) => recoverTransactionsOnce({ store,rpc,config,send,hooks,deliveryJobId: id,fence,receiptView });
  const resolveMessageId = async id => (await queue.getDeliveryEntries([id]))[0].package.message.messageId;

  async function prepare(id,fence) {
    if (fence) await store.assertFence(id,fence);
    const intent = await resolveIntent(id);
    await verifyChain();
    const historicalSubmission = await legacy.getSubmission(id);
    if (historicalSubmission) return Object.freeze({ historicalSubmission,created: false });
    const existing = await store.getTransaction(id,intent);
    if (existing) return Object.freeze({ ...existing,created: false });
    let estimate;
    try { estimate = await rpc.estimateGas(intent); }
    catch (error) {
      // This signal can originate only here, after validated evidence/identity
      // and the absent-intent check, before fees, nonce, persistence or signing.
      if (error instanceof DestinationRpcError && error.code === ESTIMATE_EXECUTION_REVERT && error.errorClass === "DETERMINISTIC_REJECTION") {
        throw new TransactionError("PREPARATION_EXECUTION_REJECTED");
      }
      throw error;
    }
    const gasLimit = protocolInteger(estimate,"gas limit");
    const market = await rpc.fees();
    const maxFeePerGas = protocolInteger(market.maxFeePerGas,"max fee");
    const maxPriorityFeePerGas = protocolInteger(market.maxPriorityFeePerGas,"priority fee");
    if (gasLimit === 0n || maxFeePerGas < maxPriorityFeePerGas) throw new TransactionError("INVALID_TRANSACTION_FIELDS");
    if (maxFeePerGas > config.maxFeePerGasCap || maxPriorityFeePerGas > config.maxPriorityFeePerGasCap) throw new TransactionError("FEE_CAP_EXCEEDED");
    const pendingNonce = protocolInteger(await rpc.pendingNonce(),"pending nonce");
    const stored = await store.persistPrepared({ intent,pendingNonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas,sign,fence });
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
  async function reconcile(stored,view,fence) {
    const [latest,pending] = await Promise.all([rpc.latestNonce(view),rpc.pendingNonce()]);
    const observation = await inspect(stored,view,true,fence);
    if (observation.mined) return observation;
    const known = await ownTransactions(stored);
    if (protocolInteger(latest) > BigInt(stored.intent.nonce) && !known.some(value => value.mined)) {
      await store.stopRetry(stored.intent.deliveryJobId,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId,fence });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    const current = known.find(value => value.attempt.attemptId === stored.attempt.attemptId);
    if (current) {
      const record = await store.markKnownAttempt(stored.intent.deliveryJobId,current.attempt.attemptId,{ fence });
      return { stored: record,mined: known.some(value => value.mined),finalized: false,known: true };
    }
    if (known.length) return { stored,mined: known.some(value => value.mined),finalized: false,known: false };
    if (protocolInteger(pending) > BigInt(stored.intent.nonce)) {
      await store.stopRetry(stored.intent.deliveryJobId,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId,fence });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    return { stored,mined: false,finalized: false,known: false };
  }
  async function send(id,options = {}) {
    return store.withRecoveryLock(id,context => sendLocked(id,{ ...options,recoveryContext: context }),options.recoveryContext);
  }
  async function sendLocked(id,options = {}) {
    await verifyChain();
    async function checkReorgSend(atEndpoint = false) {
      const stored = await store.getTransaction(id);
      if (!stored.intent.reorgRecovery) return true;
      if (options.fence) await store.assertFence(id,options.fence);
      // Confirmation decisions keep the caller's conservative pass view.
      // The endpoint guard is a fresh send check and never confirms receipts.
      const view = atEndpoint ? await rpc.readView() : options.receiptView ?? await rpc.readView();
      const observed = await observeIntentReceipts({ stored,rpc,config,view,forceAll: true,hooks });
      await rpc.assertView(view);
      if (observed.winner) {
        if (!atEndpoint) {
          await inspect(stored,view,true,options.fence);
          return false;
        }
        throw new TransactionError("RPC_VIEW_INCOMPLETE");
      }
      if (await rpc.gatewayReplay(stored.intent.destinationGateway,await resolveMessageId(id),view)) {
        await store.stopRetry(id,"GATEWAY_ALREADY_EXECUTED",{ fence: options.fence });
        if (atEndpoint) throw new TransactionError("GATEWAY_ALREADY_EXECUTED");
        return false;
      }
      const known = await ownTransactions(stored);
      const [latest,pending] = await Promise.all([rpc.latestNonce(view),rpc.pendingNonce()]);
      await rpc.assertView(view);
      if (known.some(value => value.mined)) throw new TransactionError("RPC_VIEW_INCOMPLETE");
      if (latest > BigInt(stored.intent.nonce) || (!known.length && pending > BigInt(stored.intent.nonce))) {
        await store.stopRetry(id,"UNKNOWN_NONCE_CONSUMPTION",{ fence: options.fence });
        throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
      }
      if (options.fence) await store.assertFence(id,options.fence);
      return true;
    }
    if (!await checkReorgSend()) return Object.freeze({ ...await store.getTransaction(id),broadcast: false });
    let rpcObservation;
    const result = await store.broadcastPrepared(id,(raw,transactionHash,lifecycle) => rpc.broadcast(raw,transactionHash,value => { rpcObservation = value; },lifecycle),
      { ...options,beforeEndpoint: () => checkReorgSend(true) });
    if (["ALREADY_KNOWN","NONCE_TOO_LOW"].includes(result.errorClass)) {
      const reconciled = await reconcile(result,options.receiptView ?? await rpc.readView(),options.fence);
      if (reconciled.mined || reconciled.known) return Object.freeze({ ...reconciled.stored,broadcast: true,reconciled: true,errorClass: null,errorMessage: null,errorCode: null,
        acceptedEndpointLabel: rpcObservation?.acceptedEndpointLabel ?? null,rpcObservations: rpcObservation?.observations ?? [] });
    }
    if (["DETERMINISTIC_REJECTION","RPC_RESPONSE_ERROR"].includes(result.errorClass)) {
      const error = new TransactionError(result.errorCode ?? result.errorClass);
      error.errorClass = result.errorClass;
      error.message = result.errorMessage; error.observations = rpcObservation?.observations ?? []; throw error;
    }
    return Object.freeze({ ...result,acceptedEndpointLabel: rpcObservation?.acceptedEndpointLabel ?? null,rpcObservations: rpcObservation?.observations ?? [] });
  }
  function reportBroadcast(result) {
    if (result.errorClass) {
      const error = new TransactionError(result.errorCode ?? result.errorClass);
      error.errorClass = result.errorClass;
      error.message = result.errorMessage; error.observations = result.rpcObservations ?? []; throw error;
    }
    return result;
  }
  async function replace(id,parentAttemptId,view,fence) {
    try { return await store.withRecoveryLock(id,() => replaceLocked(id,parentAttemptId,view,fence)); }
    catch (error) {
      if (error.code !== "TRANSACTION_RECOVERY_BUSY") throw error;
      // Another recovery/send/replacement owns this intent. Return existing
      // durable evidence without signing a competing candidate or waiting on RPC.
      if (fence) await store.assertFence(id,fence);
      return Object.freeze({ ...await store.getTransaction(id),created: false });
    }
  }
  async function replaceLocked(id,parentAttemptId,view,fence) {
    await verifyChain();
    let stored = await store.getTransaction(id);
    if (!stored) throw new TransactionError("TRANSACTION_NOT_PREPARED");
    if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null || stored.intent.reorgRecovery?.rebroadcastRequired ||
        (parentAttemptId !== undefined && stored.attempt.attemptId !== parentAttemptId)) return Object.freeze({ ...stored,created: false });
    const expectedParent = stored.attempt.attemptId;
    const now = operationTime(clock);
    if (new Date(stored.intent.nextActionAt).getTime() > now || !replacementDue(stored.attempt,now,config)) throw new TransactionError("REPLACEMENT_NOT_DUE");
    const snapshotView = view ?? await rpc.readView();
    const [latest,pending] = await Promise.all([rpc.latestNonce(snapshotView),rpc.pendingNonce()]);
    const observation = await inspect(stored,snapshotView,true,fence);
    if (observation.mined) return Object.freeze({ ...observation.stored,created: false });
    const known = await ownTransactions(stored);
    if (known.some(value => value.mined)) return Object.freeze({ ...stored,created: false });
    if (protocolInteger(latest) > BigInt(stored.intent.nonce) || (!known.length && protocolInteger(pending) > BigInt(stored.intent.nonce))) {
      await store.stopRetry(id,"UNKNOWN_NONCE_CONSUMPTION",{ parentAttemptId: stored.attempt.attemptId,fence });
      throw new TransactionError("UNKNOWN_NONCE_CONSUMPTION");
    }
    if (stored.attempts.length >= config.maxAttempts) return Object.freeze({ ...await store.stopRetry(id,"MAX_ATTEMPTS_REACHED",{ parentAttemptId: stored.attempt.attemptId,fence }),created: false });
    let fees;
    try { fees = replacementFees(stored.attempt,await rpc.fees(),config); }
    catch (error) {
      if (error.code === "INVALID_MAX_FEE") {
        await store.stopRetry(id,"REPLACEMENT_FEE_OVERFLOW",{ parentAttemptId: expectedParent,fence });
        throw new TransactionError("REPLACEMENT_FEE_OVERFLOW");
      }
      if (["FEE_CAP_EXCEEDED","REPLACEMENT_FEE_OVERFLOW"].includes(error.code)) await store.stopRetry(id,error.code,{ parentAttemptId: stored.attempt.attemptId,fence });
      throw error;
    }
    // Recheck all candidate receipts after fee RPC, immediately before insertion.
    stored = await store.getTransaction(id);
    if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null || stored.attempt.attemptId !== expectedParent) {
      return Object.freeze({ ...stored,created: false });
    }
    const recheck = await inspect(stored,snapshotView,true,fence);
    if (recheck.mined) return Object.freeze({ ...recheck.stored,created: false });
    return store.persistReplacement({ id,parentAttemptId: expectedParent,fees,sign,fence });
  }
  return {
    repository: store,
    async resolveIntent(id) { return protect(() => resolveIntent(id)); },
    async verifyChain() { return protect(async () => { await verifyChain(); return config.destinationDomain; }); },
    async assertNoUnbroadcast() { return protect(assertNoUnbroadcast); },
    async prepareDeliveryTransaction(id,{ fence } = {}) { return protect(() => prepare(id,fence)); },
    // Fenced orchestration and independent durable manager passes share the same
    // account/intent locks. A durable intent does not require a permanent owner.
    async continueDeliveryTransactionOnce(id,{ fence } = {}) {
      return protect(async () => {
        if (!fence) throw new TransactionError("LEASE_FENCE_REQUIRED");
        await store.assertFence(id,fence);
        const recovery = await recoverTransactionsOnce({ store,rpc,config,send,hooks,deliveryJobId: id,fence });
        let stored = await store.getTransaction(id);
        if (!stored) throw new TransactionError("TRANSACTION_NOT_PREPARED");
        const recoveryFailure = recovery.results.find(result => result.reason || result.errorClass);
        if (recoveryFailure) {
          const error = new TransactionError(recoveryFailure.errorCode ?? recoveryFailure.reason ?? recoveryFailure.errorClass);
          error.message = recoveryFailure.errorMessage ?? error.message;
          error.observations = recoveryFailure.rpcObservations ?? [];
          throw error;
        }
        if (recovery.results.some(result => result.action === "RECEIPT_UNCONFIRMED") && stored.intent.retryStoppedAt === null) {
          stored = await store.scheduleRetry(id,{ fence,parentAttemptId: stored.attempt.attemptId });
        }
        if (recovery.rebroadcast || recovery.finalized || recovery.reconciled || stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null) {
          const sent = recovery.results.find(result => result.acceptedEndpointLabel);
          return Object.freeze({ ...stored,submitted: recovery.rebroadcast > 0,recovery,
            acceptedEndpointLabel: sent?.acceptedEndpointLabel ?? null,rpcObservations: sent?.rpcObservations ?? [] });
        }
        await verifyChain();
        const view = await rpc.readView();
        const observation = await inspect(stored,view,false,fence);
        if (observation.mined) return Object.freeze({ ...observation.stored,submitted: false });
        const processed = await processTransactionRetriesOnce({ config,store,rpc,verifyChain,inspect,send,replace,recover,clock,
          limit: 1,deliveryJobId: id,fence });
        stored = await store.getTransaction(id);
        return Object.freeze({ ...stored,submitted: processed.broadcasts > 0,processing: processed });
      });
    },
    async broadcastPreparedTransaction(id) { return protect(async () => reportBroadcast(await send(id))); },
    async rebroadcastTransaction(id) { return protect(async () => reportBroadcast(await send(id,{ rebroadcast: true }))); },
    async prepareReplacement(id,parentAttemptId) { return protect(() => replace(id,parentAttemptId)); },
    async processTransactionRetriesOnce({ limit = config.maxJobs } = {}) {
      return protect(() => processTransactionRetriesOnce({ config,store,rpc,verifyChain,inspect,send,replace,recover,clock,limit }));
    },
    async recoverTransactionsOnce({ limit = config.maxJobs,deliveryJobId,fence } = {}) {
      return protect(() => recoverTransactionsOnce({ store,rpc,config,send,hooks,limit,deliveryJobId,fence }));
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
        const terminalIds = await store.listTerminalIntents({ limit });
        const records = await store.listTrackingIntents({ limit });
        await verifyChain(); const view = await rpc.readView(); const head = view.head;
        const results = [];
        for (const stored of records) results.push((await inspect(stored,view)).stored);
        const terminal = await revalidateTerminalReceipts({ ids: terminalIds,store,rpc,config,view,resolveMessageId,hooks });
        return Object.freeze({ head: head.toString(),checked: records.length,
          confirmed: results.filter(value => value.intent.status === "CONFIRMED").length,
          reverted: results.filter(value => value.intent.status === "REVERTED").length,results: Object.freeze(results),terminal });
      });
    },
  };
}
