import assert from "node:assert/strict";
import { metricValue } from "./metrics-assertions.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { toHex } from "viem";
import { applyMigrations,createDatabasePool,readMessages,resetIndexerTables,tableName } from "../../src/db.mjs";
import { createIndexer } from "../../src/indexer.mjs";
import { createFinalityWatcher } from "../../src/finality-watcher.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { verifyRpcTransaction } from "../../src/transaction-manager/receipts.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { destinationAccessPath } from "./rpc-failover-integration.mjs";
import { rpcObserver } from "../../../validator/test/helpers/process-cluster.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";

const execFileAsync = promisify(execFile);
const managerEntry = fileURLToPath(new URL("../../src/transaction-manager/main.mjs",import.meta.url));
const quiet = { log() {},warn() {},error() {} };
const signedFields = ["attemptId","attemptNumber","replacementOfAttemptId","nonce","gasLimit","transactionType",
  "maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"];
const intentFields = ["intentId","packageDigest","chainId","senderAddress","destinationGateway","value","calldata","nonce"];

// Called only by the existing real-chain verification. It reuses the existing
// proxy, observer, official source builders and trusted QC; no new chain or
// validator service is started. Its destination snapshot is restored on exit.
export async function verifyTransientRpcFailures({ environment,sourceConfig,sourcePool,snapshot,destination,upstream }) {
  const original = await sourceState(sourcePool,sourceConfig.databaseSchema);
  const env = { ...environment,INDEXER_DB_SCHEMA: "cross_chain_rpc_transient_verification" };
  const config = { ...sourceConfig,...loadTransactionConfig(env),
    sourceGatewayStartBlock: snapshot.batch.messages.reduce((height,message) =>
      message.sourceBlockNumber < height ? message.sourceBlockNumber : height,snapshot.batch.messages[0].sourceBlockNumber) };
  assert.notEqual(config.databaseSchema,sourceConfig.databaseSchema,"transient verification requires an isolated database namespace");
  const pool = createDatabasePool(config); const queue = createDeliveryRepository({ config,pool });
  let primary; let secondary; let observer; let manager; let snapshotId; let automine; let failure;
  try {
    snapshotId = await destination.request({ method: "evm_snapshot",params: [] });
    automine = await destination.request({ method: "anvil_getAutomine",params: [] });
    await applyMigrations(pool,config.databaseSchema); await resetIndexerTables(pool,config.databaseSchema);
    await createIndexer({ config,pool,logger: quiet }).catchUpOnce();
    await createFinalityWatcher({ config,pool,logger: quiet }).runFinalityPass();
    const members = (await readMessages(pool,config.databaseSchema)).filter(row => snapshot.batch.messageIds.includes(row.message_id));
    assert.equal(members.length,snapshot.members.length); assert.ok(members.every(row => row.status === "FINALIZED"));
    const lifecycle = createBatchLifecycle({ config,pool,validatorSets: config.validatorSets });
    const building = await lifecycle.getOrCreateBuilding({ initialEpoch: snapshot.record.epoch });
    await lifecycle.assignMessages({ batchRecordId: building.record.batchRecordId,sourceMessageIds: members.map(row => row.id) });
    await lifecycle.sealBatch({ batchRecordId: building.record.batchRecordId });
    await lifecycle.markConsensusPending({ batchRecordId: building.record.batchRecordId });
    await lifecycle.commitWithCertificate({ certificate: snapshot.quorumCertificate });
    await createDeliveryProjector({ config,pool }).materializeBatch({ batchRecordId: building.record.batchRecordId });
    const jobs = await queue.listReadyDeliveryJobs(); assert.equal(jobs.length,3);
    const sourceBefore = await sourceState(pool,config.databaseSchema); const queueBefore = await queue.listReadyDeliveryJobs();
    observer = await rpcObserver(upstream,{ async beforeForward(request) {
      if (request.method !== "eth_sendRawTransaction") return;
      const row = (await pool.query("SELECT delivery_job_id,attempt_id FROM " + tableName(config.databaseSchema,"transaction_attempts") +
        " WHERE raw_signed_transaction = $1",[request.params[0]])).rows[0];
      assert.ok(row,"actual forwarding requires the committed exact signed attempt");
      const stored = await manager.repository.getTransaction(row.delivery_job_id);
      assert.ok(stored.attempts.some(attempt => attempt.attemptId === row.attempt_id && attempt.rawSignedTransaction === request.params[0]));
      assert.ok((await manager.repository.getBroadcastEvents(row.delivery_job_id)).some(event =>
        event.attemptId === row.attempt_id && event.endpointLabel !== null && event.completedAt === null));
    } });
    primary = await destinationAccessPath(observer.url); secondary = await destinationAccessPath(observer.url);
    env.CHAIN_B_RPC_URLS = JSON.stringify([primary.url,secondary.url]); env.CHAIN_B_RPC_URL = primary.url;
    config.destinationRpcUrls = Object.freeze([primary.url,secondary.url]); config.destinationRpcUrl = primary.url;
    manager = createTransactionManager({ config,pool,queue });
    await destination.request({ method: "evm_setAutomine",params: [false] });
    const nonceBefore = BigInt(await destination.request({ method: "eth_getTransactionCount",params: [config.relayerAddress,"pending"] }));
    const sends = path => path.calls.filter(call => call.method === "eth_sendRawTransaction");
    const preparation = () => observer.calls.filter(call => ["eth_estimateGas","eth_maxPriorityFeePerGas"].includes(call.method)).length;
    function unchanged(before,after) {
      assert.equal(after.attempts.length,1);
      for (const field of signedFields) assert.equal(after.attempt[field],before.attempt[field]);
      for (const field of intentFields) assert.equal(after.intent[field],before.intent[field]);
      assert.equal(after.intent.retryStoppedAt,null);
    }
    async function finalize(id,signed,account,receipt408 = false) {
      const pending = await manager.repository.getTransaction(id); unchanged(signed,pending);
      assert.equal(pending.attempt.status,"BROADCAST"); assert.equal(pending.intent.status,"PENDING");
      const body = await destination.request({ method: "eth_getTransactionByHash",params: [pending.attempt.transactionHash] });
      verifyRpcTransaction(pending.intent,pending.attempt,body); assert.equal(body.blockNumber,null);
      assert.equal(await destination.request({ method: "eth_getTransactionReceipt",params: [pending.attempt.transactionHash] }),null);
      await destination.request({ method: "anvil_mine",params: [toHex(config.destinationConfirmations)] });
      if (receipt408) primary.setFault("eth_getTransactionReceipt","http-408");
      await manager.checkReceiptsOnce();
      const confirmed = await manager.repository.getTransaction(id); unchanged(signed,confirmed);
      assert.equal(confirmed.intent.status,"CONFIRMED"); assert.equal(confirmed.intent.winningAttemptId,signed.attempt.attemptId);
      const receipt = await destination.request({ method: "eth_getTransactionReceipt",params: [signed.attempt.transactionHash] });
      const transaction = await destination.request({ method: "eth_getTransactionByHash",params: [signed.attempt.transactionHash] });
      verifyRpcTransaction(confirmed.intent,confirmed.attempt,transaction,receipt);
      const block = await destination.request({ method: "eth_getBlockByNumber",params: [receipt.blockNumber,false] });
      assert.equal(block.hash.toLowerCase(),confirmed.attempt.receiptBlockHash);
      assert.equal(confirmed.attempt.receiptStatus,1);
      assert.ok(BigInt(confirmed.attempt.confirmedHead) - BigInt(confirmed.attempt.receiptBlockNumber) + 1n >= config.destinationConfirmations);
      assert.deepEqual(await manager.repository.getAccount(),account);
      if (receipt408) {
        assert.ok(primary.faultsApplied.some(event => event.method === "eth_getTransactionReceipt" && event.httpStatus === 408 && !event.forwarded));
        assert.ok(secondary.calls.some(call => call.method === "eth_getTransactionReceipt" && call.params[0] === signed.attempt.transactionHash));
        console.log("VALID: receipt HTTP 408 remained a transient read; another sampled path supplied the canonical receipt");
      }
      return confirmed;
    }
    for (const [index,mode] of ["http-429","http-408-after-forward","provider-limit"].entries()) {
      const id = jobs[index].deliveryJobId; const signed = await manager.prepareDeliveryTransaction(id);
      const account = await manager.repository.getAccount(); const prepared = preparation();
      assert.equal(signed.attempt.nonce,(nonceBefore + BigInt(index)).toString());
      const firstSends = sends(primary).length; const secondSends = sends(secondary).length;
      primary.setFault("eth_sendRawTransaction",mode);
      const rpcBefore = await metricValue("rpc_failures_total");
      const relayerBefore = await metricValue("relayer_failures_total");
      if (mode === "http-408-after-forward") {
        secondary.state.available = false;
        await assert.rejects(manager.broadcastPreparedTransaction(id),error => error.code === "RPC_UNAVAILABLE" &&
          error.errorClass === "AMBIGUOUS_BROADCAST" && error.observations.some(event => event.httpStatus === 408 && event.errorClass === "AMBIGUOUS_BROADCAST"));
        assert.equal(await metricValue("relayer_failures_total"), relayerBefore + 1);
        console.log("VALID: real relayer operational failures increment only bounded classified failure series and expose no secret error material");
        const ambiguous = await manager.repository.getTransaction(id); unchanged(signed,ambiguous);
        assert.equal(ambiguous.attempt.status,"SIGNED"); assert.equal(ambiguous.attempt.lastErrorClass,"AMBIGUOUS_BROADCAST");
        assert.equal(ambiguous.attempt.broadcastAttemptCount,"1"); assert.ok(ambiguous.intent.nextActionAt);
        assert.ok(primary.faultsApplied.some(event => event.mode === mode && event.forwarded && event.transactionHash === signed.attempt.transactionHash));
        const accepted = await destination.request({ method: "eth_getTransactionByHash",params: [signed.attempt.transactionHash] });
        verifyRpcTransaction(signed.intent,signed.attempt,accepted); assert.equal(accepted.blockNumber,null);
        primary.state.available = false; secondary.state.available = true;
        let fresh;
        try { fresh = await execFileAsync(process.execPath,[managerEntry,"recover"],{ env,timeout: 30000 }); }
        catch (error) {
          process.stdout.write(safeRelayerMessage({ message: error.stdout ?? "" },config));
          process.stderr.write(safeRelayerMessage({ message: error.stderr ?? "" },config)); throw error;
        }
        assert.ok(!fresh.stdout.includes(config.privateKey) && !fresh.stderr.includes(config.privateKey));
        process.stdout.write(fresh.stdout); process.stderr.write(fresh.stderr);
        const recovery = JSON.parse(fresh.stdout.trim().split("\n").at(-1));
        assert.equal(recovery.rebroadcast,0); assert.equal(recovery.reconciled,1);
        const recovered = recovery.results.find(result => result.deliveryJobId === id);
        assert.ok(recovered); assert.equal(recovered.action,"RECONCILED");
        assert.equal(sends(primary).length,firstSends + 1); assert.equal(sends(secondary).length,secondSends);
        primary.state.available = true;
        console.log("VALID: primary forwarded exact transaction then returned HTTP 408; classified AMBIGUOUS_BROADCAST; fresh process reconciled its persisted hash through secondary with no new send/attempt/nonce/signature");
      } else {
        const sent = await manager.broadcastPreparedTransaction(id); unchanged(signed,sent);
        assert.equal(await metricValue("rpc_failures_total"), rpcBefore + 1);
        assert.equal(await metricValue("relayer_failures_total"), relayerBefore, "successful failover is no failed manager action");
        console.log("VALID: a real destination RPC-path failure increments structured RPC failure metrics even when failover later completes the production operation");
        assert.equal(sent.acceptedEndpointLabel,"rpc-1");
        assert.ok(sent.rpcObservations.some(event => event.endpointLabel === "rpc-0" && event.errorClass === "TRANSIENT_RPC_ERROR" &&
          (mode === "http-429" ? event.httpStatus === 429 : event.rpcCode === -32007)));
        assert.ok(primary.faultsApplied.some(event => event.mode === mode && !event.forwarded));
        assert.equal(sends(primary).length,firstSends + 1); assert.equal(sends(secondary).length,secondSends + 1);
        assert.equal(sends(primary).at(-1).params[0],signed.attempt.rawSignedTransaction);
        assert.equal(sends(secondary).at(-1).params[0],signed.attempt.rawSignedTransaction);
        console.log("VALID: primary " + (mode === "http-429" ? "HTTP 429" : "configured JSON-RPC -32007") +
          " classified TRANSIENT_RPC_ERROR; secondary used the exact persisted bytes/hash with one attempt and no new nonce/signature");
      }
      assert.equal(preparation(),prepared,"failover and recovery must not repeat gas/fee estimation");
      const stored = await manager.repository.getTransaction(id); unchanged(signed,stored);
      assert.equal(stored.attempt.broadcastAttemptCount,"1"); assert.deepEqual(await manager.repository.getAccount(),account);
      await finalize(id,signed,account,index === 2);
    }
    const last = await manager.repository.getTransaction(jobs[2].deliveryJobId);
    const account = await manager.repository.getAccount();
    const rpc = createTransactionRpc(config);
    for (const [mode,code,errorClass] of [["invalid-transaction","DETERMINISTIC_REJECTION","DETERMINISTIC_REJECTION"],
      ["invalid-json","RPC_INVALID_RESPONSE","RPC_RESPONSE_ERROR"]]) {
      const secondSends = sends(secondary).length; const forwarded = observer.calls.filter(call => call.method === "eth_sendRawTransaction").length;
      primary.setFault("eth_sendRawTransaction",mode);
      await assert.rejects(rpc.broadcast(last.attempt.rawSignedTransaction,last.attempt.transactionHash),
        error => error.code === code && error.errorClass === errorClass);
      assert.equal(sends(secondary).length,secondSends);
      assert.equal(observer.calls.filter(call => call.method === "eth_sendRawTransaction").length,forwarded);
      console.log("VALID: controlled " + mode + " response classified " + errorClass + "; no blind broadcast to another endpoint");
    }
    assert.deepEqual(await manager.repository.getTransaction(jobs[2].deliveryJobId),last);
    assert.deepEqual(await manager.repository.getAccount(),account);
    assert.equal(account.nextNonce,(nonceBefore + 3n).toString());
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore); assert.deepEqual(await queue.listReadyDeliveryJobs(),queueBefore);
    assert.deepEqual(await sourceState(sourcePool,sourceConfig.databaseSchema),original);
    assert.equal(observer.errors.length,0); assert.equal(primary.errors.length,0); assert.equal(secondary.errors.length,0);
    console.log("VALID: real transient RPC scenarios preserved three exact intents/nonces/attempts and canonical winners on one Chain B");
  } catch (error) {
    failure = error;
    const redaction = { ...config,destinationRpcUrls: [...config.destinationRpcUrls,upstream] };
    for (const diagnostic of [...(observer?.errors ?? []),...(primary?.errors ?? []),...(secondary?.errors ?? [])]) {
      console.error("Transient RPC fixture forwarding failure: " + safeRelayerMessage(diagnostic,redaction));
    }
    throw error;
  }
  finally {
    const paths = await Promise.allSettled([primary?.close(),secondary?.close()]);
    const observed = await Promise.allSettled([observer?.close()]); const cleanup = [...paths,...observed];
    for (const restore of [
      async () => { if (snapshotId !== undefined) assert.equal(await destination.request({ method: "evm_revert",params: [snapshotId] }),true); },
      async () => { if (automine !== undefined) await destination.request({ method: "evm_setAutomine",params: [automine] }); },
    ]) {
      try { await restore(); } catch (error) { cleanup.push({ status: "rejected",reason: error }); }
    }
    cleanup.push(...await Promise.allSettled([pool.end()]));
    const rejected = cleanup.find(result => result.status === "rejected");
    if (rejected) { if (!failure) throw rejected.reason; console.error("Transient RPC fixture cleanup failed: " + safeRelayerMessage(rejected.reason,config)); }
  }
}
