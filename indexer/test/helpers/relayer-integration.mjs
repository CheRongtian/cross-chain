import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { normalizeAddress } from "../../src/canonical-message.mjs";
import { tableName } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";
import { loadRelayerConfig } from "../../src/relayer/config.mjs";
import { encodeDestinationSubmission } from "../../src/relayer/encoding.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";

const execFileAsync = promisify(execFile);
const MAIN = fileURLToPath(new URL("../../src/relayer/main.mjs",import.meta.url));
const FAILURE = fileURLToPath(new URL("./fail-relayer-rpc.mjs",import.meta.url));

export async function verifySingleRelayer({ config,pool,snapshots,validatorSets,orphanMessageIds = [] }) {
  assert.ok(process.env.RELAYER_A_PRIVATE_KEY,"verification must inject its development Relayer A signer");
  assert.ok(process.env.CHAIN_B_RPC_URL,"verification must supply its existing Chain B RPC");
  assert.ok(process.env.CHAIN_B_CHAIN_ID,"verification must supply its existing Chain B identity");
  const env = { ...process.env,DATABASE_URL: config.databaseUrl,INDEXER_DB_SCHEMA: config.databaseSchema,
    CHAIN_A_DOMAIN: config.chainDomain.toString(),SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
    VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_SET_HISTORY: deliveryJson(validatorSets.history),RELAYER_MAX_JOBS_PER_RUN: "100" };
  const relayConfig = loadRelayerConfig(env);
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
  async function queueState() {
    return {
      batches: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema,"delivery_batches")} ORDER BY batch_record_id`)).rows,
      jobs: (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema,"delivery_jobs")} ORDER BY batch_record_id,message_index`)).rows,
    };
  }
  const queueBefore = await queueState();
  const count = async () => (await pool.query(`SELECT COUNT(*)::int AS count FROM ${submissions}`)).rows[0].count;
  const nonce = async (client) => BigInt(await client.request({ method: "eth_getTransactionCount",params: [relayConfig.relayerAddress,"pending"] }));
  const destinationNonce = await nonce(destination);
  assert.equal(await count(),0);
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
  assert.equal(await count(),0);
  await failed(FAILURE,env,"expected injected Relayer RPC submission failure");
  assert.equal(await count(),0); assert.equal(await nonce(destination),destinationNonce);
  assert.deepEqual(await queueState(),queueBefore);
  console.log("VALID: wrong-chain and injected RPC submission failures produced no transaction or successful submission row");
  async function run() {
    const result = await execFileAsync(process.execPath,[MAIN],{ env });
    assert.ok(!result.stdout.includes(relayConfig.privateKey) && !result.stderr.includes(relayConfig.privateKey));
    process.stdout.write(result.stdout); process.stderr.write(result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").at(-1));
  }
  const submitted = await run();
  assert.equal(submitted.selected,expectedCount); assert.equal(submitted.submitted,expectedCount);
  assert.equal(await count(),expectedCount);
  assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
  for (const job of jobs) {
    const pack = await queue.getDeliveryPackage(job.deliveryJobId);
    const encoded = await encodeDestinationSubmission(pack,{ validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
    const record = await repository.getSubmission(job.deliveryJobId);
    const tx = await destination.request({ method: "eth_getTransactionByHash",params: [record.transactionHash] });
    assert.ok(tx,"Chain B RPC must expose the submitted transaction body");
    assert.equal(normalizeAddress(tx.from),relayConfig.relayerAddress);
    assert.equal(normalizeAddress(tx.to),pack.message.destinationGateway);
    assert.notEqual(normalizeAddress(tx.to),pack.message.destinationReceiver);
    assert.equal(BigInt(tx.value),0n);
    assert.equal(tx.input.toLowerCase(),encoded.data.toLowerCase());
    assert.equal(record.packageDigest,encoded.packageDigest);
    const snapshot = snapshots.find((snapshot) => snapshot.record.batchId === pack.batchId);
    assert.ok(snapshot); assert.equal(pack.validatorEpoch,snapshot.quorumCertificate.validatorEpoch ?? null);
    assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
    console.log(`VALID: Chain B RPC exposed exact package bytes for ${job.deliveryJobId}; hash=${record.transactionHash}`);
  }
  const hashesBefore = (await pool.query(`SELECT delivery_job_id,transaction_hash FROM ${submissions} ORDER BY delivery_job_id`)).rows;
  const repeated = await run();
  assert.equal(repeated.selected,0); assert.equal(repeated.submitted,0);
  assert.equal(await count(),expectedCount);
  assert.equal(await nonce(destination),destinationNonce + BigInt(expectedCount));
  assert.deepEqual((await pool.query(`SELECT delivery_job_id,transaction_hash FROM ${submissions} ORDER BY delivery_job_id`)).rows,hashesBefore);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
  assert.deepEqual(await queueState(),queueBefore);
  console.log("VALID: fresh Relayer A rerun produced zero duplicate transactions and preserved immutable queue/source/consensus evidence");
  console.log("VALID: historical and rotated QC evidence survived direct transport; transaction hashes imply RPC submission only, not destination execution or confirmation");
}
