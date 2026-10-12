import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { deliveryJson, buildDeliveryPackages } from "../../src/delivery/package.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig, TransactionError } from "../../src/transaction-manager/config.mjs";
import { allocateNonce } from "../../src/transaction-manager/nonce-policy.mjs";
import { verifySignedTransaction } from "../../src/transaction-manager/transaction.mjs";
import { classifyBroadcastError } from "../../src/transaction-manager/rpc-errors.mjs";
import { replacementDue } from "../../src/transaction-manager/retry-policy.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { normalizeBytes32 } from "../../src/canonical-message.mjs";
import { deliveryFixture, fixtureHash } from "./delivery-fixtures.mjs";
import { relayerEnvironment } from "./relayer-fixtures.mjs";

export const cloneTransactionValue = value => JSON.parse(deliveryJson(value));
export function transactionConfig(overrides = {}) { return loadTransactionConfig(relayerEnvironment(overrides)); }
export const transientSendError = (message = "injected send failure") => Object.assign(new Error(message),{ code: "ECONNREFUSED" });

export async function transactionHarness({ config = transactionConfig(),mutate,beforeCommit,account } = {}) {
  const packets = cloneTransactionValue(await buildDeliveryPackages(await deliveryFixture(),{ validatorSets: config.validatorSets }));
  const original = cloneTransactionValue(packets);
  if (mutate) mutate(packets[0]);
  const jobs = packets.map(pack => ({ deliveryJobId: pack.deliveryJobId,status: "READY",
    destinationDomain: pack.message.destinationDomain,destinationGateway: pack.message.destinationGateway }));
  const queue = { async getDeliveryJob(id) { return jobs.find(job => job.deliveryJobId === id); },
    async getDeliveryPackage(id) { return packets.find(pack => pack.deliveryJobId === id); } };
  const records = new Map();
  const historical = new Map();
  const calls = { gas: 0,fees: 0,pending: 0,latest: 0,sign: 0,broadcast: [],head: 0 };
  let nextNonce = null;
  let nextAttempt = 1;
  let time = Date.UTC(2026,0,1);
  const clock = { now: () => time };
  const timestamp = () => new Date(time).toISOString();
  const nextAction = () => new Date(time + config.rebroadcastIntervalMs).toISOString();
  const state = { pendingNonce: 9n,latestNonce: 9n,head: 100n,actualChain: config.destinationDomain,
    fees: { maxFeePerGas: 3000000000n,maxPriorityFeePerGas: 1000000000n },
    receipts: new Map(),transactions: new Map(),blocks: new Map() };
  async function strict(id,expected) {
    const record = records.get(id);
    if (!record) return null;
    if (expected && Object.keys(expected).some(key => record.intent[key] !== expected[key])) throw new TransactionError("CONFLICTING_TRANSACTION_INTENT");
    for (const [index,attempt] of record.attempts.entries()) {
      await verifySignedTransaction(record.intent,attempt);
      if (attempt.attemptNumber !== index || attempt.nonce !== record.intent.nonce ||
          attempt.replacementOfAttemptId !== (index ? record.attempts[index - 1].attemptId : null)) throw new TransactionError("CORRUPTED_TRANSACTION_LINEAGE");
    }
    if (nextNonce <= BigInt(record.intent.nonce)) throw new TransactionError("NONCE_STATE_REGRESSION");
    return cloneTransactionValue(record);
  }
  function attemptRecord(intent,signed,number,parentId) {
    return cloneTransactionValue({ ...signed,attemptId: String(nextAttempt++),intentId: intent.deliveryJobId,deliveryJobId: intent.deliveryJobId,
      attemptNumber: number,replacementOfAttemptId: parentId,status: "SIGNED",broadcastAt: null,broadcastAttemptCount: "0",
      lastBroadcastAttemptAt: null,lastErrorClass: null,receiptBlockNumber: null,receiptBlockHash: null,receiptStatus: null,
      confirmedHead: null,confirmedAt: null,createdAt: timestamp() });
  }
  function stop(record,reason) {
    if (record.intent.status !== "PENDING" || record.intent.retryStoppedAt !== null) return;
    Object.assign(record.intent,{ retryStoppedAt: timestamp(),retryStopReason: reason,nextActionAt: null });
  }
  const repository = {
    async assertFence() { throw new TransactionError("LEASE_FENCE_REQUIRED"); },
    async getTransaction(id,expected) { return strict(id,expected); },
    async getTransactionIntent(id) { return (await strict(id))?.intent ?? null; },
    async getTransactionAttempt(id,attemptId) {
      const record = await strict(id);
      return attemptId === undefined ? record?.attempt ?? null : record?.attempts.find(a => a.attemptId === attemptId) ?? null;
    },
    async getAccount() { return nextNonce === null ? null : { nextNonce: nextNonce.toString() }; },
    async listTransactions({ status,limit }) {
      const selected = [...records.values()].filter(record => record.attempt.status === status || record.winningAttempt?.status === status)
        .sort((a,b) => BigInt(a.intent.nonce) < BigInt(b.intent.nonce) ? -1 : 1).slice(0,limit);
      return Promise.all(selected.map(record => strict(record.intent.deliveryJobId)));
    },
    async listTrackingIntents({ limit }) {
      return Promise.all([...records.values()].filter(r => r.intent.status === "PENDING" && r.attempts.some(a => BigInt(a.broadcastAttemptCount) > 0n || a.broadcastAt !== null))
        .slice(0,limit).map(r => strict(r.intent.deliveryJobId)));
    },
    async listDueIntents({ now,limit }) {
      return Promise.all([...records.values()].filter(r => r.intent.status === "PENDING" && r.intent.retryStoppedAt === null && Date.parse(r.intent.nextActionAt) <= now)
        .sort((a,b) => Date.parse(a.intent.nextActionAt) - Date.parse(b.intent.nextActionAt) || a.intent.deliveryJobId.localeCompare(b.intent.deliveryJobId))
        .slice(0,limit).map(r => strict(r.intent.deliveryJobId)));
    },
    async persistPrepared({ intent,pendingNonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas,sign,fence }) {
      if (fence) await this.assertFence(intent.deliveryJobId,fence);
      const existing = await strict(intent.deliveryJobId,intent);
      if (existing) return { ...existing,created: false };
      if (fence && [...records.values()].some(r => r.intent.status === "PENDING" && (r.intent.retryStoppedAt !== null || r.attempt.status === "SIGNED"))) throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
      const allocation = allocateNonce({ pendingNonce,nextNonce: nextNonce ?? pendingNonce });
      const canonical = { ...intent,nonce: allocation.nonce.toString() };
      calls.sign++;
      const signed = await sign(canonical,{ nonce: allocation.nonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas });
      await verifySignedTransaction(canonical,signed);
      if (beforeCommit) await beforeCommit();
      if (fence) await this.assertFence(intent.deliveryJobId,fence);
      const attempt = attemptRecord(canonical,signed,0,null);
      records.set(intent.deliveryJobId,{ intent: { ...canonical,intentId: intent.deliveryJobId,status: "PENDING",winningAttemptId: null,
        nextActionAt: nextAction(),retryStoppedAt: null,retryStopReason: null,createdAt: timestamp() },attempt,attempts: [attempt],winningAttempt: null });
      nextNonce = allocation.nextNonce;
      return { ...await strict(intent.deliveryJobId),created: true };
    },
    async persistReplacement({ id,parentAttemptId,fees,sign,fence }) {
      if (fence) await this.assertFence(id,fence);
      const record = records.get(id);
      if (record.intent.status !== "PENDING" || record.intent.retryStoppedAt !== null || record.attempt.attemptId !== parentAttemptId) return { ...await strict(id),created: false };
      if (Date.parse(record.intent.nextActionAt) > time || !replacementDue(record.attempt,time,config)) return { ...await strict(id),created: false };
      if (record.attempts.length >= config.maxAttempts) { stop(record,"MAX_ATTEMPTS_REACHED"); return { ...await strict(id),created: false }; }
      if (fees.maxFeePerGas > config.maxFeePerGasCap || fees.maxPriorityFeePerGas > config.maxPriorityFeePerGasCap) throw new TransactionError("FEE_CAP_EXCEEDED");
      const parent = record.attempt;
      if (fees.maxFeePerGas <= BigInt(parent.maxFeePerGas) || fees.maxPriorityFeePerGas <= BigInt(parent.maxPriorityFeePerGas)) throw new TransactionError("REPLACEMENT_FEES_NOT_INCREASED");
      calls.sign++;
      const signed = await sign(record.intent,{ nonce: BigInt(record.intent.nonce),gasLimit: BigInt(parent.gasLimit),...fees });
      await verifySignedTransaction(record.intent,signed);
      if (signed.gasLimit !== BigInt(parent.gasLimit)) throw new TransactionError("REPLACEMENT_GAS_CHANGED");
      if (beforeCommit) await beforeCommit();
      if (fence) await this.assertFence(id,fence);
      const child = attemptRecord(record.intent,signed,parent.attemptNumber + 1,parent.attemptId);
      parent.status = "REPLACED"; record.attempts.push(child); record.attempt = child; record.intent.nextActionAt = nextAction();
      return { ...await strict(id),created: true };
    },
    async broadcastPrepared(id,broadcast,{ rebroadcast = false,expectedAttemptId,fence } = {}) {
      if (fence) await this.assertFence(id,fence);
      const record = records.get(id);
      const stored = await strict(id);
      if (stored.intent.status !== "PENDING" || (expectedAttemptId !== undefined && stored.attempt.attemptId !== expectedAttemptId)) return { ...stored,broadcast: false };
      if (stored.intent.retryStoppedAt !== null) throw new TransactionError(stored.intent.retryStopReason);
      if (stored.attempt.status !== "SIGNED" && !rebroadcast) return { ...stored,broadcast: false };
      if ([...records.values()].some(r => r.intent.status === "PENDING" && BigInt(r.intent.nonce) < BigInt(stored.intent.nonce) &&
          (r.intent.retryStoppedAt !== null || r.attempt.status === "SIGNED"))) throw new TransactionError("EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST");
      let errorClass = null; let errorMessage = null; let errorCode = null;
      try {
        if (normalizeBytes32(await broadcast(stored.attempt.rawSignedTransaction,stored.attempt.transactionHash)) !== stored.attempt.transactionHash) throw new TransactionError("RPC_TRANSACTION_HASH_MISMATCH");
      } catch (error) { errorClass = classifyBroadcastError(error); errorCode = error.code ?? errorClass; errorMessage = safeRelayerMessage(error,config); }
      record.attempt.broadcastAttemptCount = (BigInt(record.attempt.broadcastAttemptCount) + 1n).toString();
      record.attempt.lastBroadcastAttemptAt = timestamp(); record.attempt.lastErrorClass = errorClass;
      if (errorClass === null) { record.attempt.status = "BROADCAST"; record.attempt.broadcastAt ??= timestamp(); }
      if (errorClass === "DETERMINISTIC_REJECTION") stop(record,errorCode === "RPC_TRANSACTION_HASH_MISMATCH" ? errorCode : errorClass);
      else record.intent.nextActionAt = nextAction();
      return { ...await strict(id),broadcast: errorClass === null,errorClass,errorCode,errorMessage };
    },
    async markKnownAttempt(id,attemptId,{ fence } = {}) {
      if (fence) await this.assertFence(id,fence);
      const record = records.get(id); const attempt = record.attempts.find(a => a.attemptId === attemptId);
      if (record.intent.status !== "PENDING") return strict(id);
      if (attempt.status === "SIGNED") attempt.status = "BROADCAST";
      attempt.broadcastAt ??= timestamp(); attempt.lastErrorClass = "ALREADY_KNOWN";
      return strict(id);
    },
    async scheduleRetry(id,{ reason = null,parentAttemptId,fence } = {}) {
      if (fence) await this.assertFence(id,fence);
      const record = records.get(id);
      if (record.intent.status === "PENDING" && record.intent.retryStoppedAt === null && (parentAttemptId === undefined || parentAttemptId === record.attempt.attemptId)) {
        record.intent.nextActionAt = nextAction(); if (reason) record.attempt.lastErrorClass = reason;
      }
      return strict(id);
    },
    async stopRetry(id,reason,{ parentAttemptId,fence } = {}) {
      if (fence) await this.assertFence(id,fence);
      const record = records.get(id);
      if (parentAttemptId === undefined || record.attempt.attemptId === parentAttemptId) stop(record,reason);
      return strict(id);
    },
    async recordOutcome(id,observation) {
      if (observation.fence) await this.assertFence(id,observation.fence);
      const record = records.get(id); const winner = record.attempts.find(a => a.transactionHash === observation.transactionHash);
      if (!winner) throw new TransactionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
      const status = observation.status === 1 ? "CONFIRMED" : "REVERTED";
      if (record.intent.status !== "PENDING") {
        if (record.intent.winningAttemptId !== winner.attemptId || record.intent.status !== status || winner.receiptBlockHash !== observation.blockHash ||
            winner.receiptBlockNumber !== observation.blockNumber.toString()) throw new TransactionError("CONFLICTING_TRANSACTION_OUTCOME");
        return strict(id);
      }
      Object.assign(winner,{ status,broadcastAt: winner.broadcastAt ?? timestamp(),broadcastAttemptCount: BigInt(winner.broadcastAttemptCount) > 0n ? winner.broadcastAttemptCount : "1",
        lastBroadcastAttemptAt: winner.lastBroadcastAttemptAt ?? timestamp(),receiptBlockNumber: observation.blockNumber.toString(),receiptBlockHash: observation.blockHash,
        receiptStatus: observation.status,confirmedHead: observation.head.toString(),confirmedAt: timestamp() });
      for (const other of record.attempts) if (other !== winner) other.status = "REPLACED";
      Object.assign(record.intent,{ status,winningAttemptId: winner.attemptId,nextActionAt: null }); record.winningAttempt = winner;
      return strict(id);
    },
  };
  function transactionBody(intent,attempt,blockNumber = null,blockHash = null) {
    return { hash: attempt.transactionHash,from: intent.senderAddress,to: intent.destinationGateway,input: intent.calldata,
      nonce: toHex(BigInt(attempt.nonce)),value: "0x0",type: "0x2",chainId: toHex(config.destinationDomain),
      blockNumber: blockNumber === null ? null : toHex(blockNumber),blockHash,gas: toHex(BigInt(attempt.gasLimit)),
      maxFeePerGas: toHex(BigInt(attempt.maxFeePerGas)),maxPriorityFeePerGas: toHex(BigInt(attempt.maxPriorityFeePerGas)) };
  }
  const rpc = {
    async verifyChain() { return state.actualChain; },
    async estimateGas() { calls.gas++; return 123456n; },
    async fees() { calls.fees++; return state.fees; },
    async pendingNonce() { calls.pending++; return state.pendingNonce; },
    async latestNonce() { calls.latest++; return state.latestNonce; },
    async broadcast(raw) {
      calls.broadcast.push(raw);
      const persisted = [...records.values()].find(r => r.attempts.some(a => a.rawSignedTransaction === raw));
      assert.ok(persisted);
      const attempt = persisted.attempts.find(a => a.rawSignedTransaction === raw);
      assert.ok(["SIGNED","BROADCAST"].includes(attempt.status));
      await verifySignedTransaction(persisted.intent,attempt);
      state.transactions.set(attempt.transactionHash,transactionBody(persisted.intent,attempt));
      if (BigInt(attempt.nonce) >= state.pendingNonce) state.pendingNonce = BigInt(attempt.nonce) + 1n;
      return attempt.transactionHash;
    },
    async head() { calls.head++; return state.head; },
    async readView() { return { head: await rpc.head(),endpoints: [{ endpointLabel: "rpc-0",head: state.head }] }; },
    async receiptEvidence(hash) {
      const receipt = await rpc.receipt(hash);
      if (receipt === null) return null;
      return { receipt,block: await rpc.block(BigInt(receipt.blockNumber)),transaction: await rpc.transaction(hash),endpointLabel: "rpc-0" };
    },
    async receipt(hash) { return state.receipts.get(hash) ?? null; },
    async block(number) { return state.blocks.get(number.toString()) ?? null; },
    async transaction(hash) { return state.transactions.get(hash) ?? null; },
  };
  const options = { config,queue,repository,rpc,clock,account: account ?? privateKeyToAccount(config.privateKey),
    legacy: { async getSubmission(id) { return historical.get(id) ?? null; } } };
  function mine(id,{ status = 1,blockNumber = 100n,attemptId } = {}) {
    const { intent,attempt,attempts } = records.get(id);
    const winner = attemptId === undefined ? attempt : attempts.find(a => a.attemptId === attemptId);
    const blockHash = fixtureHash(blockNumber + 1000n);
    const receipt = { transactionHash: winner.transactionHash,blockNumber: toHex(blockNumber),blockHash,status: toHex(status) };
    state.receipts.set(winner.transactionHash,receipt);
    state.blocks.set(blockNumber.toString(),{ number: toHex(blockNumber),hash: blockHash });
    state.transactions.set(winner.transactionHash,transactionBody(intent,winner,blockNumber,blockHash));
    if (BigInt(intent.nonce) >= state.latestNonce) state.latestNonce = BigInt(intent.nonce) + 1n;
    return receipt;
  }
  return { config,queue,jobs,packets,original,records,historical,calls,state,repository,rpc,options,clock,
    advance: milliseconds => { time += milliseconds; },mine,
    manager: createTransactionManager(options),restart: () => createTransactionManager(options) };
}
