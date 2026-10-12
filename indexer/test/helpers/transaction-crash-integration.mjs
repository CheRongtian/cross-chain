import assert from "node:assert/strict";
import { toHex } from "viem";
import { applyMigrations,createDatabasePool,readMessages,resetIndexerTables,tableName } from "../../src/db.mjs";
import { createIndexer } from "../../src/indexer.mjs";
import { createFinalityWatcher } from "../../src/finality-watcher.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { createRelayerProcesses } from "./multi-relayer-integration.mjs";
import { destinationAccessPath } from "./rpc-failover-integration.mjs";
import { rpcObserver } from "../../../validator/test/helpers/process-cluster.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";

const quiet = { log() {},warn() {},error() {} };
const exactFields = ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"];

// Wait on the actual PostgreSQL lock-release condition after SIGKILL, not a
// guessed delay between process exit and backend disconnection.
async function waitForBackendRelease(pool,config,id,workerId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN"); await client.query("SET LOCAL statement_timeout = '10000ms'");
    for (const [table,column,predicate,value] of [
      ["relayer_worker_ids","lock_id","worker_id",workerId],
      ["transaction_intents","recovery_lock_id","delivery_job_id",id],
    ]) {
      const row = (await client.query(`SELECT ((tableoid::bigint << 32) | ${column}::bigint)::text AS key
        FROM ${tableName(config.databaseSchema,table)} WHERE ${predicate} = $1`,[value])).rows[0];
      if (row) await client.query("SELECT pg_advisory_xact_lock($1::bigint)",[row.key]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function verifyTransactionCrashes({ environment,sourceConfig,sourcePool,snapshot,destination,upstream }) {
  const original = await sourceState(sourcePool,sourceConfig.databaseSchema);
  const env = { ...environment,INDEXER_DB_SCHEMA: "cross_chain_relayer_crash_verification" };
  const config = { ...sourceConfig,...loadTransactionConfig(env),
    sourceGatewayStartBlock: snapshot.batch.messages.reduce((n,m) => m.sourceBlockNumber < n ? m.sourceBlockNumber : n,snapshot.batch.messages[0].sourceBlockNumber) };
  const pool = createDatabasePool(config); const queue = createDeliveryRepository({ config,pool });
  let manager; let primary; let secondary; let observer;
  const processes = createRelayerProcesses({ environment: env,pidFile: process.env.RELAYER_VERIFICATION_PID_FILE });
  let snapshotId; let automine; let originalCode; let codeAddress; let failure;
  try {
    snapshotId = await destination.request({ method: "evm_snapshot",params: [] });
    automine = await destination.request({ method: "anvil_getAutomine",params: [] });
    await applyMigrations(pool,config.databaseSchema); await resetIndexerTables(pool,config.databaseSchema);
    // Reuse official one-shot source builders and the already verified QC.
    // No validator process or new consensus evidence is generated here.
    await createIndexer({ config,pool,logger: quiet }).catchUpOnce();
    await createFinalityWatcher({ config,pool,logger: quiet }).runFinalityPass();
    const sourceRows = await readMessages(pool,config.databaseSchema);
    const members = sourceRows.filter(row => snapshot.batch.messageIds.includes(row.message_id));
    assert.equal(members.length,snapshot.members.length); assert.ok(members.every(row => row.status === "FINALIZED"));
    const lifecycle = createBatchLifecycle({ config,pool,validatorSets: config.validatorSets });
    const building = await lifecycle.getOrCreateBuilding({ initialEpoch: snapshot.record.epoch });
    await lifecycle.assignMessages({ batchRecordId: building.record.batchRecordId,sourceMessageIds: members.map(row => row.id) });
    await lifecycle.sealBatch({ batchRecordId: building.record.batchRecordId });
    await lifecycle.markConsensusPending({ batchRecordId: building.record.batchRecordId });
    await lifecycle.commitWithCertificate({ certificate: snapshot.quorumCertificate });
    await createDeliveryProjector({ config,pool }).materializeBatch({ batchRecordId: building.record.batchRecordId });
    const jobs = await queue.listReadyDeliveryJobs(); assert.equal(jobs.length,3,"the crash fixture uses real A/B/D evidence");
    observer = await rpcObserver(upstream,{ async beforeForward(request) {
      if (request.method !== "eth_sendRawTransaction") return;
      const row = (await pool.query(`SELECT delivery_job_id,attempt_id FROM ${tableName(config.databaseSchema,"transaction_attempts")}
        WHERE raw_signed_transaction = $1`,[request.params[0]])).rows[0];
      assert.ok(row,"real crash send must use committed exact signed bytes");
      const stored = await manager.repository.getTransaction(row.delivery_job_id);
      assert.ok(stored.attempts.some(attempt => attempt.attemptId === row.attempt_id));
      assert.ok((await manager.repository.getBroadcastEvents(row.delivery_job_id)).some(event =>
        event.attemptId === row.attempt_id && event.endpointLabel !== null && event.completedAt === null),"endpoint marker must commit before actual forwarding");
    } });
    primary = await destinationAccessPath(observer.url); secondary = await destinationAccessPath(observer.url);
    env.CHAIN_B_RPC_URLS = JSON.stringify([primary.url,secondary.url]); env.CHAIN_B_RPC_URL = primary.url;
    config.destinationRpcUrls = Object.freeze([primary.url,secondary.url]); config.destinationRpcUrl = primary.url;
    manager = createTransactionManager({ config,pool,queue });
    const sourceBefore = await sourceState(pool,config.databaseSchema); const queueBefore = await queue.listReadyDeliveryJobs();
    await destination.request({ method: "evm_setAutomine",params: [false] });
    async function expire(id) {
      await pool.query(`UPDATE ${tableName(config.databaseSchema,"relayer_job_leases")} SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
    }
    async function run(workerId,request) {
      const child = processes.start(workerId,request); await child.started;
      const result = (await child.wait("result")).result; await child.finish(); return result;
    }
    async function crash(workerId,request) {
      const child = processes.start(workerId,request); await child.started;
      const point = await child.wait("checkpoint"); assert.equal(point.name,request.checkpoint);
      await processes.stop(child,"SIGKILL");
      await waitForBackendRelease(pool,config,request.id,workerId); await expire(request.id);
      console.log(`VALID: real worker ${workerId} stopped at ${point.name} for ${request.id}`);
      return point;
    }
    async function get(id) { return manager.repository.getTransaction(id); }
    async function identity(id,expected) {
      const actual = await get(id);
      assert.equal(actual.intent.intentId,expected.intent.intentId); assert.equal(actual.intent.packageDigest,expected.intent.packageDigest);
      assert.equal(actual.intent.senderAddress,expected.intent.senderAddress);
      for (const field of exactFields) assert.equal(actual.attempt[field],expected.attempt[field]);
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(config.databaseSchema,"transaction_intents")} WHERE delivery_job_id = $1`,[id])).rows[0].count,1);
      return actual;
    }
    async function mineDepth() { await destination.request({ method: "anvil_mine",params: [toHex(config.destinationConfirmations)] }); }
    const id = jobs[0].deliveryJobId;
    await crash("relayer-a",{ id,mode: "job",checkpoint: "lease-acquired" }); assert.equal(await get(id),null);
    await crash("relayer-b",{ id,mode: "job",checkpoint: "intent-insert" });
    assert.equal(await get(id),null); assert.equal(await manager.repository.getAccount(),null);
    await crash("relayer-a",{ id,mode: "job",checkpoint: "signed-persisted" });
    const signed = await get(id); const account = await manager.repository.getAccount(); assert.equal(signed.attempt.status,"SIGNED");
    await crash("relayer-b",{ id,mode: "job",checkpoint: "broadcast-start" });
    assert.equal(await destination.request({ method: "eth_getTransactionByHash",params: [signed.attempt.transactionHash] }),null);
    assert.equal((await manager.repository.getBroadcastEvents(id))[0].completedAt,null);
    await crash("relayer-a",{ id,mode: "job",checkpoint: "endpoint-result" });
    assert.ok(await destination.request({ method: "eth_getTransactionByHash",params: [signed.attempt.transactionHash] }),"actual Chain B acceptance must precede process termination");
    assert.equal((await get(id)).attempt.status,"SIGNED");
    const ambiguous = await manager.repository.getRecoverySnapshot(id);
    primary.state.available = false; secondary.state.available = false;
    const offline = await run("relayer-b",{ id,mode: "transaction",operation: "recover" });
    assert.equal(offline.results[0].reason,"RPC_UNAVAILABLE"); assert.deepEqual(await manager.repository.getRecoverySnapshot(id),ambiguous);
    secondary.state.available = true;
    const wireBefore = primary.calls.concat(secondary.calls).filter(call => call.method === "eth_sendRawTransaction").length;
    await run("relayer-b",{ id,mode: "job" }); await identity(id,signed);
    assert.equal(primary.calls.concat(secondary.calls).filter(call => call.method === "eth_sendRawTransaction").length,wireBefore);
    assert.deepEqual(await manager.repository.getAccount(),account);
    await destination.request({ method: "anvil_mine",params: ["0x1"] });
    await crash("relayer-a",{ id,mode: "job",checkpoint: "receipt-observed" }); assert.equal((await get(id)).intent.status,"PENDING");
    await mineDepth(); const beforeFinal = await get(id);
    await crash("relayer-b",{ id,mode: "job",checkpoint: "outcome-commit" });
    assert.deepEqual(await get(id),beforeFinal,"SIGKILL before final COMMIT must roll back all outcome fields");
    await crash("relayer-a",{ id,mode: "job",checkpoint: "outcome-return" });
    assert.equal((await get(id)).intent.status,"CONFIRMED");
    const final = await get(id); const noOp = await run("relayer-b",{ id,mode: "transaction",operation: "recover" });
    assert.equal(noOp.rebroadcast,0); assert.deepEqual(await get(id),final);
    primary.state.available = true;

    const oldId = jobs[1].deliveryJobId; await run("relayer-a",{ id: oldId,mode: "job" }); const old = await get(oldId);
    const due = Date.parse(old.attempt.broadcastAt) + config.replacementAfterMs;
    await crash("relayer-a",{ id: oldId,mode: "transaction",operation: "replace",now: due,checkpoint: "signed-commit" });
    assert.equal((await get(oldId)).attempts.length,1,"replacement insertion before commit must roll back");
    await crash("relayer-b",{ id: oldId,mode: "transaction",operation: "replace",now: due,checkpoint: "replacement-persisted" });
    const replacement = await get(oldId); assert.equal(replacement.attempts.length,2);
    await crash("relayer-a",{ id: oldId,mode: "transaction",operation: "broadcast",checkpoint: "broadcast-start" });
    await mineDepth(); await run("relayer-b",{ id: oldId,mode: "job" });
    const oldFinal = await get(oldId); assert.equal(oldFinal.intent.winningAttemptId,old.attempt.attemptId);
    assert.equal(oldFinal.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction); assert.equal(oldFinal.attempts.length,2);

    const newId = jobs[2].deliveryJobId; await run("relayer-a",{ id: newId,mode: "job" }); const initial = await get(newId);
    await run("relayer-b",{ id: newId,mode: "transaction",operation: "replace",now: Date.parse(initial.attempt.broadcastAt) + config.replacementAfterMs });
    const candidate = await get(newId); assert.equal(candidate.attempts.length,2);
    primary.setFault("eth_sendRawTransaction","drop-after-forward");
    await crash("relayer-a",{ id: newId,mode: "transaction",operation: "broadcast",checkpoint: "endpoint-result" });
    assert.ok(await destination.request({ method: "eth_getTransactionByHash",params: [candidate.attempt.transactionHash] }));
    primary.state.available = false;
    const recovered = await run("relayer-b",{ id: newId,mode: "job" }); assert.equal(recovered.attempt.status,"BROADCAST");
    await identity(newId,candidate); assert.equal((await get(newId)).attempts.length,2);
    // Test-only bytecode exercises a real status-0 receipt, without implementing
    // a destination protocol. Snapshot restoration removes this local fixture.
    codeAddress = candidate.intent.destinationGateway;
    originalCode = await destination.request({ method: "eth_getCode",params: [codeAddress,"latest"] });
    await destination.request({ method: "anvil_setCode",params: [codeAddress,"0x60006000fd"] });
    await mineDepth(); await run("relayer-a",{ id: newId,mode: "transaction",operation: "recover" });
    const reverted = await get(newId); assert.equal(reverted.intent.status,"REVERTED"); assert.equal(reverted.intent.winningAttemptId,candidate.attempt.attemptId);
    assert.equal(reverted.attempts.length,2);
    assert.equal((await manager.repository.getAccount()).nextNonce,(BigInt(signed.intent.nonce) + 3n).toString());
    for (const job of jobs) {
      const stored = await get(job.deliveryJobId); assert.notEqual(stored.intent.status,"PENDING");
      const winner = stored.winningAttempt;
      const block = await destination.request({ method: "eth_getBlockByNumber",params: [toHex(BigInt(winner.receiptBlockNumber)),true] });
      assert.equal(block.hash.toLowerCase(),winner.receiptBlockHash);
      assert.equal(block.transactions.filter(tx => tx.from.toLowerCase() === stored.intent.senderAddress && BigInt(tx.nonce).toString() === stored.intent.nonce).length,1);
    }
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore); assert.deepEqual(await queue.listReadyDeliveryJobs(),queueBefore);
    assert.deepEqual(await sourceState(sourcePool,sourceConfig.databaseSchema),original);
    assert.equal(observer.errors.length,0); assert.equal(primary.errors.length,0); assert.equal(secondary.errors.length,0);
    console.log("VALID: actual crash-after-send, interrupted failover/replacement, receipt/final-commit recovery and restart preserved one intent/nonce/linear history and one canonical winner per job");
  } catch (error) { failure = error; throw error; }
  finally {
    const cleanups = await Promise.allSettled([processes.close()]);
    const paths = await Promise.allSettled([primary?.close(),secondary?.close()]);
    const observed = await Promise.allSettled([observer?.close()]); cleanups.push(...paths,...observed);
    for (const restore of [
      async () => { if (originalCode !== undefined) await destination.request({ method: "anvil_setCode",params: [codeAddress,originalCode] }); },
      async () => { if (snapshotId !== undefined) assert.equal(await destination.request({ method: "evm_revert",params: [snapshotId] }),true); },
      async () => { if (automine !== undefined) await destination.request({ method: "evm_setAutomine",params: [automine] }); },
    ]) {
      try { await restore(); } catch (error) { cleanups.push({ status: "rejected",reason: error }); }
    }
    const closed = await Promise.allSettled([pool.end()]);
    const error = [...cleanups,...closed].find(result => result.status === "rejected");
    if (error) { if (!failure) throw error.reason; console.error(`Crash fixture cleanup also failed: ${error.reason.message}`); }
  }
}
