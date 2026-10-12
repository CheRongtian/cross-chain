import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { tableName } from "../db.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { deliveryTransaction } from "../delivery/repository.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { allocateNonce } from "./nonce-policy.mjs";
import { verifySignedTransaction } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";

const iso = (value) => value == null ? null : value.toISOString();

export function createTransactionRepository({ config, pool, resolveIntent, beforeSignedCommit = async () => {} }) {
  const accounts = tableName(config.databaseSchema, "transaction_accounts");
  const intents = tableName(config.databaseSchema, "transaction_intents");
  const attempts = tableName(config.databaseSchema, "transaction_attempts");
  const accountKey = [config.destinationDomain.toString(), normalizeAddress(config.relayerAddress)];

  function intentRecord(row, expected) {
    const actual = { deliveryJobId: row.delivery_job_id, packageDigest: row.package_digest, chainId: row.chain_id,
      senderAddress: row.sender_address, destinationGateway: row.destination_gateway, value: row.value, calldata: row.calldata };
    if (Object.keys(actual).some((key) => actual[key] !== expected[key])) throw new TransactionError("CONFLICTING_TRANSACTION_INTENT");
    return Object.freeze({ ...actual, intentId: actual.deliveryJobId, createdAt: iso(row.created_at) });
  }

  async function accountRecord(client) {
    // One statement snapshot prevents a concurrent committed preparation from
    // making an older account read appear behind a newer reserved nonce.
    const row = (await client.query(`SELECT a.*,(SELECT MAX(nonce)::text FROM ${attempts}
      WHERE chain_id = a.chain_id AND sender_address = a.sender_address) AS highest_reserved_nonce
      FROM ${accounts} a WHERE chain_id = $1 AND sender_address = $2`, accountKey)).rows[0];
    if (!row) return null;
    const highest = row.highest_reserved_nonce;
    const next = protocolInteger(row.next_nonce, "next nonce");
    if (highest !== null && next <= protocolInteger(highest, "reserved nonce")) throw new TransactionError("NONCE_STATE_REGRESSION");
    return Object.freeze({ chainId: row.chain_id, senderAddress: row.sender_address, nextNonce: next.toString(),
      highestReservedNonce: highest, createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) });
  }

  async function read(client, deliveryJobId, expected) {
    const row = (await client.query(`SELECT * FROM ${intents} WHERE delivery_job_id = $1`, [deliveryJobId])).rows[0];
    if (!row) return null;
    const intent = intentRecord(row, expected);
    const signed = (await client.query(`SELECT * FROM ${attempts} WHERE delivery_job_id = $1`, [deliveryJobId])).rows[0];
    if (!signed || signed.chain_id !== intent.chainId || signed.sender_address !== intent.senderAddress || signed.attempt_number !== 0) {
      throw new TransactionError("CORRUPTED_TRANSACTION_ATTEMPT");
    }
    const attempt = { attemptId: signed.attempt_id, intentId: deliveryJobId, deliveryJobId, attemptNumber: 0,
      status: signed.status, nonce: signed.nonce, gasLimit: signed.gas_limit, maxFeePerGas: signed.max_fee_per_gas,
      maxPriorityFeePerGas: signed.max_priority_fee_per_gas, transactionType: signed.transaction_type,
      rawSignedTransaction: signed.raw_signed_transaction, transactionHash: signed.transaction_hash,
      broadcastAt: iso(signed.broadcast_at), receiptBlockNumber: signed.receipt_block_number,
      receiptBlockHash: signed.receipt_block_hash, receiptStatus: signed.receipt_status,
      confirmedHead: signed.confirmed_head, confirmedAt: iso(signed.confirmed_at), createdAt: iso(signed.created_at) };
    await verifySignedTransaction(intent, attempt);
    if (!["SIGNED", "BROADCAST", "CONFIRMED", "REVERTED"].includes(attempt.status)) throw new TransactionError("INVALID_TRANSACTION_STATUS");
    const terminal = ["CONFIRMED", "REVERTED"].includes(attempt.status);
    const metadata = [attempt.receiptBlockNumber, attempt.receiptBlockHash, attempt.receiptStatus, attempt.confirmedHead, attempt.confirmedAt];
    if ((attempt.status === "SIGNED") !== (attempt.broadcastAt === null) ||
        (terminal ? metadata.some((value) => value === null) : metadata.some((value) => value !== null))) throw new TransactionError("CORRUPTED_TRANSACTION_OUTCOME");
    if (terminal) {
      normalizeBytes32(attempt.receiptBlockHash);
      if (attempt.receiptStatus !== (attempt.status === "CONFIRMED" ? 1 : 0) ||
          protocolInteger(attempt.confirmedHead) < protocolInteger(attempt.receiptBlockNumber)) throw new TransactionError("CORRUPTED_TRANSACTION_OUTCOME");
    }
    await accountRecord(client);
    return Object.freeze({ intent, attempt: Object.freeze(attempt) });
  }

  async function lockAccount(client, pendingNonce) {
    if (pendingNonce !== undefined) {
      await client.query(`INSERT INTO ${accounts} (chain_id,sender_address,next_nonce) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [...accountKey, protocolInteger(pendingNonce, "pending nonce").toString()]);
    }
    const row = (await client.query(`SELECT * FROM ${accounts} WHERE chain_id = $1 AND sender_address = $2 FOR UPDATE`, accountKey)).rows[0];
    if (!row) throw new TransactionError("NONCE_STATE_MISSING");
    return accountRecord(client);
  }

  return {
    async getAccount() { return deliveryTransaction(pool, accountRecord); },
    async getTransactionIntent(deliveryJobId) { return (await this.getTransaction(deliveryJobId))?.intent ?? null; },
    async getTransactionAttempt(deliveryJobId) { return (await this.getTransaction(deliveryJobId))?.attempt ?? null; },
    async getTransaction(deliveryJobId, expected) {
      const canonical = expected ?? await resolveIntent(deliveryJobId);
      return deliveryTransaction(pool, (client) => read(client, deliveryJobId, canonical));
    },
    async listTransactions({ status, limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      if (!["SIGNED", "BROADCAST", "CONFIRMED", "REVERTED"].includes(status)) throw new TransactionError("INVALID_TRANSACTION_STATUS");
      const rows = (await pool.query(`SELECT delivery_job_id FROM ${attempts}
        WHERE chain_id = $1 AND sender_address = $2 AND status = $3 ORDER BY nonce,attempt_id LIMIT $4`, [...accountKey, status, limit])).rows;
      const records = [];
      for (const row of rows) {
        const stored = await this.getTransaction(row.delivery_job_id);
        if (stored?.attempt.status === status) records.push(stored);
      }
      return Object.freeze(records);
    },
    async persistPrepared({ intent, pendingNonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas, sign }) {
      return deliveryTransaction(pool, async (client) => {
        const account = await lockAccount(client, pendingNonce);
        const existing = await read(client, intent.deliveryJobId, intent);
        if (existing) return Object.freeze({ ...existing, created: false, nonceAdvancedFromRpc: false });
        const allocation = allocateNonce({ pendingNonce, nextNonce: account.nextNonce, highestReservedNonce: account.highestReservedNonce });
        const signed = await sign(intent, { nonce: allocation.nonce, gasLimit, maxFeePerGas, maxPriorityFeePerGas });
        await verifySignedTransaction(intent, signed);
        await client.query(`UPDATE ${accounts} SET next_nonce = $3,updated_at = CURRENT_TIMESTAMP WHERE chain_id = $1 AND sender_address = $2`,
          [...accountKey, allocation.nextNonce.toString()]);
        await client.query(`INSERT INTO ${intents} (delivery_job_id,package_digest,chain_id,sender_address,destination_gateway,value,calldata)
          VALUES ($1,$2,$3,$4,$5,$6,$7)`, [intent.deliveryJobId,intent.packageDigest,intent.chainId,intent.senderAddress,intent.destinationGateway,intent.value,intent.calldata]);
        await client.query(`INSERT INTO ${attempts} (delivery_job_id,chain_id,sender_address,status,nonce,gas_limit,max_fee_per_gas,max_priority_fee_per_gas,transaction_type,raw_signed_transaction,transaction_hash)
          VALUES ($1,$2,$3,'SIGNED',$4,$5,$6,$7,2,$8,$9)`, [intent.deliveryJobId,intent.chainId,intent.senderAddress,
          allocation.nonce.toString(),gasLimit.toString(),maxFeePerGas.toString(),maxPriorityFeePerGas.toString(),signed.rawSignedTransaction,signed.transactionHash]);
        await beforeSignedCommit({ client, intent, attempt: signed });
        const stored = await read(client, intent.deliveryJobId, intent);
        return Object.freeze({ ...stored, created: true, nonceAdvancedFromRpc: protocolInteger(pendingNonce) > protocolInteger(account.nextNonce) });
      });
    },
    async broadcastPrepared(deliveryJobId, broadcast) {
      // Only the bounded send RPC is made under this short account lock. Gas,
      // fee and pending-nonce queries always occur before preparation locks.
      const expected = await resolveIntent(deliveryJobId);
      return deliveryTransaction(pool, async (client) => {
        await lockAccount(client);
        const stored = await read(client, deliveryJobId, expected);
        if (!stored) throw new TransactionError("TRANSACTION_NOT_PREPARED");
        if (stored.attempt.status !== "SIGNED") return Object.freeze({ ...stored, broadcast: false });
        const earlier = (await client.query(`SELECT delivery_job_id FROM ${attempts} WHERE chain_id = $1 AND sender_address = $2
          AND status = 'SIGNED' AND nonce < $3 ORDER BY nonce LIMIT 1`, [...accountKey, stored.attempt.nonce])).rows[0];
        if (earlier) throw new TransactionError("EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST");
        const returned = normalizeBytes32(await broadcast(stored.attempt.rawSignedTransaction), "RPC transaction hash");
        if (returned !== stored.attempt.transactionHash) throw new TransactionError("RPC_TRANSACTION_HASH_MISMATCH");
        await client.query(`UPDATE ${attempts} SET status = 'BROADCAST',broadcast_at = CURRENT_TIMESTAMP WHERE delivery_job_id = $1 AND status = 'SIGNED'`, [deliveryJobId]);
        return Object.freeze({ ...await read(client, deliveryJobId, expected), broadcast: true });
      });
    },
    async recordOutcome(deliveryJobId, observation) {
      const expected = await resolveIntent(deliveryJobId);
      const blockNumber = protocolInteger(observation.blockNumber, "receipt block");
      const head = protocolInteger(observation.head, "confirmed head");
      const blockHash = normalizeBytes32(observation.blockHash, "receipt block hash");
      if (![0,1].includes(observation.status) || head < blockNumber || head - blockNumber + 1n < config.destinationConfirmations) {
        throw new TransactionError("INSUFFICIENT_DESTINATION_CONFIRMATIONS");
      }
      const status = observation.status === 1 ? "CONFIRMED" : "REVERTED";
      return deliveryTransaction(pool, async (client) => {
        await lockAccount(client);
        await client.query(`SELECT attempt_id FROM ${attempts} WHERE delivery_job_id = $1 FOR UPDATE`, [deliveryJobId]);
        const stored = await read(client, deliveryJobId, expected);
        if (!stored || stored.attempt.transactionHash !== normalizeBytes32(observation.transactionHash)) throw new TransactionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
        if (["CONFIRMED", "REVERTED"].includes(stored.attempt.status)) {
          if (stored.attempt.status !== status || stored.attempt.receiptBlockNumber !== blockNumber.toString() || stored.attempt.receiptBlockHash !== blockHash) throw new TransactionError("CONFLICTING_TRANSACTION_OUTCOME");
          return stored;
        }
        if (stored.attempt.status !== "BROADCAST") throw new TransactionError("RECEIPT_REQUIRES_BROADCAST");
        await client.query(`UPDATE ${attempts} SET status = $2,receipt_block_number = $3,receipt_block_hash = $4,receipt_status = $5,
          confirmed_head = $6,confirmed_at = CURRENT_TIMESTAMP WHERE delivery_job_id = $1`, [deliveryJobId,status,blockNumber.toString(),blockHash,observation.status,head.toString()]);
        return read(client, deliveryJobId, expected);
      });
    },
  };
}
