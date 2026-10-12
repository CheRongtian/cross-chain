import { normalizeSourceScope, tableName } from "../db.mjs";
import { buildDeliveryPackages, DeliveryError, deliveryJson } from "./package.mjs";
import { deliveryLifecycle, deliveryTransaction, readDeliveryProjection } from "./repository.mjs";

export function createDeliveryProjector({ config, pool, afterJobPersisted = async () => {} }) {
  const lifecycle = deliveryLifecycle(config, pool);
  const scope = normalizeSourceScope(config);
  const sourceBatches = tableName(config.databaseSchema, "message_batches");
  const batches = tableName(config.databaseSchema, "delivery_batches");
  const jobs = tableName(config.databaseSchema, "delivery_jobs");

  async function materializeBatch({ batchRecordId }) {
    return deliveryTransaction(pool, async (client) => {
      // Every projector locks the same existing source row before checking queue state.
      const source = (await client.query(`SELECT batch_record_id,status FROM ${sourceBatches}
        WHERE batch_record_id = $1 AND source_domain = $2 AND source_gateway = $3 FOR UPDATE`,
      [batchRecordId, scope.chainDomain, scope.sourceGateway])).rows[0];
      if (!source) throw new DeliveryError("DELIVERY_BATCH_NOT_FOUND");
      if (source.status !== "COMMITTED") throw new DeliveryError("DELIVERY_REQUIRES_COMMITTED");
      const snapshot = await lifecycle.readBatch({ batchRecordId }, client);
      const existing = await client.query(`SELECT batch_record_id FROM ${batches} WHERE batch_record_id = $1`, [batchRecordId]);
      if (existing.rowCount) {
        const entries = await readDeliveryProjection({ config, client, lifecycle, batchRecordId, snapshot });
        return Object.freeze({ createdJobs: 0, materialized: false, jobs: Object.freeze(entries.map((entry) => entry.job)) });
      }
      const packages = await buildDeliveryPackages(snapshot, { validatorSets: config.validatorSets,
        sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway });
      const pack = packages[0];
      await client.query(`INSERT INTO ${batches} (batch_record_id,batch_id,source_domain,source_gateway,batch_epoch,
        batch_version,message_root,leaf_count,protocol_version,validator_epoch,committee_digest,qc_digest)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [batchRecordId, pack.batchId,
        pack.message.sourceDomain, pack.message.sourceGateway, pack.batchEpoch, Number(pack.batchVersion),
        pack.messageRoot, String(pack.leafCount), Number(pack.quorumCertificate.protocolVersion), pack.validatorEpoch,
        pack.committeeDigest, pack.quorumCertificate.qcDigest]);
      for (const pack of packages) {
        await client.query(`INSERT INTO ${jobs} (delivery_job_id,batch_record_id,source_message_id,message_index,
          message_id,source_domain,source_gateway,destination_domain,destination_gateway,destination_receiver,proof_siblings)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)`, [pack.deliveryJobId, batchRecordId,
          snapshot.members[pack.messageIndex].sourceMessageId, String(pack.messageIndex), pack.message.messageId,
          pack.message.sourceDomain, pack.message.sourceGateway, pack.message.destinationDomain,
          pack.message.destinationGateway, pack.message.destinationReceiver, deliveryJson(pack.merkleProof.siblings)]);
        await afterJobPersisted({ batchRecordId, messageIndex: pack.messageIndex });
      }
      const entries = await readDeliveryProjection({ config, client, lifecycle, batchRecordId, snapshot });
      return Object.freeze({ createdJobs: packages.length, materialized: true, jobs: Object.freeze(entries.map((entry) => entry.job)) });
    });
  }

  return {
    materializeBatch,
    async projectCommittedBatches() {
      let materializedBatches = 0;
      let createdJobs = 0;
      // Bounded queries, durable eligibility, no cursor or in-memory restart position.
      while (true) {
        const rows = (await pool.query(`SELECT b.batch_record_id FROM ${sourceBatches} b
          WHERE b.source_domain = $1 AND b.source_gateway = $2 AND b.status = 'COMMITTED'
            AND NOT EXISTS (SELECT 1 FROM ${batches} d WHERE d.batch_record_id = b.batch_record_id)
          ORDER BY b.epoch,b.batch_id LIMIT 100`, [scope.chainDomain, scope.sourceGateway])).rows;
        if (!rows.length) break;
        for (const row of rows) {
          const result = await materializeBatch({ batchRecordId: row.batch_record_id });
          materializedBatches += Number(result.materialized);
          createdJobs += result.createdJobs;
        }
      }
      return Object.freeze({ materializedBatches, createdJobs });
    },
  };
}
