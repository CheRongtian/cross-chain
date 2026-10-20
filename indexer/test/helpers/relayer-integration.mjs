import assert from "node:assert/strict";
import { metricValue } from "./metrics-assertions.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { normalizeAddress, normalizeBytes32 } from "../../src/canonical-message.mjs";
import { tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";
import { rpcObserver } from "../../../validator/test/helpers/process-cluster.mjs";
import { verifyPendingReplacement } from "./transaction-retry-integration.mjs";
import { destinationAccessPath } from "./rpc-failover-integration.mjs";
import { createRelayerProcesses, verifyLeaseTakeover, verifySignedTakeover, verifyConcurrentRelayers } from "./multi-relayer-integration.mjs";
import { verifyTransactionCrashes } from "./transaction-crash-integration.mjs";
import { verifyTransientRpcFailures } from "./rpc-transient-integration.mjs";

const execFileAsync = promisify(execFile);
const MAIN = fileURLToPath(new URL("../../src/relayer/main.mjs",import.meta.url));
const FAILURE = fileURLToPath(new URL("./fail-relayer-rpc.mjs",import.meta.url));
const MANAGER = fileURLToPath(new URL("../../src/transaction-manager/main.mjs",import.meta.url));

export async function verifySingleRelayer({ config,pool,snapshots,validatorSets,orphanMessageIds = [] }) {
  assert.ok(process.env.RELAYER_A_PRIVATE_KEY,"verification must inject its development Relayer A signer");
  assert.ok(process.env.CHAIN_B_RPC_URL,"verification must supply its existing Chain B RPC");
  assert.ok(process.env.CHAIN_B_CHAIN_ID,"verification must supply its existing Chain B identity");
  const env = { ...process.env,DATABASE_URL: config.databaseUrl,INDEXER_DB_SCHEMA: config.databaseSchema,
    CHAIN_A_DOMAIN: config.chainDomain.toString(),SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
    VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_SET_HISTORY: deliveryJson(validatorSets.history),RELAYER_MAX_JOBS_PER_RUN: "100" };
  // Local verification always controls its own destination access paths.
  env.CHAIN_B_RPC_URLS = JSON.stringify([process.env.CHAIN_B_RPC_URL]);
  const bootstrap = createPublicClient({ transport: http(process.env.CHAIN_B_RPC_URL,{ retryCount: 0,timeout: 10000 }) });
  const genesis = await bootstrap.request({ method: "eth_getBlockByNumber",params: ["0x0",false] },
    { retryCount: 0,signal: AbortSignal.timeout(10000) });
  assert.equal(genesis?.number,"0x0");
  env.CHAIN_B_GENESIS_HASH = normalizeBytes32(genesis.hash,"local Chain B genesis");
  console.log(`Chain B expected genesis hash: ${env.CHAIN_B_GENESIS_HASH}`);
  const relayConfig = loadTransactionConfig(env);
  const queue = createDeliveryRepository({ config: relayConfig,pool });
  const repository = createRelaySubmissionRepository({ config: relayConfig,pool,queue });
  const destination = createPublicClient({ transport: http(relayConfig.destinationRpcUrl,{ retryCount: 0 }) });
  const source = createPublicClient({ transport: http(config.chainRpcUrl,{ retryCount: 0 }) });
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const jobs = await queue.listReadyDeliveryJobs();
  const expectedCount = snapshots.reduce((count,snapshot) => count + snapshot.members.length,0);
  assert.equal(jobs.length,expectedCount);
  assert.ok(jobs.every((job) => !orphanMessageIds.includes(job.messageId)));
  const submissions = tableName(config.databaseSchema,"relayer_submissions");
  const intents = tableName(config.databaseSchema,"transaction_intents");
  const attempts = tableName(config.databaseSchema,"transaction_attempts");
  let manager;
  let failedRun = false;
  const observed = [];
  const estimates = new Map();
  const packagesByData = new Map();
  for (const job of jobs) {
    const encoded = await encodeGatewaySubmission(await queue.getDeliveryPackage(job.deliveryJobId),{ validatorSets });
    packagesByData.set(encoded.calldata,encoded.package);
  }
  let latestBaseFee;
  let latestPriorityFee;
  const observer = await rpcObserver(relayConfig.destinationRpcUrl,{ async beforeForward(request) {
    if (request.method === "eth_estimateGas") {
      const input = request.params[0]; const pack = packagesByData.get(input.data);
      assert.ok(pack,"gas estimation must use exact verified delivery calldata");
      assert.equal(normalizeAddress(input.from),relayConfig.relayerAddress);
      assert.equal(normalizeAddress(input.to),pack.message.destinationGateway); assert.equal(BigInt(input.value),0n);
    }
    if (request.method !== "eth_sendRawTransaction") return;
    const raw = request.params[0];
    const hash = keccak256(raw).toLowerCase();
    const row = (await pool.query(`SELECT delivery_job_id,status,raw_signed_transaction,transaction_hash FROM ${attempts} WHERE transaction_hash = $1`,[hash])).rows[0];
    assert.ok(row,"exact signed transaction must already be visible in PostgreSQL before real RPC forwarding");
    assert.ok(["SIGNED","BROADCAST"].includes(row.status)); assert.equal(row.raw_signed_transaction,raw); assert.equal(row.transaction_hash,hash);
    const stored = await manager.repository.getTransaction(row.delivery_job_id);
    const attempt = stored.attempts.find(a => a.transactionHash === hash);
    assert.ok(attempt); assert.equal(attempt.rawSignedTransaction,raw); assert.equal(attempt.transactionType,2);
    assert.ok(BigInt(attempt.gasLimit) > 0n);
    assert.equal(BigInt(attempt.gasLimit),estimates.get(stored.intent.calldata));
    if (attempt.attemptNumber === 0) {
      assert.equal(BigInt(attempt.maxPriorityFeePerGas),latestPriorityFee);
      assert.equal(BigInt(attempt.maxFeePerGas),2n * latestBaseFee + latestPriorityFee);
    } else {
      const parent = stored.attempts[attempt.attemptNumber - 1];
      assert.equal(attempt.nonce,stored.intent.nonce); assert.equal(attempt.gasLimit,parent.gasLimit);
      assert.ok(BigInt(attempt.maxPriorityFeePerGas) > BigInt(parent.maxPriorityFeePerGas));
      assert.ok(BigInt(attempt.maxFeePerGas) > BigInt(parent.maxFeePerGas));
      assert.ok(BigInt(attempt.maxPriorityFeePerGas) >= latestPriorityFee);
      assert.ok(BigInt(attempt.maxFeePerGas) >= 2n * latestBaseFee + latestPriorityFee);
    }
    observed.push({ deliveryJobId: row.delivery_job_id,transactionHash: hash,nonce: attempt.nonce });
  },async afterForward(request,reply) {
    if (request.method === "eth_estimateGas") estimates.set(request.params[0].data,BigInt(reply.result));
    if (request.method === "eth_maxPriorityFeePerGas") latestPriorityFee = BigInt(reply.result);
    if (request.method === "eth_getBlockByNumber" && request.params[0] === "latest") latestBaseFee = BigInt(reply.result.baseFeePerGas);
    if (request.method === "eth_sendRawTransaction") {
      if (reply.error) throw new Error(`Chain B rejected persisted raw transaction: ${reply.error.code} ${reply.error.message}`);
      assert.equal(typeof reply.result,"string","Chain B must return the submitted transaction hash");
      assert.equal(reply.result.toLowerCase(),keccak256(request.params[0]).toLowerCase());
    }
  } });
  let primary; let secondary; let processes;
  try {
    primary = await destinationAccessPath(observer.url);
    secondary = await destinationAccessPath(observer.url);
  } catch (error) {
    const cleanup = await Promise.allSettled([primary?.close(),observer.close()]);
    for (const result of cleanup) if (result.status === "rejected") console.error(`Destination access initialization cleanup failed: ${result.reason.message}`);
    throw error;
  }
  env.CHAIN_B_RPC_URLS = JSON.stringify([primary.url,secondary.url]);
  env.CHAIN_B_RPC_URL = primary.url;
  try {
    processes = createRelayerProcesses({ environment: env,pidFile: process.env.RELAYER_VERIFICATION_PID_FILE });
    manager = createTransactionManager({ config: loadTransactionConfig(env),pool,queue,legacy: repository });
    async function queueState() {
      return {
        batches: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema,"delivery_batches")} ORDER BY batch_record_id`)).rows,
        jobs: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema,"delivery_jobs")} ORDER BY batch_record_id,message_index`)).rows,
      };
    }
    const queueBefore = await queueState();
    const count = async table => (await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count;
    const nonce = async (client) => BigInt(await client.request({ method: "eth_getTransactionCount",params: [relayConfig.relayerAddress,"pending"] }));
    const destinationNonce = await nonce(destination);
    assert.equal(await count(submissions),0); assert.equal(await count(intents),0); assert.equal(await count(attempts),0);
    const sourceNonce = await nonce(source);
    async function failed(path,environment,expected) {
      await assert.rejects(execFileAsync(process.execPath,[path],{ env: environment }), (error) => {
        assert.ok(!(error.stdout ?? "").includes(relayConfig.privateKey) && !(error.stderr ?? "").includes(relayConfig.privateKey));
        process.stdout.write(error.stdout ?? ""); process.stderr.write(error.stderr ?? "");
        return error.code === 1 && (error.stderr ?? "").includes(expected);
      });
    }
    await failed(MAIN,{ ...env,CHAIN_B_RPC_URLS: JSON.stringify([config.chainRpcUrl]) },"CHAIN_ID_MISMATCH");
    assert.equal(await nonce(source),sourceNonce); assert.equal(await nonce(destination),destinationNonce);
    assert.equal(await count(intents),0); assert.equal(await count(attempts),0);
    primary.state.genesisOverride = `0x${"ab".repeat(32)}`;
    await failed(MAIN,{ ...env,CHAIN_B_RPC_URLS: JSON.stringify([primary.url]) },"GENESIS_HASH_MISMATCH");
    assert.equal(await count(intents),0); assert.equal(await count(attempts),0);
    primary.state.genesisOverride = null;
    console.log("VALID: wrong-chain and same-chain-ID/wrong-genesis paths were rejected before nonce reservation or signing");
    const takeover = await verifyLeaseTakeover({ processes,pool,config: relayConfig,id: jobs[0].deliveryJobId });
    await failed(FAILURE,{ ...env,RELAYER_WORKER_ID: "relayer-b" },"expected injected Relayer RPC submission failure");
    const createdByB = (await pool.query(`SELECT owner_id,fencing_token FROM ${tableName(config.databaseSchema,"relayer_job_leases")} WHERE delivery_job_id = $1`,[jobs[0].deliveryJobId])).rows[0];
    assert.equal(createdByB.owner_id,"relayer-b"); assert.ok(BigInt(createdByB.fencing_token) > BigInt(takeover.fencingToken));
    assert.equal(await count(intents),1); assert.equal(await count(attempts),1); assert.equal(await nonce(destination),destinationNonce);
    const firstId = jobs[0].deliveryJobId;
    const signed = await manager.repository.getTransaction(firstId);
    assert.equal(signed.attempt.status,"SIGNED"); assert.equal(signed.attempt.nonce,destinationNonce.toString());
    assert.equal(observed.length,0);
    assert.deepEqual(await queueState(),queueBefore);
    console.log("VALID: wrong chain produced no intent; injected broadcast failure retained one SIGNED attempt without an on-chain transaction");
    async function run(path = MAIN,args = []) {
      const result = await execFileAsync(process.execPath,[path,...args],{ env });
      assert.ok(!result.stdout.includes(relayConfig.privateKey) && !result.stderr.includes(relayConfig.privateKey));
      process.stdout.write(result.stdout); process.stderr.write(result.stderr);
      return JSON.parse(result.stdout.trim().split("\n").at(-1));
    }
    const recoveredSigned = await run(MANAGER,["read",firstId]);
    assert.deepEqual(recoveredSigned,signed);
    const estimatesBefore = observer.calls.filter(call => call.method === "eth_estimateGas").length;
    const feesBefore = observer.calls.filter(call => call.method === "eth_maxPriorityFeePerGas").length;
    await assert.rejects(manager.submitDelivery(jobs[1].deliveryJobId),{ code: "SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST" });
    assert.equal(await count(attempts),1); assert.equal(await nonce(destination),destinationNonce); assert.equal(observed.length,0);
    const accountBeforeFailure = await manager.repository.getAccount();
    primary.state.available = false; secondary.state.available = false;
    await assert.rejects(manager.broadcastPreparedTransaction(firstId),{ code: "RPC_UNAVAILABLE" });
    assert.deepEqual(await manager.repository.getTransaction(firstId),signed);
    assert.deepEqual(await manager.repository.getAccount(),accountBeforeFailure);
    assert.deepEqual(await run(MANAGER,["read",firstId]),signed);
    assert.deepEqual(await queueState(),queueBefore); assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    primary.state.available = true; secondary.state.available = true;
    primary.setFault("eth_sendRawTransaction","drop-after-forward");
    secondary.setFault("eth_sendRawTransaction","already-known");
    const retryTime = Math.max(Date.now(),Date.parse(signed.intent.nextActionAt));
    const retryManager = createTransactionManager({ config: loadTransactionConfig(env),pool,queue,legacy: repository,clock: { now: () => retryTime } });
    const retryBefore = await metricValue("delivery_retries_total", { labels: { kind: "exact_rebroadcast" } });
    const attemptsBefore = await metricValue("delivery_attempts_total");
    const retryResult = await retryManager.processTransactionRetriesOnce();
    assert.equal(retryResult.replacements,0); assert.equal(retryResult.broadcasts,1);
    assert.equal(await metricValue("delivery_retries_total", { labels: { kind: "exact_rebroadcast" } }), retryBefore + 1, "primary response loss plus secondary failover is one repeated logical send");
    assert.equal(await metricValue("delivery_attempts_total"), attemptsBefore);
    const firstBroadcast = await manager.repository.getTransaction(firstId);
    assert.equal(firstBroadcast.attempt.status,"BROADCAST");
    assert.equal(firstBroadcast.attempt.broadcastAttemptCount,"2");
    for (const field of ["nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash"]) {
      assert.equal(firstBroadcast.attempt[field],signed.attempt[field]);
    }
    assert.equal(observer.calls.filter(call => call.method === "eth_estimateGas").length,estimatesBefore);
    assert.equal(observer.calls.filter(call => call.method === "eth_maxPriorityFeePerGas").length,feesBefore);
    assert.deepEqual(await run(MANAGER,["read",firstId]),firstBroadcast);
    assert.equal(await metricValue("delivery_retries_total", { labels: { kind: "exact_rebroadcast" } }), retryBefore + 1);
    console.log("VALID: actual same-candidate retry through two endpoints increments exact_rebroadcast once; independent readback adds zero");
    assert.equal(primary.calls.filter(call => call.method === "eth_sendRawTransaction")[0].params[0],signed.attempt.rawSignedTransaction);
    assert.equal(secondary.calls.filter(call => call.method === "eth_sendRawTransaction")[0].params[0],signed.attempt.rawSignedTransaction);
    console.log("VALID: persistent retry recovered one failed SIGNED submission and rebroadcast identical bytes/hash without gas, fees, signing or nonce allocation");
    const replaced = await verifyPendingReplacement({ config: loadTransactionConfig(env),pool,queue,legacy: repository,destination,
      jobId: jobs[1].deliveryJobId,run: args => run(MANAGER,args),onReplacementPrepared: async () => { primary.state.available = false; },
      prepareAndBroadcast: () => verifySignedTakeover({ processes,pool,config: relayConfig,manager,id: jobs[1].deliveryJobId }) });
    assert.ok(secondary.calls.some(call => call.method === "eth_sendRawTransaction" && call.params[0] === replaced.attempt.rawSignedTransaction));
    assert.equal(replaced.attempts.length,2);
    primary.state.available = true;
    const secondaryBeforeRecovery = secondary.calls.length;
    await manager.verifyChain();
    assert.equal(secondary.calls.length,secondaryBeforeRecovery,"a recovered primary is preferred for the next independent operation");
    primary.setFault("eth_estimateGas","unavailable");
    primary.setFault("eth_maxPriorityFeePerGas","unavailable");
    primary.setFault("eth_getTransactionCount","unavailable",{ when: request => request.params[1] === "pending" });
    await verifyConcurrentRelayers({ processes,pool,config: relayConfig,manager,jobs: jobs.slice(2) });
    assert.equal(await count(intents),expectedCount); assert.equal(await count(attempts),expectedCount + 1);
    assert.equal(await count(submissions),0);
    assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
    for (const job of jobs) {
      const pack = await queue.getDeliveryPackage(job.deliveryJobId);
      const encoded = await encodeGatewaySubmission(pack,{ validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
      const record = await manager.repository.getTransaction(job.deliveryJobId);
      const tx = await destination.request({ method: "eth_getTransactionByHash",params: [record.attempt.transactionHash] });
      assert.ok(tx,"Chain B RPC must expose the submitted transaction body");
      assert.equal(normalizeAddress(tx.from),relayConfig.relayerAddress);
      assert.equal(normalizeAddress(tx.to),pack.message.destinationGateway);
      assert.notEqual(normalizeAddress(tx.to),pack.message.destinationReceiver);
      assert.equal(BigInt(tx.value),0n);
      assert.equal(tx.input.toLowerCase(),encoded.calldata.toLowerCase());
      assert.equal(record.intent.packageDigest,encoded.packageDigest);
      assert.equal(BigInt(tx.nonce).toString(),record.attempt.nonce); assert.equal(BigInt(tx.type),2n);
      assert.equal(BigInt(tx.chainId),relayConfig.destinationDomain);
      assert.equal(BigInt(tx.gas).toString(),record.attempt.gasLimit);
      assert.equal(BigInt(tx.maxFeePerGas).toString(),record.attempt.maxFeePerGas);
      assert.equal(BigInt(tx.maxPriorityFeePerGas).toString(),record.attempt.maxPriorityFeePerGas);
      assert.equal(keccak256(record.attempt.rawSignedTransaction),record.attempt.transactionHash);
      const snapshot = snapshots.find((snapshot) => snapshot.record.batchId === pack.batchId);
      assert.ok(snapshot); assert.equal(pack.validatorEpoch,snapshot.quorumCertificate.validatorEpoch ?? null);
      assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
      console.log(`VALID: Chain B exposed exact persisted type-2 delivery for ${job.deliveryJobId}; nonce=${record.attempt.nonce}; hash=${record.attempt.transactionHash}`);
    }
    assert.equal(observed.length,expectedCount + 1);
    assert.deepEqual([...new Set(observed.map(record => record.nonce))].map(BigInt).sort((a,b) => a < b ? -1 : 1),
      Array.from({ length: expectedCount },(_,index) => destinationNonce + BigInt(index)));
    assert.equal(observer.calls.filter(call => call.method === "eth_estimateGas").length,expectedCount);
    assert.equal(observer.calls.filter(call => call.method === "eth_maxPriorityFeePerGas").length,expectedCount + 1);
    assert.equal(observer.calls.filter(call => call.method === "eth_sendTransaction").length,0);
    console.log("VALID: independent RPC observer proved signed persistence before every real raw broadcast; intents reserved consecutive unique nonces and replacement reused its parent's nonce");
    const last = await manager.repository.getTransaction(jobs.at(-1).deliveryJobId);
    if (await destination.request({ method: "eth_getTransactionReceipt",params: [last.attempt.transactionHash] }) === null) {
      await destination.request({ method: "anvil_mine",params: ["0x1"] });
    }
    primary.state.available = false;
    const secondaryReceiptsBefore = secondary.calls.filter(call => call.method === "eth_getTransactionReceipt").length;
    const firstReceiptCheck = await run(MANAGER,["receipts"]);
    if (relayConfig.destinationConfirmations > 1n) {
      assert.ok(firstReceiptCheck.results.some(record => record.attempt.status === "BROADCAST"));
      // Mining is a verification-only operation, never a production manager action.
      await destination.request({ method: "anvil_mine",params: [toHex(relayConfig.destinationConfirmations - 1n)] });
    }
    await run(MANAGER,["receipts"]);
    assert.ok(secondary.calls.filter(call => call.method === "eth_getTransactionReceipt").length > secondaryReceiptsBefore);
    primary.state.available = true;
    for (const job of jobs) {
      const record = await manager.repository.getTransaction(job.deliveryJobId);
      assert.equal(record.attempt.status,"CONFIRMED"); assert.equal(record.attempt.receiptStatus,1);
      assert.ok(BigInt(record.attempt.confirmedHead) - BigInt(record.attempt.receiptBlockNumber) + 1n >= relayConfig.destinationConfirmations);
      const canonical = await destination.request({ method: "eth_getBlockByNumber",params: [toHex(BigInt(record.attempt.receiptBlockNumber)),false] });
      assert.equal(canonical.hash.toLowerCase(),record.attempt.receiptBlockHash);
    }
    const hashesBefore = (await pool.query(`SELECT delivery_job_id,nonce,raw_signed_transaction,transaction_hash FROM ${attempts} ORDER BY delivery_job_id,attempt_number`)).rows;
    const accountBefore = await manager.repository.getAccount();
    assert.equal(accountBefore.nextNonce,(destinationNonce + BigInt(expectedCount)).toString());
    const repeated = await run();
    assert.equal(repeated.selected,0); assert.equal(repeated.submitted,0);
    assert.equal(await count(intents),expectedCount); assert.equal(await count(attempts),expectedCount + 1);
    assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
    assert.deepEqual((await pool.query(`SELECT delivery_job_id,nonce,raw_signed_transaction,transaction_hash FROM ${attempts} ORDER BY delivery_job_id,attempt_number`)).rows,hashesBefore);
    assert.deepEqual(await manager.repository.getAccount(),accountBefore); assert.equal(observed.length,expectedCount + 1);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queueState(),queueBefore);
    assert.equal(observer.errors.length,0);
    assert.equal(primary.errors.length,0); assert.equal(secondary.errors.length,0);
    console.log("VALID: two independently controlled access paths reached the same real Chain B; response loss, all-down persistence, pre-signing reads, replacement, receipt failover and primary recovery preserved transaction identity");
    console.log("VALID: canonical real receipts reached configured depth; fresh Relayer and Transaction Manager processes preserved exact attempts and nonce allocation");
    console.log("VALID: immutable READY/source/consensus/historical QC evidence survived transport; CONFIRMED is transaction inclusion, not Gateway authentication or Application B execution");
    // The normal observer is intentionally bound to the original schema. Crash
    // scenarios use their own committed journal checks against an isolated fixture.
    await processes.close();
    await verifyTransactionCrashes({ environment: { ...env,CHAIN_B_RPC_URLS: JSON.stringify([primary.url,secondary.url]) },
      sourceConfig: config,sourcePool: pool,snapshot: snapshots[0],destination,upstream: process.env.CHAIN_B_RPC_URL });
    await verifyTransientRpcFailures({ environment: env,sourceConfig: config,sourcePool: pool,
      snapshot: snapshots[0],destination,upstream: process.env.CHAIN_B_RPC_URL });
  } catch (error) {
    failedRun = true;
    for (const failure of observer.errors) console.error(`Transaction RPC observation failed: ${failure.message}`);
    for (const failure of [...primary.errors,...secondary.errors]) console.error(`Destination access path failed: ${failure.message}`);
    throw error;
  } finally {
    try {
      const workers = await Promise.allSettled([processes?.close()]);
      const paths = await Promise.allSettled([primary.close(),secondary.close()]);
      const observations = await Promise.allSettled([observer.close()]);
      const failure = [...workers,...paths,...observations].find(result => result.status === "rejected");
      if (failure) throw failure.reason;
    }
    catch (error) { if (!failedRun) throw error; console.error(`Transaction RPC observer cleanup also failed: ${error.message}`); }
  }
}
