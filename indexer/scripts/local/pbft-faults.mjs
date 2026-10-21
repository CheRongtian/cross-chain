import assert from "node:assert/strict";
import { tableName } from "../../src/db.mjs";
import { canonicalCommittee } from "../../../validator/src/committee.mjs";
import { createValidatorSetResolver } from "../../../validator/src/validator-sets.mjs";
import { authenticatePrepare } from "../../../validator/src/prepare.mjs";
import { authenticateCommit } from "../../../validator/src/commit.mjs";
import { expectedCommitStatement,qcDigest,verifyQuorumCertificate } from "../../../validator/src/quorum-certificate.mjs";
import { artifact,clients } from "./deployment.mjs";
import { runLocalDemo } from "./demo.mjs";
import { faultSelection } from "./pipeline.mjs";
import { httpJson,safeError } from "./tools.mjs";

export function assertConflictResponse(result,target,phase,pid) {
  assert.equal(result.pid,pid); assert.equal(result.address,target.target);
  const vote = result.envelope;
  assert.equal(vote.messageType,phase); assert.equal(vote.voterIdentity,target.target);
  for (const field of ["protocolVersion","sourceDomain","sourceGateway","epoch","view","validatorEpoch","committeeDigest","batchId"]) {
    assert.equal(vote[field],target[field]);
  }
  assert.equal(vote.messageRoot,`0x${(BigInt(target.messageRoot) ^ 1n).toString(16).padStart(64,"0")}`);
  assert.notEqual(vote.messageRoot,target.messageRoot);
  assert.deepEqual(result.deliveries.map(value => value.peerAddress).sort(),[...target.honest].sort());
  for (const delivery of result.deliveries) {
    assert.equal(delivery.delivery,"DELIVERED"); assert.equal(delivery.result,"REJECTED"); assert.equal(delivery.reason,"WRONG_ROOT");
  }
}

export function assertOwnedValidator({ record,observedIdentity,registered,published,health,address }) {
  assert.ok(record.identity); assert.equal(observedIdentity,record.identity,"owned validator OS identity changed");
  assert.deepEqual(registered,record); assert.equal(published.pid,record.pid); assert.equal(published.name,record.name);
  assert.equal(health.pid,record.pid); assert.equal(health.validatorAddress,address); assert.equal(health.ready,true);
}

async function reject(peer,path,body,reason) {
  const response = await fetch(peer.url + path,{ method: "POST",headers: { "content-type": "application/json" },
    body: JSON.stringify(body),signal: AbortSignal.timeout(10000) });
  const result = await response.json();
  assert.equal(response.status,422); assert.equal(result.validatorAddress,peer.address);
  assert.equal(result.result,"REJECTED"); assert.equal(result.reason,reason);
}

// Capture only immutable authority/journal fields; leases and scrape state are
// intentionally not protocol history. Every query below is read-only.
async function historyReader(config,pool) {
  const t = name => tableName(config.schema,name);
  const ids = (await pool.query(`SELECT batch_record_id FROM ${t("message_batches")} WHERE status = 'COMMITTED' ORDER BY epoch`)).rows.map(row => row.batch_record_id);
  return async () => {
    const result = {};
    for (const [name,columns,order] of [
      ["message_batches","batch_record_id,epoch,batch_id,message_root,status","epoch"],
      ["message_batch_members","*","batch_record_id,canonical_position"],
      ["batch_quorum_certificates","*","batch_record_id"],
      ["batch_quorum_certificate_signatures","*","batch_record_id,voter_identity"],
      ["delivery_batches","*","batch_record_id"],
      ["delivery_jobs","delivery_job_id,batch_record_id,message_id,status","delivery_job_id"],
    ]) result[name] = (await pool.query(`SELECT ${columns} FROM ${t(name)} WHERE batch_record_id = ANY($1) ORDER BY ${order}`,[ids])).rows;
    const jobs = result.delivery_jobs.map(row => row.delivery_job_id);
    const messages = result.delivery_jobs.map(row => row.message_id);
    result.source_messages = (await pool.query(`SELECT id,message_id,source_tx_hash,source_block_hash,source_block_number,source_log_index,status
      FROM ${t("source_messages")} WHERE message_id = ANY($1) ORDER BY id`,[messages])).rows;
    for (const [name,columns,order] of [
      ["transaction_intents","delivery_job_id,status,winning_attempt_id,calldata","delivery_job_id"],
      ["transaction_attempts","attempt_id,delivery_job_id,transaction_hash,raw_signed_transaction,nonce,broadcast_at,receipt_block_hash","attempt_id"],
    ]) result[name] = (await pool.query(`SELECT ${columns} FROM ${t(name)} WHERE delivery_job_id = ANY($1) ORDER BY ${order}`,[jobs])).rows;
    const batches = result.message_batches.map(row => row.batch_id);
    for (const schema of config.validatorSchemas) for (const name of ["pbft_pre_prepares","pbft_prepare_votes","pbft_prepared_states","pbft_commit_votes","pbft_commit_quorums"]) {
      result[schema + "." + name] = (await pool.query(`SELECT * FROM ${tableName(schema,name)} WHERE batch_id = ANY($1)
        ORDER BY epoch,view${name.endsWith("_votes") ? ",voter_identity" : ""}`,[batches])).rows;
    }
    return result;
  };
}

export async function runFaultDemo({ config,pool,scenario,pipeline,processes,progress,alive,...options }) {
  assert.ok(["byzantine-validator","validator-crash"].includes(scenario));
  const protocol = { peers: config.peers,validatorSets: createValidatorSetResolver(config.history),chainDomain: 10011n,sourceGateway: config.deployments.sourceGateway };
  const t = name => tableName(config.schema,name);
  let target; let index; let certificate; let faultPid; let restored = false; let armed = false; let paused = false; let crashed = false;
  let conflictRoot;
  let originalFailure;
  const readHistory = await historyReader(config,pool);
  const history = await readHistory();
  async function health(addresses) {
    for (const address of addresses) {
      const position = config.peers.findIndex(peer => peer.address === address);
      const value = await httpJson(config.peers[position].url + "/health");
      assert.equal(value.ready,true); assert.equal(value.validatorAddress,address);
      assert.equal(value.pid,processes.at(position).record.pid);
    }
  }
  async function registry() {
    const value = await clients(config.chainB,2001).publicClient.readContract({ address: config.deployments.validatorRegistry,
      abi: (await artifact("ValidatorSetRegistry")).abi,functionName: "getValidatorSet",args: [BigInt(target.validatorEpoch)] });
    assert.deepEqual(canonicalCommittee(value[0]),canonicalCommittee(config.peers));
    assert.equal(Number(value[1]),3); assert.equal(value[2],target.committeeDigest);
    return value;
  }
  async function ownZero() {
    for (const schema of config.validatorSchemas) for (const name of ["pbft_prepare_votes","pbft_commit_votes"]) {
      assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(schema,name)} WHERE epoch = $1 AND voter_identity = $2`,[target.epoch,target.target])).rows[0].count,0,
        "fault target must never acquire a canonical historical vote");
    }
  }
  async function durable({ prepared = false,committed = false } = {}) {
    const scope = [target.sourceDomain,target.sourceGateway,target.epoch];
    const batches = (await pool.query(`SELECT batch_id,message_root,status FROM ${t("message_batches")}
      WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`,scope)).rows;
    assert.deepEqual(batches,[{ batch_id: target.batchId,message_root: target.messageRoot,status: committed ? "COMMITTED" : "CONSENSUS_PENDING" }]);
    const qcs = (await pool.query(`SELECT batch_id,message_root,qc_digest,view FROM ${t("batch_quorum_certificates")}
      WHERE source_domain = $1 AND source_gateway = $2 AND epoch = $3`,scope)).rows;
    assert.deepEqual(qcs,committed ? [{ batch_id: target.batchId,message_root: target.messageRoot,qc_digest: certificate.qcDigest,view: "0" }] : []);
    const projected = (await pool.query(`SELECT batch_id,message_root,qc_digest FROM ${t("delivery_batches")}
      WHERE source_domain = $1 AND source_gateway = $2 AND batch_epoch = $3`,scope)).rows;
    assert.deepEqual(projected,committed ? [{ batch_id: target.batchId,message_root: target.messageRoot,qc_digest: certificate.qcDigest }] : []);
    const jobs = (await pool.query(`SELECT j.message_id,j.status FROM ${t("delivery_jobs")} j JOIN ${t("message_batches")} b USING (batch_record_id)
      WHERE b.source_domain = $1 AND b.source_gateway = $2 AND b.epoch = $3`,scope)).rows;
    assert.equal(jobs.length,committed ? 1 : 0);
    for (const job of jobs) { assert.equal(job.message_id,target.messageId); assert.equal(job.status,"READY"); }
    for (const [position,schema] of config.validatorSchemas.entries()) {
      // Scan the entire protected epoch, without pre-filtering the expected root.
      const references = (await pool.query(["pbft_epoch_views","pbft_pre_prepares","pbft_prepare_votes","pbft_prepared_states","pbft_commit_votes","pbft_commit_quorums"].map(name =>
        `SELECT batch_id,message_root,protocol_version,validator_epoch,committee_digest,${name === "pbft_epoch_views" ? "current_view" : "view"} AS view
        FROM ${tableName(schema,name)} WHERE local_validator_identity = $1 AND epoch = $2`).join(" UNION ALL "),[config.peers[position].address,target.epoch])).rows;
      for (const row of references) assert.deepEqual(row,{ batch_id: target.batchId,message_root: target.messageRoot,protocol_version: 3,
        validator_epoch: target.validatorEpoch,committee_digest: target.committeeDigest,view: "0" });
      const offlineStore = scenario === "validator-crash" && position === index;
      for (const [name,expected] of [["pbft_prepare_votes",prepared ? target.honest : []],["pbft_commit_votes",committed ? target.honest : []]]) {
        const votes = (await pool.query(`SELECT voter_identity FROM ${tableName(schema,name)} WHERE epoch = $1 ORDER BY voter_identity`,[target.epoch])).rows.map(row => row.voter_identity);
        assert.deepEqual(votes,offlineStore ? [] : [...expected].sort());
      }
      for (const [name,expected] of [["pbft_prepared_states",prepared],["pbft_commit_quorums",committed]]) {
        const count = (await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(schema,name)} WHERE epoch = $1`,[target.epoch])).rows[0].count;
        assert.equal(count,expected && !offlineStore ? 1 : 0);
      }
    }
    await ownZero();
  }
  async function inject(phase) {
    const result = await processes.at(index).rpc("emit",{ phase });
    assertConflictResponse(result,target,phase,faultPid);
    const vote = result.envelope;
    assert.deepEqual(await (phase === "PREPARE" ? authenticatePrepare : authenticateCommit)(protocol,vote),vote);
    conflictRoot = vote.messageRoot;
    for (const peer of config.peers.filter(peer => target.honest.includes(peer.address))) {
      const name = phase === "PREPARE" ? "prepare_rejections" : "commit_rejections";
      const digest = phase === "PREPARE" ? "prepare_digest" : "commit_digest";
      const schema = config.validatorSchemas[config.peers.indexOf(peer)];
      assert.ok((await pool.query(`SELECT 1 FROM ${tableName(schema,name)} WHERE epoch = $1 AND voter_identity = $2 AND ${digest} = $3 AND reason = 'WRONG_ROOT'`,
        [target.epoch,target.target,vote[phase === "PREPARE" ? "prepareDigest" : "commitDigest"]])).rowCount);
    }
    progress(`VALID: live validator ${target.target} pid=${faultPid} signed and sent authentic conflicting ${phase}; canonical root ${target.messageRoot}; conflict ${conflictRoot}; all three honest nodes persisted WRONG_ROOT`);
    if (phase === "COMMIT") {
      const statement = expectedCommitStatement(vote,protocol);
      const invalid = { messageType: "QUORUM_CERTIFICATE",...statement,qcDigest: qcDigest(statement),commits: [vote] };
      const primary = config.peers.find(peer => peer.address === target.primary);
      await reject(primary,"/pbft/qc/verify",invalid,"INSUFFICIENT_OR_INVALID_QC_EVIDENCE");
      await reject(primary,"/pbft/qc/submit",invalid,"WRONG_QC_MESSAGEROOT");
      progress("VALID: conflicting signer weight = 1, accepted conflicting weight = 0; production verification and submission rejected its QC");
    }
  }
  async function recover() {
    if (index === undefined || restored) return;
    if (armed) { await processes.at(index).rpc("disarm"); armed = false; }
    const pid = await processes.restore(index);
    if (crashed) assert.notEqual(pid,faultPid);
    if (target) await ownZero();
    if (certificate) {
      const result = await httpJson(config.peers[index].url + "/pbft/qc/verify",certificate);
      assert.equal(result.result,"ACCEPTED"); assert.equal(result.qcDigest,certificate.qcDigest);
    }
    await health(canonicalCommittee(config.peers));
    restored = true;
    progress(`VALID: validator ${config.peers[index].address} ready at pid=${pid}, same identity/store; four of four nodes healthy, no fabricated offline votes`);
  }
  try {
    paused = true; await pipeline("pause");
    await health(canonicalCommittee(config.peers));
    progress(`${scenario}: automatic pipeline paused before creating this independent credential/proof/message`);
    const result = await runLocalDemo({ ...options,config,pool,alive,progress,
      async afterFinalized({ messageId }) {
        const sealed = await pipeline("sealTarget",{ messageId,scenario });
        target = { ...sealed,messageId };
        assert.deepEqual(faultSelection(config.peers,target.epoch),{ primary: target.primary,target: target.target,honest: target.honest });
        index = config.peers.findIndex(peer => peer.address === target.target);
        assert.ok(index >= 0); assert.notEqual(target.target,target.primary);
        await ownZero(); await registry();
        faultPid = processes.at(index).record.pid;
        progress(`VALID: SEALED barrier for batch ${target.batchId}, epoch ${target.epoch}, view 0; primary ${target.primary}; selected first canonical non-primary ${target.target}; n=4 f=1 quorum=3`);
        if (scenario === "byzantine-validator") {
          await processes.at(index).rpc("arm",target); armed = true;
        } else {
          assert.equal(await processes.crash(index),faultPid);
          crashed = true;
          progress(`VALID: owned non-primary pid=${faultPid} terminated by SIGKILL before any target PREPARE/COMMIT vote`);
        }
        await health(target.honest);
        await pipeline("step",{ phase: "propose" });
        await durable();
        if (armed) { await inject("PREPARE"); await durable(); }
        await pipeline("step",{ phase: "prepare" });
        await durable({ prepared: true });
        if (armed) { await inject("COMMIT"); await durable({ prepared: true }); }
        certificate = await pipeline("step",{ phase: "commit" });
        assert.deepEqual(certificate.commits.map(vote => vote.voterIdentity),[...target.honest].sort());
        assert.equal(certificate.commits.length,3); assert.equal(certificate.messageRoot,target.messageRoot); assert.equal(certificate.view,"0");
        assert.deepEqual(await verifyQuorumCertificate(certificate,{ ...protocol,expected: target }),certificate);
        await durable({ prepared: true,committed: true }); await registry();
        progress(`VALID: only canonical root committed with exactly three honest PREPARE/COMMIT voters ${target.honest.join(", ")}; QC ${certificate.qcDigest}; exactly one READY job; view change not required`);
      },
      async afterConfirmed() {
        // The crashed node stays offline through the actual destination grant.
        if (scenario === "validator-crash") assert.equal(processes.at(index).child.signalCode,"SIGKILL");
        else await health([target.target]);
        await durable({ prepared: true,committed: true });
        await recover();
      },
    });
    assert.equal(result.qcDigest,certificate.qcDigest); assert.equal(result.messageRoot,target.messageRoot);
    await durable({ prepared: true,committed: true }); await registry();
    assert.deepEqual(await readHistory(),history,"prior committed authority and signed transaction history changed");
    const b = clients(config.chainB,2001).publicClient;
    for (const [address,name,eventName] of [[config.deployments.destinationGateway,"DestinationGateway","CrossChainMessageExecuted"],
      [config.deployments.applicationB,"ApplicationB","VerifiedSupplierGranted"]]) {
      assert.equal((await b.getContractEvents({ address,abi: (await artifact(name)).abi,eventName,args: { messageId: result.messageId },fromBlock: 0n,toBlock: "latest",strict: true })).length,1);
    }
    progress("VALID: canonical destination execution and business grant occurred exactly once; prior message/batch/QC/delivery/journal evidence unchanged");
    alive(); await health(canonicalCommittee(config.peers));
    if (scenario === "byzantine-validator") assert.equal(processes.at(index).record.pid,faultPid,"Byzantine process must remain alive throughout its demonstration");
    return { ...result,fault: { scenario,target: target.target,primary: target.primary,originalPid: faultPid,
      recoveredPid: processes.at(index).record.pid,canonicalRoot: target.messageRoot,conflictingRoot: conflictRoot ?? null,
      honestSigners: certificate.commits.map(vote => vote.voterIdentity),quorum: 3,committeeSize: 4,readyValidators: 4 } };
  } catch (error) { originalFailure = error; throw error; }
  finally {
    // Never reopen automatic voting while a designated member remains offline.
    try {
      await recover();
      if (paused && (index === undefined || restored)) await pipeline("resume");
    } catch (cleanupError) {
      processes.fail(cleanupError);
      if (originalFailure) throw new Error(`${safeError(originalFailure)}; local fault restoration failed: ${safeError(cleanupError)}`);
      throw cleanupError;
    }
  }
}
