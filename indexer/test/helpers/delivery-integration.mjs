import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { tableName } from "../../src/db.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { deliveryJson, verifyDeliveryPackage } from "../../src/delivery/package.mjs";
import { sourceState } from "../../../validator/test/helpers/four-process.mjs";

const execFileAsync = promisify(execFile);
const HELPER = fileURLToPath(new URL("./read-delivery.mjs",import.meta.url));

export async function verifyDeliveryQueue({ config,pool,snapshots,validatorSets,orphanMessageIds = [] }) {
  const queueConfig = { ...config,validatorSets };
  const original = await sourceState(pool,config.databaseSchema);
  const env = { ...process.env,DATABASE_URL: config.databaseUrl,INDEXER_DB_SCHEMA: config.databaseSchema,
    CHAIN_A_DOMAIN: config.chainDomain.toString(),SOURCE_GATEWAY_ADDRESS: config.sourceGateway,
    VALIDATOR_SET_HISTORY_FILE: "",VALIDATOR_SET_HISTORY: deliveryJson(validatorSets.history) };
  const projector = createDeliveryProjector({ config: queueConfig,pool });
  const repository = createDeliveryRepository({ config: queueConfig,pool });
  const jobTable = tableName(config.databaseSchema,"delivery_jobs");
  const batchTable = tableName(config.databaseSchema,"delivery_batches");
  async function counts() {
    return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${batchTable})::int AS batches,
      (SELECT COUNT(*) FROM ${jobTable})::int AS jobs`)).rows[0];
  }
  async function run(action,id) {
    const result = await execFileAsync(process.execPath,[HELPER,action,...(id ? [id] : [])],{ env });
    process.stderr.write(result.stderr);
    return JSON.parse(result.stdout);
  }
  async function interruption(action,id,expected) {
    await assert.rejects(execFileAsync(process.execPath,[HELPER,action,id],{ env }), (error) => {
      process.stdout.write(error.stdout ?? ""); process.stderr.write(error.stderr ?? "");
      return error.code === 1 && (error.stderr ?? "").includes(expected);
    });
  }
  assert.deepEqual(await counts(),{ batches: 0,jobs: 0 });
  for (const row of original.message_batches.filter((row) => row.status !== "COMMITTED")) {
    await assert.rejects(projector.materializeBatch({ batchRecordId: row.batch_record_id }),{ code: "DELIVERY_REQUIRES_COMMITTED" });
  }
  const first = snapshots[0];
  await interruption("interrupt-before-commit",first.record.batchRecordId,"expected delivery interruption before commit");
  assert.deepEqual(await counts(),{ batches: 0,jobs: 0 });
  console.log("VALID: fresh delivery worker interruption after its first insert rolled back the complete projection");
  await interruption("interrupt-after-commit",first.record.batchRecordId,"expected delivery interruption after durable commit before reporting");
  assert.deepEqual(await counts(),{ batches: 1,jobs: first.members.length });
  const firstJobs = await repository.listReadyDeliveryJobs();
  const oldPackages = await Promise.all(firstJobs.map((job) => repository.getDeliveryPackage(job.deliveryJobId)));
  const results = await Promise.all([run("project"),run("project")]);
  const expectedCount = snapshots.reduce((count,snapshot) => count + snapshot.members.length,0);
  assert.equal(results.reduce((sum,result) => sum + result.projection.createdJobs,0),expectedCount - first.members.length);
  assert.deepEqual(await counts(),{ batches: snapshots.length,jobs: expectedCount });
  const recovered = await run("read");
  const jobs = await repository.listReadyDeliveryJobs();
  assert.deepEqual(recovered.jobs,jobs);
  assert.equal(jobs.length,expectedCount);
  const expectedIds = snapshots.flatMap((snapshot) => snapshot.members.map((member) => member.messageId));
  assert.deepEqual(jobs.map((job) => job.messageId),expectedIds);
  assert.ok(jobs.every((job) => !orphanMessageIds.includes(job.messageId) && job.status === "READY"));
  for (const pack of recovered.packages) {
    await verifyDeliveryPackage(pack,{ validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
    const snapshot = snapshots.find((snapshot) => snapshot.record.batchId === pack.batchId);
    assert.ok(snapshot);
    assert.equal(pack.message.messageId,snapshot.members[pack.messageIndex].messageId);
    assert.equal(BigInt(pack.messageIndex),snapshot.members[pack.messageIndex].position);
    assert.equal(pack.messageRoot,snapshot.tree.messageRoot);
    assert.deepEqual(pack.merkleProof.siblings,snapshot.tree.proofs[pack.messageIndex].siblings);
    assert.deepEqual(pack.quorumCertificate,snapshot.quorumCertificate);
    assert.equal(pack.validatorEpoch,snapshot.quorumCertificate.validatorEpoch ?? null);
    assert.equal(pack.committeeDigest,snapshot.quorumCertificate.committeeDigest);
  }
  for (const pack of oldPackages) assert.deepEqual(await repository.getDeliveryPackage(pack.deliveryJobId),pack);
  const repeated = await run("project");
  assert.deepEqual(repeated.projection,{ materializedBatches: 0,createdJobs: 0 });
  assert.deepEqual(repeated.jobs,jobs);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),original);
  console.log("VALID: concurrent fresh delivery projectors preserved one canonical READY job per real sealed position");
  console.log("VALID: fresh process recovered complete message/proof/QC packages; REORGED C excluded and source persistence unchanged");
  console.log("VALID: report loss after durable commit caused no duplicates; old queued packages retained historical committee evidence");
}
