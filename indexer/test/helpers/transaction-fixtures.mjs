import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { toHex } from "viem";
import { deliveryJson, buildDeliveryPackages } from "../../src/delivery/package.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { loadTransactionConfig, TransactionError } from "../../src/transaction-manager/config.mjs";
import { allocateNonce } from "../../src/transaction-manager/nonce-policy.mjs";
import { verifySignedTransaction } from "../../src/transaction-manager/transaction.mjs";
import { normalizeBytes32 } from "../../src/canonical-message.mjs";
import { deliveryFixture, fixtureHash } from "./delivery-fixtures.mjs";
import { relayerEnvironment } from "./relayer-fixtures.mjs";

export const cloneTransactionValue = (value) => JSON.parse(deliveryJson(value));
export function transactionConfig(overrides = {}) { return loadTransactionConfig(relayerEnvironment(overrides)); }

export async function transactionHarness({ config = transactionConfig(), mutate, beforeCommit, account } = {}) {
  const packets = cloneTransactionValue(await buildDeliveryPackages(await deliveryFixture(), { validatorSets: config.validatorSets }));
  const original = cloneTransactionValue(packets);
  if (mutate) mutate(packets[0]);
  const jobs = packets.map((pack) => ({ deliveryJobId: pack.deliveryJobId, status: "READY",
    destinationDomain: pack.message.destinationDomain, destinationGateway: pack.message.destinationGateway }));
  const queue = { async getDeliveryJob(id) { return jobs.find((job) => job.deliveryJobId === id); },
    async getDeliveryPackage(id) { return packets.find((pack) => pack.deliveryJobId === id); } };
  const records = new Map();
  const historical = new Map();
  const calls = { gas: 0, fees: 0, pending: 0, sign: 0, broadcast: [], head: 0 };
  let nextNonce = null;
  const state = { pendingNonce: 9n, head: 100n, actualChain: config.destinationDomain, receipts: new Map(), transactions: new Map(), blocks: new Map() };
  async function strict(id, expected) {
    const record = records.get(id);
    if (!record) return null;
    if (expected && Object.keys(expected).some((key) => record.intent[key] !== expected[key])) throw new TransactionError("CONFLICTING_TRANSACTION_INTENT");
    await verifySignedTransaction(record.intent, record.attempt);
    return cloneTransactionValue(record);
  }
  const repository = {
    async getTransaction(id, expected) { return strict(id, expected); },
    async getTransactionIntent(id) { return (await strict(id))?.intent ?? null; },
    async getTransactionAttempt(id) { return (await strict(id))?.attempt ?? null; },
    async getAccount() { return nextNonce === null ? null : { nextNonce: nextNonce.toString() }; },
    async listTransactions({ status, limit }) {
      const selected = [...records.values()].filter((record) => record.attempt.status === status)
        .sort((a, b) => BigInt(a.attempt.nonce) < BigInt(b.attempt.nonce) ? -1 : 1).slice(0, limit);
      return Promise.all(selected.map((record) => strict(record.intent.deliveryJobId)));
    },
    async persistPrepared({ intent, pendingNonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, sign }) {
      const existing = await strict(intent.deliveryJobId, intent);
      if (existing) return { ...existing, created: false };
      const allocation = allocateNonce({ pendingNonce, nextNonce: nextNonce ?? pendingNonce });
      calls.sign++;
      const signed = await sign(intent, { nonce: allocation.nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
      if (beforeCommit) await beforeCommit();
      const record = cloneTransactionValue({ intent: { ...intent, intentId: intent.deliveryJobId, createdAt: "2026-01-01T00:00:00.000Z" },
        attempt: { ...signed, attemptId: String(records.size + 1), intentId: intent.deliveryJobId, deliveryJobId: intent.deliveryJobId,
          attemptNumber: 0, status: "SIGNED", broadcastAt: null, receiptBlockNumber: null, receiptBlockHash: null, receiptStatus: null,
          confirmedHead: null, confirmedAt: null, createdAt: "2026-01-01T00:00:00.000Z" } });
      records.set(intent.deliveryJobId, record); nextNonce = allocation.nextNonce;
      return { ...await strict(intent.deliveryJobId), created: true };
    },
    async broadcastPrepared(id, broadcast) {
      const stored = await strict(id);
      if (stored.attempt.status !== "SIGNED") return { ...stored, broadcast: false };
      if ([...records.values()].some((record) => record.attempt.status === "SIGNED" && BigInt(record.attempt.nonce) < BigInt(stored.attempt.nonce))) {
        throw new TransactionError("EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST");
      }
      if (normalizeBytes32(await broadcast(stored.attempt.rawSignedTransaction)) !== stored.attempt.transactionHash) throw new TransactionError("RPC_TRANSACTION_HASH_MISMATCH");
      const record = records.get(id);
      record.attempt.status = "BROADCAST"; record.attempt.broadcastAt = "2026-01-01T00:00:01.000Z";
      return { ...await strict(id), broadcast: true };
    },
    async recordOutcome(id, observation) {
      const record = records.get(id);
      Object.assign(record.attempt, { status: observation.status === 1 ? "CONFIRMED" : "REVERTED", receiptBlockNumber: observation.blockNumber.toString(),
        receiptBlockHash: observation.blockHash, receiptStatus: observation.status, confirmedHead: observation.head.toString(), confirmedAt: "2026-01-01T00:00:02.000Z" });
      return strict(id);
    },
  };
  const rpc = {
    async verifyChain() { return state.actualChain; },
    async estimateGas() { calls.gas++; return 123456n; },
    async fees() { calls.fees++; return { maxFeePerGas: 3000000000n, maxPriorityFeePerGas: 1000000000n }; },
    async pendingNonce() { calls.pending++; return state.pendingNonce; },
    async broadcast(raw) {
      calls.broadcast.push(raw);
      const persisted = [...records.values()].find((record) => record.attempt.rawSignedTransaction === raw);
      assert.ok(persisted); assert.equal(persisted.attempt.status, "SIGNED");
      await verifySignedTransaction(persisted.intent, persisted.attempt);
      return persisted.attempt.transactionHash;
    },
    async head() { calls.head++; return state.head; },
    async receipt(hash) { return state.receipts.get(hash) ?? null; },
    async block(number) { return state.blocks.get(number.toString()) ?? null; },
    async transaction(hash) { return state.transactions.get(hash) ?? null; },
  };
  const options = { config, queue, repository, rpc, account: account ?? privateKeyToAccount(config.privateKey), legacy: { async getSubmission(id) { return historical.get(id) ?? null; } } };
  function mine(id, { status = 1, blockNumber = 100n } = {}) {
    const { intent, attempt } = records.get(id);
    const blockHash = fixtureHash(blockNumber + 1000n);
    const receipt = { transactionHash: attempt.transactionHash, blockNumber: toHex(blockNumber), blockHash, status: toHex(status) };
    state.receipts.set(attempt.transactionHash, receipt);
    state.blocks.set(blockNumber.toString(), { number: toHex(blockNumber), hash: blockHash });
    state.transactions.set(attempt.transactionHash, { hash: attempt.transactionHash, from: intent.senderAddress, to: intent.destinationGateway,
      input: intent.calldata, nonce: toHex(BigInt(attempt.nonce)), value: "0x0", type: "0x2", chainId: toHex(config.destinationDomain),
      blockNumber: toHex(blockNumber), blockHash, gas: toHex(BigInt(attempt.gasLimit)),
      maxFeePerGas: toHex(BigInt(attempt.maxFeePerGas)), maxPriorityFeePerGas: toHex(BigInt(attempt.maxPriorityFeePerGas)) });
    return receipt;
  }
  return { config, queue, jobs, packets, original, records, historical, calls, state, repository, rpc, options, mine,
    manager: createTransactionManager(options), restart: () => createTransactionManager(options) };
}
