import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, keccak256, toHex } from "viem";
import { normalizeAddress } from "../../src/canonical-message.mjs";
import { tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { encodeDestinationSubmission } from "../../src/relayer/encoding.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";
import { rpcObserver } from "../../../validator/test/helpers/process-cluster.mjs";

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
    const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(job.deliveryJobId),{ validatorSets });
    packagesByData.set(encoded.data,encoded.package);
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
    assert.equal(row.status,"SIGNED"); assert.equal(row.raw_signed_transaction,raw); assert.equal(row.transaction_hash,hash);
    const stored = await manager.repository.getTransaction(row.delivery_job_id);
    assert.equal(stored.attempt.rawSignedTransaction,raw); assert.equal(stored.attempt.transactionType,2);
    assert.ok(BigInt(stored.attempt.gasLimit) > 0n);
    assert.equal(BigInt(stored.attempt.gasLimit),estimates.get(stored.intent.calldata));
    assert.equal(BigInt(stored.attempt.maxPriorityFeePerGas),latestPriorityFee);
    assert.equal(BigInt(stored.attempt.maxFeePerGas),2n * latestBaseFee + latestPriorityFee);
    observed.push({ deliveryJobId: row.delivery_job_id,transactionHash: hash,nonce: stored.attempt.nonce });
  },async afterForward(request,reply) {
    if (request.method === "eth_estimateGas") estimates.set(request.params[0].data,BigInt(reply.result));
    if (request.method === "eth_maxPriorityFeePerGas") latestPriorityFee = BigInt(reply.result);
    if (request.method === "eth_getBlockByNumber" && request.params[0] === "latest") latestBaseFee = BigInt(reply.result.baseFeePerGas);
    if (request.method === "eth_sendRawTransaction") assert.equal(reply.result.toLowerCase(),keccak256(request.params[0]).toLowerCase());
  } });
  env.CHAIN_B_RPC_URL = observer.url;
  manager = createTransactionManager({ config: loadTransactionConfig(env),pool,queue,legacy: repository });
  try {
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
    await failed(MAIN,{ ...env,CHAIN_B_RPC_URL: config.chainRpcUrl },"CHAIN_ID_MISMATCH");
    assert.equal(await nonce(source),sourceNonce); assert.equal(await nonce(destination),destinationNonce);
    assert.equal(await count(intents),0); assert.equal(await count(attempts),0);
    await failed(FAILURE,env,"expected injected Relayer RPC submission failure");
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
    await failed(MAIN,env,"SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
    assert.equal(await count(attempts),1); assert.equal(await nonce(destination),destinationNonce); assert.equal(observed.length,0);
    const firstBroadcast = await run(MANAGER,["broadcast",firstId]);
    assert.equal(firstBroadcast.attempt.status,"BROADCAST");
    for (const field of ["nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash"]) {
      assert.equal(firstBroadcast.attempt[field],signed.attempt[field]);
    }
    assert.equal(observer.calls.filter(call => call.method === "eth_estimateGas").length,estimatesBefore);
    assert.equal(observer.calls.filter(call => call.method === "eth_maxPriorityFeePerGas").length,feesBefore);
    assert.deepEqual(await run(MANAGER,["read",firstId]),{ intent: firstBroadcast.intent,attempt: firstBroadcast.attempt });
    const submitted = await run();
    assert.equal(submitted.selected,expectedCount - 1); assert.equal(submitted.submitted,expectedCount - 1);
    assert.equal(await count(intents),expectedCount); assert.equal(await count(attempts),expectedCount);
    assert.equal(await count(submissions),0);
    assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
    for (const job of jobs) {
      const pack = await queue.getDeliveryPackage(job.deliveryJobId);
      const encoded = await encodeDestinationSubmission(pack,{ validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
      const record = await manager.repository.getTransaction(job.deliveryJobId);
      const tx = await destination.request({ method: "eth_getTransactionByHash",params: [record.attempt.transactionHash] });
      assert.ok(tx,"Chain B RPC must expose the submitted transaction body");
      assert.equal(normalizeAddress(tx.from),relayConfig.relayerAddress);
      assert.equal(normalizeAddress(tx.to),pack.message.destinationGateway);
      assert.notEqual(normalizeAddress(tx.to),pack.message.destinationReceiver);
      assert.equal(BigInt(tx.value),0n);
      assert.equal(tx.input.toLowerCase(),encoded.data.toLowerCase());
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
    assert.equal(observed.length,expectedCount);
    assert.deepEqual(observed.map(record => BigInt(record.nonce)).sort((a,b) => a < b ? -1 : 1),
      Array.from({ length: expectedCount },(_,index) => destinationNonce + BigInt(index)));
    assert.equal(observer.calls.filter(call => call.method === "eth_estimateGas").length,expectedCount);
    assert.equal(observer.calls.filter(call => call.method === "eth_maxPriorityFeePerGas").length,expectedCount);
    assert.equal(observer.calls.filter(call => call.method === "eth_sendTransaction").length,0);
    console.log("VALID: independent RPC observer proved SIGNED persistence before every real raw broadcast; nonces were unique and consecutive");
    const firstReceiptCheck = await run(MANAGER,["receipts"]);
    if (relayConfig.destinationConfirmations > 1n) {
      assert.ok(firstReceiptCheck.results.some(record => record.attempt.status === "BROADCAST"));
      // Mining is a verification-only operation, never a production manager action.
      await destination.request({ method: "anvil_mine",params: [toHex(relayConfig.destinationConfirmations - 1n)] });
    }
    await run(MANAGER,["receipts"]);
    for (const job of jobs) {
      const record = await manager.repository.getTransaction(job.deliveryJobId);
      assert.equal(record.attempt.status,"CONFIRMED"); assert.equal(record.attempt.receiptStatus,1);
      assert.ok(BigInt(record.attempt.confirmedHead) - BigInt(record.attempt.receiptBlockNumber) + 1n >= relayConfig.destinationConfirmations);
      const canonical = await destination.request({ method: "eth_getBlockByNumber",params: [toHex(BigInt(record.attempt.receiptBlockNumber)),false] });
      assert.equal(canonical.hash.toLowerCase(),record.attempt.receiptBlockHash);
    }
    const hashesBefore = (await pool.query(`SELECT delivery_job_id,nonce,raw_signed_transaction,transaction_hash FROM ${attempts} ORDER BY delivery_job_id`)).rows;
    const accountBefore = await manager.repository.getAccount();
    assert.equal(accountBefore.nextNonce,(destinationNonce + BigInt(expectedCount)).toString());
    const repeated = await run();
    assert.equal(repeated.selected,0); assert.equal(repeated.submitted,0);
    assert.equal(await count(intents),expectedCount); assert.equal(await count(attempts),expectedCount);
    assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
    assert.deepEqual((await pool.query(`SELECT delivery_job_id,nonce,raw_signed_transaction,transaction_hash FROM ${attempts} ORDER BY delivery_job_id`)).rows,hashesBefore);
    assert.deepEqual(await manager.repository.getAccount(),accountBefore); assert.equal(observed.length,expectedCount);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queueState(),queueBefore);
    assert.equal(observer.errors.length,0);
    console.log("VALID: canonical real receipts reached configured depth; fresh Relayer and Transaction Manager processes preserved exact attempts and nonce allocation");
    console.log("VALID: immutable READY/source/consensus/historical QC evidence survived transport; CONFIRMED is transaction inclusion, not Gateway authentication or Application B execution");
  } catch (error) {
    failedRun = true;
    for (const failure of observer.errors) console.error(`Transaction RPC observation failed: ${failure.message}`);
    throw error;
  } finally {
    try { await observer.close(); }
    catch (error) { if (!failedRun) throw error; console.error(`Transaction RPC observer cleanup also failed: ${error.message}`); }
  }
}
