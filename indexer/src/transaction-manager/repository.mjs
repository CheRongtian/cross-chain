import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { tableName } from "../db.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { deliveryTransaction } from "../delivery/repository.mjs";
import { safeRelayerMessage } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { allocateNonce } from "./nonce-policy.mjs";
import { verifySignedTransaction } from "./transaction.mjs";
import { actionDate, operationTime, replacementDue } from "./retry-policy.mjs";
import { BROADCAST_ERROR_CLASSES, normalizeRpcError } from "./rpc-errors.mjs";
import { TransactionError } from "./config.mjs";
import { assertLeaseFence } from "../relayer/leases.mjs";

const iso = value => value == null ? null : value.toISOString();
const final = status => status === "CONFIRMED" || status === "REVERTED";

export function createTransactionRepository({ config, pool, resolveIntent, beforeSignedCommit = async () => {},hooks = {}, clock = { now: Date.now } }) {
  const accounts = tableName(config.databaseSchema,"transaction_accounts");
  const intents = tableName(config.databaseSchema,"transaction_intents");
  const attempts = tableName(config.databaseSchema,"transaction_attempts");
  const events = tableName(config.databaseSchema,"transaction_broadcast_events");
  const jobs = tableName(config.databaseSchema,"delivery_jobs");
  const accountKey = [config.destinationDomain.toString(),normalizeAddress(config.relayerAddress)];

  function intentRecord(row,expected) {
    const actual = { deliveryJobId: row.delivery_job_id,packageDigest: row.package_digest,chainId: row.chain_id,
      senderAddress: row.sender_address,destinationGateway: row.destination_gateway,value: row.value,calldata: row.calldata };
    // Existing raw-envelope transactions predate production Gateway execution. Re-derive their exact
    // original bytes from verified evidence; never rewrite an intent, signature, hash or receipt.
    if (Object.keys(actual).some(key => actual[key] !== expected[key] &&
        !(key === "calldata" && actual[key] === expected.historicalCalldata))) throw new TransactionError("CONFLICTING_TRANSACTION_INTENT");
    const nonce = protocolInteger(row.nonce,"intent nonce").toString();
    const status = row.status;
    if (!["PENDING","CONFIRMED","REVERTED"].includes(status) ||
        ((row.retry_stopped_at === null) !== (row.retry_stop_reason === null)) ||
        (final(status) ? row.winning_attempt_id === null || row.next_action_at !== null :
          row.winning_attempt_id !== null || ((row.retry_stopped_at === null) !== (row.next_action_at !== null)))) throw new TransactionError("CORRUPTED_TRANSACTION_INTENT");
    return Object.freeze({ ...actual,intentId: actual.deliveryJobId,nonce,status,winningAttemptId: row.winning_attempt_id,
      nextActionAt: iso(row.next_action_at),retryStoppedAt: iso(row.retry_stopped_at),retryStopReason: row.retry_stop_reason,createdAt: iso(row.created_at) });
  }

  async function accountRecord(client) {
    const row = (await client.query(`SELECT a.*,(SELECT MAX(nonce)::text FROM ${intents}
      WHERE chain_id = a.chain_id AND sender_address = a.sender_address) AS highest_reserved_nonce
      FROM ${accounts} a WHERE chain_id = $1 AND sender_address = $2`,accountKey)).rows[0];
    if (!row) return null;
    const next = protocolInteger(row.next_nonce,"next nonce");
    const highest = row.highest_reserved_nonce;
    if (highest !== null && next <= protocolInteger(highest,"reserved nonce")) throw new TransactionError("NONCE_STATE_REGRESSION");
    return Object.freeze({ chainId: row.chain_id,senderAddress: row.sender_address,nextNonce: next.toString(),
      highestReservedNonce: highest,createdAt: iso(row.created_at),updatedAt: iso(row.updated_at) });
  }

  async function read(client,id,expected) {
    const row = (await client.query(`SELECT * FROM ${intents} WHERE delivery_job_id = $1`,[id])).rows[0];
    if (!row) return null;
    const intent = intentRecord(row,expected);
    const rows = (await client.query(`SELECT * FROM ${attempts} WHERE delivery_job_id = $1 ORDER BY attempt_number LIMIT 1000`,[id])).rows;
    if (!rows.length) throw new TransactionError("CORRUPTED_TRANSACTION_ATTEMPT");
    const history = [];
    for (const [index,signed] of rows.entries()) {
      if (signed.chain_id !== intent.chainId || signed.sender_address !== intent.senderAddress || signed.nonce !== intent.nonce || signed.attempt_number !== index ||
          signed.replacement_of_attempt_id !== (index === 0 ? null : history[index - 1].attemptId)) throw new TransactionError("CORRUPTED_TRANSACTION_LINEAGE");
      const attempt = { attemptId: signed.attempt_id,intentId: id,deliveryJobId: id,attemptNumber: index,replacementOfAttemptId: signed.replacement_of_attempt_id,
        status: signed.status,nonce: signed.nonce,gasLimit: signed.gas_limit,maxFeePerGas: signed.max_fee_per_gas,maxPriorityFeePerGas: signed.max_priority_fee_per_gas,
        transactionType: signed.transaction_type,rawSignedTransaction: signed.raw_signed_transaction,transactionHash: signed.transaction_hash,
        broadcastAt: iso(signed.broadcast_at),broadcastAttemptCount: protocolInteger(signed.broadcast_attempt_count,"broadcast count").toString(),
        lastBroadcastAttemptAt: iso(signed.last_broadcast_attempt_at),lastErrorClass: signed.last_error_class,
        receiptBlockNumber: signed.receipt_block_number,receiptBlockHash: signed.receipt_block_hash,receiptStatus: signed.receipt_status,
        confirmedHead: signed.confirmed_head,confirmedAt: iso(signed.confirmed_at),createdAt: iso(signed.created_at) };
      await verifySignedTransaction(intent,attempt);
      const previous = history[index - 1];
      if (previous && (attempt.gasLimit !== previous.gasLimit || BigInt(attempt.maxFeePerGas) <= BigInt(previous.maxFeePerGas) ||
          BigInt(attempt.maxPriorityFeePerGas) <= BigInt(previous.maxPriorityFeePerGas))) throw new TransactionError("CORRUPTED_TRANSACTION_LINEAGE");
      const terminal = final(attempt.status);
      const metadata = [attempt.receiptBlockNumber,attempt.receiptBlockHash,attempt.receiptStatus,attempt.confirmedHead,attempt.confirmedAt];
      if (!["SIGNED","BROADCAST","REPLACED","CONFIRMED","REVERTED"].includes(attempt.status) ||
          (attempt.status === "SIGNED" && attempt.broadcastAt !== null) || (attempt.status === "BROADCAST" && attempt.broadcastAt === null) ||
          ((BigInt(attempt.broadcastAttemptCount) === 0n) !== (attempt.lastBroadcastAttemptAt === null)) ||
          (attempt.lastErrorClass !== null && !BROADCAST_ERROR_CLASSES.includes(attempt.lastErrorClass)) ||
          (terminal ? metadata.some(value => value === null) || attempt.broadcastAt === null : metadata.some(value => value !== null))) throw new TransactionError("CORRUPTED_TRANSACTION_OUTCOME");
      if (terminal && (attempt.receiptStatus !== (attempt.status === "CONFIRMED" ? 1 : 0) ||
          protocolInteger(attempt.confirmedHead) < protocolInteger(attempt.receiptBlockNumber))) throw new TransactionError("CORRUPTED_TRANSACTION_OUTCOME");
      if (terminal) normalizeBytes32(attempt.receiptBlockHash);
      history.push(Object.freeze(attempt));
    }
    const winners = history.filter(attempt => final(attempt.status));
    if (final(intent.status) ? winners.length !== 1 || winners[0].attemptId !== intent.winningAttemptId || winners[0].status !== intent.status : winners.length !== 0) {
      throw new TransactionError("CONFLICTING_TRANSACTION_WINNER");
    }
    const latest = history.at(-1);
    for (const attempt of history) {
      if (!final(attempt.status) && (final(intent.status) || attempt !== latest) && attempt.status !== "REPLACED") throw new TransactionError("CORRUPTED_TRANSACTION_LINEAGE");
    }
    if (!final(intent.status) && !["SIGNED","BROADCAST"].includes(latest.status)) throw new TransactionError("CORRUPTED_ACTIVE_ATTEMPT");
    if (!await accountRecord(client)) throw new TransactionError("NONCE_STATE_MISSING");
    return Object.freeze({ intent,attempt: latest,attempts: Object.freeze(history),winningAttempt: winners[0] ?? null });
  }

  async function snapshot(operation) {
    return deliveryTransaction(pool,async client => {
      // A coherent MVCC snapshot avoids mixed intent/attempt outcomes, without
      // a SHARE lock that would block the independent before-send RPC observer.
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
      return operation(client);
    });
  }
  async function lockAccount(client,pendingNonce) {
    if (pendingNonce !== undefined) await client.query(`INSERT INTO ${accounts} (chain_id,sender_address,next_nonce) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [...accountKey,protocolInteger(pendingNonce,"pending nonce").toString()]);
    if (!(await client.query(`SELECT chain_id FROM ${accounts} WHERE chain_id = $1 AND sender_address = $2 FOR UPDATE`,accountKey)).rowCount) throw new TransactionError("NONCE_STATE_MISSING");
    return accountRecord(client);
  }
  async function locked(client,id,expected) {
    await lockAccount(client);
    await client.query(`SELECT delivery_job_id FROM ${intents} WHERE delivery_job_id = $1 FOR UPDATE`,[id]);
    const stored = await read(client,id,expected);
    if (!stored) throw new TransactionError("TRANSACTION_NOT_PREPARED");
    return stored;
  }
  async function stop(client,stored,reason,now) {
    if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null) return;
    await client.query(`UPDATE ${intents} SET retry_stopped_at = $2,retry_stop_reason = $3,next_action_at = NULL WHERE delivery_job_id = $1`,
      [stored.intent.deliveryJobId,actionDate(now),reason]);
  }
  async function insertAttempt(client,intent,signed,number,parentId,now) {
    await client.query(`INSERT INTO ${attempts} (delivery_job_id,attempt_number,replacement_of_attempt_id,chain_id,sender_address,status,nonce,gas_limit,
      max_fee_per_gas,max_priority_fee_per_gas,transaction_type,raw_signed_transaction,transaction_hash,created_at)
      VALUES ($1,$2,$3,$4,$5,'SIGNED',$6,$7,$8,$9,2,$10,$11,$12)`,[intent.deliveryJobId,number,parentId,intent.chainId,intent.senderAddress,
      intent.nonce,signed.gasLimit.toString(),signed.maxFeePerGas.toString(),signed.maxPriorityFeePerGas.toString(),signed.rawSignedTransaction,signed.transactionHash,actionDate(now)]);
  }
  async function withRecoveryLock(id,operation,context) {
    if (context) {
      if (context.deliveryJobId !== id) throw new TransactionError("INVALID_RECOVERY_CONTEXT");
      context.assertHeld(); return operation(context);
    }
    const client = await pool.connect(); let acquired = false; let lost = false; let ended = false; let key;
    const onError = () => { lost = true; }; client.on("error",onError);
    try {
      const row = (await client.query(`SELECT ((tableoid::bigint << 32) | recovery_lock_id::bigint)::text AS key FROM ${intents} WHERE delivery_job_id = $1`,[id])).rows[0];
      if (!row) throw new TransactionError("TRANSACTION_NOT_PREPARED"); key = row.key;
      acquired = (await client.query("SELECT pg_try_advisory_lock($1::bigint) AS acquired",[key])).rows[0].acquired;
      if (!acquired) throw new TransactionError("TRANSACTION_RECOVERY_BUSY");
      return await operation(Object.freeze({ deliveryJobId: id,assertHeld() {
        if (lost || ended) throw new TransactionError("TRANSACTION_RECOVERY_SESSION_LOST");
      } }));
    } finally {
      ended = true;
      try { if (acquired && !lost) await client.query("SELECT pg_advisory_unlock($1::bigint)",[key]); }
      finally { client.removeListener("error",onError); client.release(lost ? new Error("recovery session connection lost") : undefined); }
    }
  }
  const eventRecord = row => Object.freeze({ eventId: row.event_id,attemptId: row.attempt_id,broadcastSequence: row.broadcast_sequence,
    parentEventId: row.parent_event_id,endpointLabel: row.endpoint_label,startedAt: iso(row.started_at),completedAt: iso(row.completed_at),
    resultClass: row.result_class,errorClass: row.error_class,returnedTransactionHash: row.returned_tx_hash });
  async function insertEvent(client,attemptId,parentId = null,label = null) {
    return eventRecord((await client.query(`INSERT INTO ${events} (attempt_id,broadcast_sequence,parent_event_id,endpoint_label)
      SELECT $1,COALESCE(MAX(broadcast_sequence),0) + 1,$2,$3 FROM ${events} WHERE attempt_id = $1 RETURNING *`,[attemptId,parentId,label])).rows[0]);
  }
  async function completeEvent(client,eventId,{ resultClass,errorClass = null,transactionHash = null }) {
    const result = await client.query(`UPDATE ${events} SET completed_at = clock_timestamp(),result_class = $2,error_class = $3,returned_tx_hash = $4
      WHERE event_id = $1 AND completed_at IS NULL RETURNING *`,[eventId,resultClass,errorClass,transactionHash]);
    if (!result.rowCount) {
      const old = (await client.query(`SELECT * FROM ${events} WHERE event_id = $1`,[eventId])).rows[0];
      if (!old || old.result_class !== resultClass || old.error_class !== errorClass || old.returned_tx_hash !== transactionHash) throw new TransactionError("CONFLICTING_BROADCAST_RESULT");
      return eventRecord(old);
    }
    return eventRecord(result.rows[0]);
  }
  async function verifyVersion(client,id,expectedVersion) {
    if (expectedVersion === undefined) return;
    const current = (await client.query(`SELECT recovery_version::text AS version FROM ${intents} WHERE delivery_job_id = $1`,[id])).rows[0];
    if (current?.version !== expectedVersion) throw new TransactionError("RECOVERY_STATE_CHANGED");
  }
  async function finalize(client,stored,observation,now) {
    const id = stored.intent.deliveryJobId;
    const number = protocolInteger(observation.blockNumber); const head = protocolInteger(observation.head);
    const hash = normalizeBytes32(observation.blockHash);
    if (![0,1].includes(observation.status) || head < number || head - number + 1n < config.destinationConfirmations) throw new TransactionError("INSUFFICIENT_DESTINATION_CONFIRMATIONS");
    const status = observation.status === 1 ? "CONFIRMED" : "REVERTED";
    const winner = stored.attempts.find(a => a.transactionHash === normalizeBytes32(observation.transactionHash));
    if (!winner) throw new TransactionError("RECEIPT_TRANSACTION_HASH_MISMATCH");
    if (final(stored.intent.status)) {
      if (stored.intent.winningAttemptId !== winner.attemptId || stored.intent.status !== status || winner.receiptBlockNumber !== number.toString() || winner.receiptBlockHash !== hash) throw new TransactionError("CONFLICTING_TRANSACTION_OUTCOME");
      return;
    }
    await client.query(`UPDATE ${attempts} SET status = $2,broadcast_at = COALESCE(broadcast_at,$3),broadcast_attempt_count = GREATEST(broadcast_attempt_count,1),
      last_broadcast_attempt_at = COALESCE(last_broadcast_attempt_at,$3),receipt_block_number = $4,receipt_block_hash = $5,receipt_status = $6,confirmed_head = $7,confirmed_at = $3 WHERE attempt_id = $1`,
      [winner.attemptId,status,actionDate(now),number.toString(),hash,observation.status,head.toString()]);
    await client.query(`UPDATE ${intents} SET status = $2,winning_attempt_id = $3,next_action_at = NULL WHERE delivery_job_id = $1`,[id,status,winner.attemptId]);
    await client.query(`UPDATE ${attempts} SET status = 'REPLACED' WHERE delivery_job_id = $1 AND attempt_id <> $2 AND status <> 'REPLACED'`,[id,winner.attemptId]);
    await hooks.beforeOutcomeCommit?.({ client,id,observation });
  }
  return {
    withRecoveryLock,
    async getBroadcastEvents(id) {
      return Object.freeze((await pool.query(`SELECT e.* FROM ${events} e JOIN ${attempts} a USING (attempt_id)
        WHERE a.delivery_job_id = $1 ORDER BY e.event_id`,[id])).rows.map(eventRecord));
    },
    async getRecoverySnapshot(id) {
      const expected = await resolveIntent(id);
      return snapshot(async client => {
        const stored = await read(client,id,expected);
        if (!stored) return null;
        const version = (await client.query(`SELECT recovery_version::text AS version FROM ${intents} WHERE delivery_job_id = $1`,[id])).rows[0].version;
        const journal = (await client.query(`SELECT e.* FROM ${events} e JOIN ${attempts} a USING (attempt_id)
          WHERE a.delivery_job_id = $1 ORDER BY e.event_id`,[id])).rows.map(eventRecord);
        return Object.freeze({ ...stored,version,broadcastEvents: Object.freeze(journal) });
      });
    },
    async listRecoveryIntents({ limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      return Object.freeze((await pool.query(`SELECT delivery_job_id FROM ${intents} WHERE chain_id = $1 AND sender_address = $2
        AND status = 'PENDING' ORDER BY nonce,delivery_job_id LIMIT $3`,[...accountKey,limit])).rows.map(row => row.delivery_job_id));
    },
    async applyRecoveryObservation(snapshotValue,{ knownAttempts = [],receipt,fence } = {}) {
      const id = snapshotValue.intent.deliveryJobId; const expected = await resolveIntent(id); const now = operationTime(clock);
      const result = await deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (fence) await assertLeaseFence(client,config,id,fence);
        if (final(stored.intent.status)) return stored;
        await verifyVersion(client,id,snapshotValue.version);
        if (receipt) await finalize(client,stored,receipt,now);
        else for (const attemptId of knownAttempts) {
          const attempt = stored.attempts.find(a => a.attemptId === attemptId);
          if (!attempt) throw new TransactionError("UNKNOWN_TRANSACTION_ATTEMPT");
          if (attempt.broadcastAt === null) await client.query(`UPDATE ${attempts} SET status = $2,broadcast_at = COALESCE(broadcast_at,$3)
            WHERE attempt_id = $1`,[attemptId,attempt.status === "SIGNED" ? "BROADCAST" : attempt.status,actionDate(now)]);
        }
        const settled = new Set([...knownAttempts,...(receipt ? [stored.attempts.find(a => a.transactionHash === receipt.transactionHash).attemptId] : [])]);
        for (const attemptId of settled) {
          const candidate = stored.attempts.find(a => a.attemptId === attemptId);
          const incomplete = (await client.query(`SELECT event_id FROM ${events} WHERE attempt_id = $1 AND completed_at IS NULL ORDER BY event_id`,[attemptId])).rows;
          for (const event of incomplete) await completeEvent(client,event.event_id,{ resultClass: "RECONCILED",transactionHash: candidate.transactionHash });
        }
        return read(client,id,expected);
      });
      if (final(result.intent.status)) await hooks.afterOutcomeCommit?.({ id,stored: result });
      return result;
    },
    async assertRecoverySnapshot(snapshotValue,{ fence } = {}) {
      const id = snapshotValue.intent.deliveryJobId;
      return deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,await resolveIntent(id));
        if (fence) await assertLeaseFence(client,config,id,fence);
        await verifyVersion(client,id,snapshotValue.version); return stored;
      });
    },
    async assertFence(id,fence) {
      return deliveryTransaction(pool,client => assertLeaseFence(client,config,id,fence));
    },
    async getAccount() { return snapshot(accountRecord); },
    async getTransactionIntent(id) { return (await this.getTransaction(id))?.intent ?? null; },
    async getTransactionAttempt(id,attemptId) {
      const stored = await this.getTransaction(id);
      return attemptId === undefined ? stored?.attempt ?? null : stored?.attempts.find(value => value.attemptId === attemptId) ?? null;
    },
    async getTransaction(id,expected) {
      const canonical = expected ?? await resolveIntent(id);
      return snapshot(client => read(client,id,canonical));
    },
    async listTransactions({ status,limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      if (!["SIGNED","BROADCAST","CONFIRMED","REVERTED"].includes(status)) throw new TransactionError("INVALID_TRANSACTION_STATUS");
      const rows = (await pool.query(`SELECT i.delivery_job_id FROM ${intents} i JOIN ${attempts} a USING (delivery_job_id)
        WHERE i.chain_id = $1 AND i.sender_address = $2 AND a.status = $3
          AND (a.attempt_number = (SELECT MAX(attempt_number) FROM ${attempts} WHERE delivery_job_id = i.delivery_job_id) OR a.attempt_id = i.winning_attempt_id)
        ORDER BY i.nonce,i.delivery_job_id LIMIT $4`,[...accountKey,status,limit])).rows;
      const records = [];
      for (const row of rows) {
        const stored = await this.getTransaction(row.delivery_job_id);
        if (stored?.attempt.status === status || stored?.winningAttempt?.status === status) records.push(stored);
      }
      return Object.freeze(records);
    },
    async listTrackingIntents({ limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      const rows = (await pool.query(`SELECT delivery_job_id FROM ${intents} i WHERE chain_id = $1 AND sender_address = $2 AND status = 'PENDING'
        AND EXISTS (SELECT 1 FROM ${attempts} a WHERE a.delivery_job_id = i.delivery_job_id AND (a.broadcast_attempt_count > 0 OR a.broadcast_at IS NOT NULL))
        ORDER BY nonce,delivery_job_id LIMIT $3`,[...accountKey,limit])).rows;
      const records = [];
      for (const row of rows) { const stored = await this.getTransaction(row.delivery_job_id); if (stored?.intent.status === "PENDING") records.push(stored); }
      return Object.freeze(records);
    },
    async listDueIntents({ now,limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      const rows = (await pool.query(`SELECT delivery_job_id FROM ${intents} WHERE chain_id = $1 AND sender_address = $2 AND status = 'PENDING'
        AND retry_stopped_at IS NULL AND next_action_at <= $3 ORDER BY next_action_at,delivery_job_id LIMIT $4`,[...accountKey,actionDate(now),limit])).rows;
      const records = [];
      for (const row of rows) {
        const stored = await this.getTransaction(row.delivery_job_id);
        if (stored?.intent.status === "PENDING" && stored.intent.retryStoppedAt === null && new Date(stored.intent.nextActionAt).getTime() <= now) records.push(stored);
      }
      return Object.freeze(records);
    },
    async persistPrepared({ intent,pendingNonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas,sign,fence }) {
      const now = operationTime(clock);
      return deliveryTransaction(pool,async client => {
        const account = await lockAccount(client,pendingNonce);
        // Shared with preparation-defer writes, including unfenced explicit
        // manager preparation. An absent intent cannot otherwise be row-locked.
        await client.query(`SELECT delivery_job_id FROM ${jobs} WHERE delivery_job_id = $1 FOR NO KEY UPDATE`,[intent.deliveryJobId]);
        if (fence) await assertLeaseFence(client,config,intent.deliveryJobId,fence);
        const existing = await read(client,intent.deliveryJobId,intent);
        if (existing) return Object.freeze({ ...existing,created: false,nonceAdvancedFromRpc: false });
        if (fence && (await client.query(`SELECT 1 FROM ${intents} i WHERE chain_id = $1 AND sender_address = $2 AND status = 'PENDING'
          AND (retry_stopped_at IS NOT NULL OR EXISTS (SELECT 1 FROM ${attempts} a WHERE a.delivery_job_id = i.delivery_job_id
            AND a.status = 'SIGNED' AND a.attempt_number = (SELECT MAX(attempt_number) FROM ${attempts} WHERE delivery_job_id = i.delivery_job_id))) LIMIT 1`,accountKey)).rowCount) {
          throw new TransactionError("SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
        }
        const allocation = allocateNonce({ pendingNonce,nextNonce: account.nextNonce,highestReservedNonce: account.highestReservedNonce });
        const canonical = { ...intent,nonce: allocation.nonce.toString() };
        const signed = await sign(canonical,{ nonce: allocation.nonce,gasLimit,maxFeePerGas,maxPriorityFeePerGas });
        await verifySignedTransaction(canonical,signed);
        await client.query(`UPDATE ${accounts} SET next_nonce = $3,updated_at = CURRENT_TIMESTAMP WHERE chain_id = $1 AND sender_address = $2`,[...accountKey,allocation.nextNonce.toString()]);
        await client.query(`INSERT INTO ${intents} (delivery_job_id,package_digest,chain_id,sender_address,destination_gateway,value,calldata,nonce,next_action_at,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[canonical.deliveryJobId,canonical.packageDigest,canonical.chainId,canonical.senderAddress,
          canonical.destinationGateway,canonical.value,canonical.calldata,canonical.nonce,actionDate(now,config.rebroadcastIntervalMs),actionDate(now)]);
        await hooks.afterIntentInsert?.({ client,intent: canonical });
        await insertAttempt(client,canonical,signed,0,null,now);
        await beforeSignedCommit({ client,intent: canonical,attempt: signed });
        if (fence) await assertLeaseFence(client,config,intent.deliveryJobId,fence);
        return Object.freeze({ ...await read(client,intent.deliveryJobId,intent),created: true,nonceAdvancedFromRpc: protocolInteger(pendingNonce) > protocolInteger(account.nextNonce) });
      });
    },
    async persistReplacement({ id,parentAttemptId,fees,sign,fence }) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      return deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (fence) await assertLeaseFence(client,config,id,fence);
        if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null || stored.attempt.attemptId !== parentAttemptId) return Object.freeze({ ...stored,created: false });
        if (new Date(stored.intent.nextActionAt).getTime() > now || !replacementDue(stored.attempt,now,config)) return Object.freeze({ ...stored,created: false });
        if (stored.attempts.length >= config.maxAttempts) {
          await stop(client,stored,"MAX_ATTEMPTS_REACHED",now);
          return Object.freeze({ ...await read(client,id,expected),created: false });
        }
        if (fees.maxFeePerGas > config.maxFeePerGasCap || fees.maxPriorityFeePerGas > config.maxPriorityFeePerGasCap) throw new TransactionError("FEE_CAP_EXCEEDED");
        if (fees.maxFeePerGas <= BigInt(stored.attempt.maxFeePerGas) || fees.maxPriorityFeePerGas <= BigInt(stored.attempt.maxPriorityFeePerGas)) throw new TransactionError("REPLACEMENT_FEES_NOT_INCREASED");
        const signed = await sign(stored.intent,{ nonce: BigInt(stored.intent.nonce),gasLimit: BigInt(stored.attempt.gasLimit),...fees });
        await verifySignedTransaction(stored.intent,signed);
        await insertAttempt(client,stored.intent,signed,stored.attempt.attemptNumber + 1,stored.attempt.attemptId,now);
        await client.query(`UPDATE ${attempts} SET status = 'REPLACED' WHERE attempt_id = $1`,[stored.attempt.attemptId]);
        await client.query(`UPDATE ${intents} SET next_action_at = $2 WHERE delivery_job_id = $1`,[id,actionDate(now,config.rebroadcastIntervalMs)]);
        await beforeSignedCommit({ client,intent: stored.intent,attempt: signed });
        if (fence) await assertLeaseFence(client,config,id,fence);
        return Object.freeze({ ...await read(client,id,expected),created: true });
      });
    },
    async broadcastPrepared(id,broadcast,{ rebroadcast = false,expectedAttemptId,expectedVersion,fence,recoveryContext } = {}) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      return withRecoveryLock(id,async context => {
        context.assertHeld();
        const start = await deliveryTransaction(pool,async client => {
          const stored = await locked(client,id,expected);
          if (fence) await assertLeaseFence(client,config,id,fence);
          await verifyVersion(client,id,expectedVersion);
          if (stored.intent.status !== "PENDING" || (expectedAttemptId !== undefined && stored.attempt.attemptId !== expectedAttemptId)) return { stored };
          if (stored.intent.retryStoppedAt !== null) throw new TransactionError(stored.intent.retryStopReason);
          if (stored.attempt.status !== "SIGNED" && !rebroadcast) return { stored };
          const earlier = (await client.query(`SELECT i.delivery_job_id FROM ${intents} i JOIN ${attempts} a USING (delivery_job_id)
            WHERE i.chain_id = $1 AND i.sender_address = $2 AND i.status = 'PENDING' AND i.nonce < $3
              AND (i.retry_stopped_at IS NOT NULL OR (a.status = 'SIGNED' AND a.attempt_number = (SELECT MAX(attempt_number) FROM ${attempts} WHERE delivery_job_id = i.delivery_job_id)))
            ORDER BY i.nonce LIMIT 1`,[...accountKey,stored.intent.nonce])).rows[0];
          if (earlier) throw new TransactionError("EARLIER_SIGNED_TRANSACTION_BLOCKS_BROADCAST");
          const event = await insertEvent(client,stored.attempt.attemptId);
          await client.query(`UPDATE ${attempts} SET broadcast_attempt_count = broadcast_attempt_count + 1,last_broadcast_attempt_at = $2 WHERE attempt_id = $1`,
            [stored.attempt.attemptId,actionDate(now)]);
          await client.query(`UPDATE ${intents} SET next_action_at = $2 WHERE delivery_job_id = $1`,[id,actionDate(now,config.rebroadcastIntervalMs)]);
          return { stored: await read(client,id,expected),event };
        });
        if (!start.event) return Object.freeze({ ...start.stored,broadcast: false });
        // This checkpoint runs after COMMIT. SIGKILL cannot erase the marker.
        await hooks.afterBroadcastStart?.({ id,event: start.event,stored: start.stored });
        const attempt = start.stored.attempt;
        const lifecycle = {
          async beforeEndpoint(endpointLabel) {
            context.assertHeld();
            return deliveryTransaction(pool,async client => {
              const current = await locked(client,id,expected);
              if (fence) await assertLeaseFence(client,config,id,fence);
              if (current.intent.status !== "PENDING" || current.intent.retryStoppedAt !== null || current.attempt.attemptId !== attempt.attemptId) throw new TransactionError("BROADCAST_STATE_CHANGED");
              return insertEvent(client,attempt.attemptId,start.event.eventId,endpointLabel);
            });
          },
          async afterEndpoint(event,result) {
            await hooks.afterEndpointResult?.({ id,event,result,stored: start.stored });
            context.assertHeld();
            return deliveryTransaction(pool,async client => {
              await locked(client,id,expected);
              if (fence) await assertLeaseFence(client,config,id,fence);
              return completeEvent(client,event.eventId,result);
            });
          },
        };
        let errorClass = null; let errorMessage = null; let errorCode = null;
        try {
          const hash = normalizeBytes32(await broadcast(attempt.rawSignedTransaction,attempt.transactionHash,lifecycle),"RPC transaction hash");
          if (hash !== attempt.transactionHash) throw new TransactionError("RPC_TRANSACTION_HASH_MISMATCH");
        } catch (error) {
          // Storage/fencing failures leave the committed event unresolved.
          if (error.coordinationFailure) throw error;
          const normalized = normalizeRpcError(error,{ operation: "broadcast" });
          errorClass = normalized.errorClass; errorMessage = safeRelayerMessage(error,config); errorCode = normalized.errorCode;
        }
        await hooks.beforeBroadcastResult?.({ id,event: start.event,stored: start.stored,errorClass });
        context.assertHeld();
        return deliveryTransaction(pool,async client => {
          const current = await locked(client,id,expected);
          if (fence) await assertLeaseFence(client,config,id,fence);
          await completeEvent(client,start.event.eventId,errorClass ? { resultClass: "ERROR",errorClass } :
            { resultClass: "ACCEPTED",transactionHash: attempt.transactionHash });
          if (current.intent.status === "PENDING" && current.attempt.attemptId === attempt.attemptId) {
            await client.query(`UPDATE ${attempts} SET status = $2,broadcast_at = $3,last_error_class = $4 WHERE attempt_id = $1`,
              [attempt.attemptId,errorClass ? current.attempt.status : "BROADCAST",current.attempt.broadcastAt ?? (errorClass ? null : actionDate(now)),errorClass]);
            if (errorClass === "DETERMINISTIC_REJECTION") await stop(client,current,errorCode === "RPC_TRANSACTION_HASH_MISMATCH" ? errorCode : errorClass,now);
            if (errorClass === "RPC_RESPONSE_ERROR") await stop(client,current,errorCode,now);
          }
          return Object.freeze({ ...await read(client,id,expected),broadcast: errorClass === null,errorClass,errorMessage,errorCode });
        });
      },recoveryContext);
    },
    async markKnownAttempt(id,attemptId,{ fence } = {}) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      return deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (fence) await assertLeaseFence(client,config,id,fence);
        if (stored.intent.status !== "PENDING") return stored;
        const attempt = stored.attempts.find(value => value.attemptId === attemptId);
        if (!attempt) throw new TransactionError("UNKNOWN_TRANSACTION_ATTEMPT");
        await client.query(`UPDATE ${attempts} SET status = $2,broadcast_at = COALESCE(broadcast_at,$3),last_error_class = 'ALREADY_KNOWN' WHERE attempt_id = $1`,
          [attemptId,attempt.status === "SIGNED" ? "BROADCAST" : attempt.status,actionDate(now)]);
        return read(client,id,expected);
      });
    },
    async scheduleRetry(id,{ reason = null,parentAttemptId,fence } = {}) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      return deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (fence) await assertLeaseFence(client,config,id,fence);
        if (stored.intent.status !== "PENDING" || stored.intent.retryStoppedAt !== null || (parentAttemptId !== undefined && stored.attempt.attemptId !== parentAttemptId)) return stored;
        if (reason) {
          if (!BROADCAST_ERROR_CLASSES.includes(reason)) throw new TransactionError("INVALID_RETRY_ERROR_CLASS");
          await client.query(`UPDATE ${attempts} SET last_error_class = $2 WHERE attempt_id = $1`,[stored.attempt.attemptId,reason]);
        }
        await client.query(`UPDATE ${intents} SET next_action_at = $2 WHERE delivery_job_id = $1`,[id,actionDate(now,config.rebroadcastIntervalMs)]);
        return read(client,id,expected);
      });
    },
    async stopRetry(id,reason,{ parentAttemptId,expectedVersion,fence } = {}) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      return deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (fence) await assertLeaseFence(client,config,id,fence);
        await verifyVersion(client,id,expectedVersion);
        if (parentAttemptId === undefined || stored.attempt.attemptId === parentAttemptId) await stop(client,stored,reason,now);
        return read(client,id,expected);
      });
    },
    async recordOutcome(id,observation) {
      const expected = await resolveIntent(id); const now = operationTime(clock);
      const result = await deliveryTransaction(pool,async client => {
        const stored = await locked(client,id,expected);
        if (observation.fence) await assertLeaseFence(client,config,id,observation.fence);
        await verifyVersion(client,id,observation.expectedVersion);
        await finalize(client,stored,observation,now);
        return read(client,id,expected);
      });
      await hooks.afterOutcomeCommit?.({ id,stored: result }); return result;
    },
  };
}
