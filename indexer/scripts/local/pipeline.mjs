import assert from "node:assert/strict";
import { tableName } from "../../src/db.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { httpJson } from "./tools.mjs";
import { canonicalCommittee,deterministicPrimary } from "../../../validator/src/committee.mjs";
import { consensusBinding } from "../../../validator/src/validator-sets.mjs";

export function faultSelection(peers,epoch) {
  const committee = canonicalCommittee(peers);
  const primary = deterministicPrimary(committee,epoch,"0");
  const target = committee.find(address => address !== primary);
  return { primary,target,honest: committee.filter(address => address !== target) };
}

export function acceptedDelivery(value,label,offline) {
  if (value.result !== "ACCEPTED") throw new Error(`${label}: ${value.reason ?? value.result}`);
  for (const delivery of value.deliveries ?? []) {
    if (delivery.peerAddress === offline) {
      assert.equal(delivery.delivery,"FAILED",`${label}: designated crash target unexpectedly answered`);
    } else if (delivery.delivery !== "DELIVERED" || delivery.result !== "ACCEPTED") {
      throw new Error(`${label}: live validator peer delivery failed: ${delivery.peerAddress}`);
    }
  }
  return value;
}

export function createPipelineDriver(pipeline) {
  let paused = false; let inFlight; let controlling = false;
  const controlled = operation => async argument => {
    if (!paused || inFlight || controlling) throw new Error("Pipeline must acknowledge its pause before controlled stepping");
    controlling = true;
    try { return await operation(argument); } finally { controlling = false; }
  };
  return {
    handlers: {
      async pause() { paused = true; await inFlight; return { paused: true,pid: process.pid }; },
      sealTarget: controlled(argument => pipeline.sealTarget(argument)),
      step: controlled(argument => pipeline.step(argument)),
      resume: controlled(() => { pipeline.release(); paused = false; return { resumed: true }; }),
    },
    async runOnce() {
      if (paused) return;
      if (inFlight) throw new Error("Pipeline pass is already running");
      inFlight = pipeline.runOnce();
      try { await inFlight; } finally { inFlight = undefined; }
    },
  };
}

// Drives existing production APIs. Every validator validates the source and
// signs its own vote in its own process/store; this scheduler owns no keys.
export function createLocalPipeline({ config,pool,peers }) {
  const lifecycle = createBatchLifecycle({ config,pool,committee: peers });
  const projector = createDeliveryProjector({ config,pool });
  const batches = tableName(config.databaseSchema,"message_batches");
  const cursor = tableName(config.databaseSchema,"indexer_cursors");
  let held;
  const accepted = (value,label) => acceptedDelivery(value,label,held?.scenario === "validator-crash" ? held.target : undefined);
  const post = (peer,path,body) => httpJson(peer.url + path,body);
  const peerAt = address => {
    const peer = peers.find(peer => peer.address === address);
    assert.ok(peer,"PBFT identity is outside the configured committee"); return peer;
  };
  async function nextSealed() {
    // Bound each pass. A COMMITTED predecessor is retained and the lifecycle
    // selects the next legitimate epoch, including an initially empty source.
    const pending = (await pool.query(`SELECT batch_record_id FROM ${batches}
      WHERE source_domain = $1 AND source_gateway = $2 AND status <> 'COMMITTED' ORDER BY epoch LIMIT 1`,
    [String(config.chainDomain),config.sourceGateway])).rows[0];
    let snapshot = pending ? await lifecycle.readBatch({ batchRecordId: pending.batch_record_id }) : null;
    if (!snapshot || snapshot.record.status === "BUILDING") {
      snapshot = (await lifecycle.collectEligible({ initialEpoch: "0" })).snapshot;
      if (!snapshot.members.length) return null;
      snapshot = await lifecycle.sealBatch({ batchRecordId: snapshot.record.batchRecordId });
      console.log(`Batch SEALED: ${snapshot.record.batchId}`);
    }
    return snapshot;
  }
  async function propose(snapshot) {
    if (snapshot.record.status === "SEALED") snapshot = await lifecycle.markConsensusPending({ batchRecordId: snapshot.record.batchRecordId });
    assert.equal(snapshot.record.status,"CONSENSUS_PENDING");
    const epoch = snapshot.record.epoch.toString();
    const primary = peerAt(deterministicPrimary(peers,epoch,"0"));
    const selection = await post(primary,"/pbft/primary",{ epoch,view: "0" });
    assert.equal(selection.primaryIdentity,primary.address);
    accepted(await post(primary,"/pbft/propose",{ batchId: snapshot.record.batchId }),"PRE-PREPARE");
    return snapshot;
  }
  async function cast(snapshot,phase,participants) {
    for (const peer of participants) accepted(await post(peer,`/pbft/${phase}/cast`,{ epoch: String(snapshot.record.epoch) }),phase.toUpperCase());
  }
  async function commit(snapshot,participants) {
    await cast(snapshot,"commit",participants);
    const primary = peerAt(deterministicPrimary(peers,String(snapshot.record.epoch),"0"));
    const result = accepted(await post(primary,"/pbft/qc",{ epoch: String(snapshot.record.epoch),view: "0" }),"QC");
    accepted(await post(primary,"/pbft/qc/submit",result.certificate),"QC submission");
    await projector.projectCommittedBatches();
    console.log(`Batch COMMITTED: ${snapshot.record.batchId}; QC ${result.certificate.qcDigest}`);
    return result.certificate;
  }
  return {
    async runOnce() {
      assert.equal(held,undefined,"automatic pipeline cannot run through a held fault barrier");
      if (!(await pool.query(`SELECT 1 FROM ${cursor} WHERE chain_domain = $1 AND source_gateway = $2`,[String(config.chainDomain),config.sourceGateway])).rowCount) return;
      const snapshot = await nextSealed();
      if (snapshot) {
        const pending = await propose(snapshot);
        await cast(pending,"prepare",peers);
        await commit(pending,peers);
      }
      await projector.projectCommittedBatches();
    },
    async sealTarget({ messageId,scenario }) {
      assert.ok(["byzantine-validator","validator-crash"].includes(scenario));
      assert.equal(held,undefined);
      const snapshot = await nextSealed();
      assert.ok(snapshot); assert.equal(snapshot.record.status,"SEALED");
      assert.deepEqual(snapshot.members.map(member => member.messageId),[messageId],"fault barrier must hold this fresh message alone");
      const selection = faultSelection(peers,String(snapshot.record.epoch));
      held = { snapshot,scenario,...selection,phase: "SEALED" };
      return { ...selection,protocolVersion: "3",epoch: String(snapshot.record.epoch),view: "0",batchId: snapshot.record.batchId,
        messageRoot: snapshot.record.messageRoot,...consensusBinding(config,String(snapshot.record.epoch)),
        sourceDomain: String(config.chainDomain),sourceGateway: config.sourceGateway };
    },
    async step({ phase }) {
      assert.ok(held,"fault barrier is not active");
      const participants = held.honest.map(peerAt);
      if (phase === "propose") {
        assert.equal(held.phase,"SEALED"); held.snapshot = await propose(held.snapshot); held.phase = "PROPOSED";
      } else if (phase === "prepare") {
        assert.equal(held.phase,"PROPOSED"); await cast(held.snapshot,"prepare",participants); held.phase = "PREPARED";
      } else if (phase === "commit") {
        assert.equal(held.phase,"PREPARED"); const certificate = await commit(held.snapshot,participants); held.phase = "COMMITTED";
        return certificate;
      } else throw new Error("Unknown held pipeline phase");
      return { phase: held.phase };
    },
    release() { held = undefined; return { released: true }; },
  };
}
