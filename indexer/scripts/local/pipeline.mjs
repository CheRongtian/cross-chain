import { tableName } from "../../src/db.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createDeliveryProjector } from "../../src/delivery/projector.mjs";
import { httpJson } from "./tools.mjs";

// Drives existing production APIs. Every validator validates the source and
// signs its own vote in its own process/store; this scheduler owns no keys.
export function createLocalPipeline({ config,pool,peers }) {
  const lifecycle = createBatchLifecycle({ config,pool,committee: peers });
  const projector = createDeliveryProjector({ config,pool });
  const batches = tableName(config.databaseSchema,"message_batches");
  const cursor = tableName(config.databaseSchema,"indexer_cursors");
  const accepted = (value,label) => {
    if (value.result !== "ACCEPTED") throw new Error(`${label}: ${value.reason ?? value.result}`);
    for (const delivery of value.deliveries ?? []) {
      if (delivery.delivery !== "DELIVERED" || delivery.result !== "ACCEPTED") throw new Error(`${label}: validator peer delivery failed`);
    }
    return value;
  };
  const post = (peer,path,body) => httpJson(peer.url + path,body);
  return {
    async runOnce() {
      if (!(await pool.query(`SELECT 1 FROM ${cursor} WHERE chain_domain = $1 AND source_gateway = $2`,[String(config.chainDomain),config.sourceGateway])).rowCount) return;
      // Bound each pass. A COMMITTED predecessor is retained and the lifecycle
      // selects the next legitimate epoch, including an initially empty source.
      const pending = (await pool.query(`SELECT batch_record_id FROM ${batches}
        WHERE source_domain = $1 AND source_gateway = $2 AND status <> 'COMMITTED' ORDER BY epoch LIMIT 1`,
      [String(config.chainDomain),config.sourceGateway])).rows[0];
      let snapshot = pending ? await lifecycle.readBatch({ batchRecordId: pending.batch_record_id }) : null;
      if (!snapshot || snapshot.record.status === "BUILDING") {
        snapshot = (await lifecycle.collectEligible({ initialEpoch: "0" })).snapshot;
        if (!snapshot.members.length) { await projector.projectCommittedBatches(); return; }
        snapshot = await lifecycle.sealBatch({ batchRecordId: snapshot.record.batchRecordId });
        console.log(`Batch SEALED: ${snapshot.record.batchId}`);
      }
      if (snapshot.record.status === "SEALED") snapshot = await lifecycle.markConsensusPending({ batchRecordId: snapshot.record.batchRecordId });
      if (snapshot.record.status === "CONSENSUS_PENDING") {
        const epoch = snapshot.record.epoch.toString();
        const selection = await post(peers[0],"/pbft/primary",{ epoch,view: "0" });
        const primary = peers.find(peer => peer.address === selection.primaryIdentity);
        if (!primary) throw new Error("PBFT primary is outside the configured committee");
        accepted(await post(primary,"/pbft/propose",{ batchId: snapshot.record.batchId }),"PRE-PREPARE");
        for (const peer of peers) accepted(await post(peer,"/pbft/prepare/cast",{ epoch }),"PREPARE");
        for (const peer of peers) accepted(await post(peer,"/pbft/commit/cast",{ epoch }),"COMMIT");
        const result = accepted(await post(primary,"/pbft/qc",{ epoch,view: "0" }),"QC");
        accepted(await post(primary,"/pbft/qc/submit",result.certificate),"QC submission");
        console.log(`Batch COMMITTED: ${snapshot.record.batchId}; QC ${result.certificate.qcDigest}`);
      }
      await projector.projectCommittedBatches();
    },
  };
}
