import assert from "node:assert/strict";
import { loadValidatorConfig } from "../src/config.mjs";
import { createValidatorPool,createValidatorStore } from "../src/db.mjs";
import { deterministicPrimary } from "../src/committee.mjs";
import { expectedCommitStatement } from "../src/quorum-certificate.mjs";
import { prepareDigest } from "../src/prepare.mjs";
import { commitDigest } from "../src/commit.mjs";
import { broadcastPrepare } from "../src/prepare-service.mjs";
import { broadcastCommit } from "../src/commit-service.mjs";
import { tableName } from "../../indexer/src/db.mjs";
import { serveLocalRpc } from "../../indexer/scripts/local/ipc.mjs";
import { safeError } from "../../indexer/scripts/local/tools.mjs";
import { signAdversarialEvidence } from "./lib/adversarial-evidence.mjs";

// No HTTP controls or production entrypoint changes. The production validator
// runs in this same OS process; only its owning supervisor can arm this wrapper.
let armed;
let pool;
let config;
let store;
let initialize;
const initialized = new Promise((resolve,reject) => { initialize = { resolve,reject }; });
// Initialization errors are also reported by the entrypoint below.
initialized.catch(() => {});
async function ownVotes(epoch) {
  for (const name of ["pbft_prepare_votes","pbft_commit_votes"]) {
    const count = (await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(config.databaseSchema,name)}
      WHERE epoch = $1 AND voter_identity = $2`,[epoch,config.validatorAddress])).rows[0].count;
    assert.equal(count,0,"fault target must have no canonical own votes in this epoch");
  }
}
let emitting = false;
serveLocalRpc({
  async status() {
    await initialized;
    return { pid: process.pid,address: config.validatorAddress,schema: config.databaseSchema,armed: armed?.epoch ?? null };
  },
  async arm(target) {
    await initialized;
    assert.equal(armed,undefined,"validator is already armed");
    const row = (await pool.query(`SELECT * FROM ${tableName(config.sourceDatabaseSchema,"message_batches")}
      WHERE batch_id = $1 AND source_domain = $2 AND source_gateway = $3`,[target.batchId,String(config.chainDomain),config.sourceGateway])).rows[0];
    assert.ok(row); assert.equal(row.status,"SEALED"); assert.equal(row.epoch,target.epoch); assert.equal(row.message_root,target.messageRoot);
    const set = config.validatorSets.resolveForBatchEpoch(target.epoch);
    assert.notEqual(deterministicPrimary(set.validators,target.epoch,"0"),config.validatorAddress);
    await ownVotes(target.epoch);
    armed = { ...target,sent: [] };
    return { pid: process.pid,address: config.validatorAddress,epoch: armed.epoch };
  },
  async emit({ phase }) {
    await initialized;
    assert.ok(armed,"fault injection is unarmed");
    assert.equal(emitting,false,"fault emission is already running");
    assert.ok(["PREPARE","COMMIT"].includes(phase));
    assert.deepEqual(armed.sent,phase === "PREPARE" ? [] : ["PREPARE"]);
    emitting = true;
    try {
      await ownVotes(armed.epoch);
      const accepted = await store.readPrePrepare(armed.epoch,"0");
      assert.ok(accepted,"canonical proposal must be accepted before injecting a conflict");
      const proposal = accepted.envelope;
      assert.equal(proposal.batchId,armed.batchId); assert.equal(proposal.messageRoot,armed.messageRoot);
      const messageRoot = `0x${(BigInt(armed.messageRoot) ^ 1n).toString(16).padStart(64,"0")}`;
      const statement = expectedCommitStatement({ ...proposal,messageRoot,proposalDigest: undefined },config);
      const envelope = await signAdversarialEvidence(config.privateKey,config.validatorAddress,
        { messageType: phase,...statement,voterIdentity: config.validatorAddress },phase === "PREPARE" ? prepareDigest : commitDigest);
      const deliveries = await (phase === "PREPARE" ? broadcastPrepare : broadcastCommit)(config,envelope);
      armed.sent.push(phase);
      return { pid: process.pid,address: config.validatorAddress,envelope,deliveries };
    } finally { emitting = false; }
  },
  async disarm() { assert.equal(emitting,false); armed = undefined; return { disarmed: true }; },
});

try {
  await import("../src/main.mjs");
  if (process.exitCode) throw new Error("Local validator production startup failed");
  config = { ...loadValidatorConfig(),allowHistorical: true };
  pool = createValidatorPool(config);
  pool.options.connectionTimeoutMillis = 10000; pool.options.query_timeout = 10000;
  store = createValidatorStore({ pool,config });
  initialize.resolve();
  for (const signal of ["SIGINT","SIGTERM"]) process.once(signal,() => {
    pool.end().catch(() => { process.exitCode = 1; });
    if (process.connected) process.disconnect();
  });
} catch (error) {
  initialize.reject(error); console.error(safeError(error)); process.exitCode = 1;
  await pool?.end(); if (process.connected) process.disconnect();
}
