import { isDeepStrictEqual } from "node:util";
import { createBatchLifecycle } from "../batch-lifecycle.mjs";
import { normalizeSourceScope, tableName } from "../db.mjs";
import { buildDeliveryPackages, DeliveryError, deliveryIndex, deliveryLimit } from "./package.mjs";

export async function deliveryTransaction(pool, operation) {
  const client = await pool.connect();
  let released = false;
  try {
    await client.query("BEGIN");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { client.release(rollbackError); released = true; }
    throw error;
  } finally { if (!released) client.release(); }
}

export function deliveryLifecycle(config, pool) {
  if (!config.validatorSets) throw new DeliveryError("VALIDATOR_HISTORY_REQUIRED");
  return createBatchLifecycle({ config, pool, validatorSets: config.validatorSets,
    committee: config.validatorSets.history[0].validators.map((address) => ({ address })) });
}

// Used by reads and idempotent materialization, inside their caller's transaction.
export async function readDeliveryProjection({ config, client, lifecycle, batchRecordId, snapshot }) {
  const batches = tableName(config.databaseSchema, "delivery_batches");
  const jobsTable = tableName(config.databaseSchema, "delivery_jobs");
  const row = (await client.query(`SELECT * FROM ${batches} WHERE batch_record_id = $1`, [batchRecordId])).rows[0];
  if (!row) throw new DeliveryError("DELIVERY_PROJECTION_NOT_FOUND");
  const committed = snapshot ?? await lifecycle.readBatch({ batchRecordId }, client);
  const packages = await buildDeliveryPackages(committed, { validatorSets: config.validatorSets,
    sourceDomain: config.chainDomain, sourceGateway: config.sourceGateway });
  const first = packages[0];
  const actual = { batchId: row.batch_id, sourceDomain: row.source_domain, sourceGateway: row.source_gateway,
    batchEpoch: row.batch_epoch, batchVersion: String(row.batch_version), messageRoot: row.message_root,
    leafCount: row.leaf_count, protocolVersion: String(row.protocol_version), validatorEpoch: row.validator_epoch,
    committeeDigest: row.committee_digest, qcDigest: row.qc_digest };
  const expected = { batchId: first.batchId, sourceDomain: first.message.sourceDomain, sourceGateway: first.message.sourceGateway,
    batchEpoch: first.batchEpoch, batchVersion: first.batchVersion, messageRoot: first.messageRoot,
    leafCount: String(first.leafCount), protocolVersion: first.quorumCertificate.protocolVersion,
    validatorEpoch: first.validatorEpoch, committeeDigest: first.committeeDigest, qcDigest: first.quorumCertificate.qcDigest };
  if (!isDeepStrictEqual(actual, expected)) throw new DeliveryError("CORRUPTED_DELIVERY_PROJECTION");
  const rows = (await client.query(`SELECT * FROM ${jobsTable} WHERE batch_record_id = $1 ORDER BY message_index,delivery_job_id`, [batchRecordId])).rows;
  if (rows.length !== packages.length) throw new DeliveryError("INCOMPLETE_DELIVERY_PROJECTION");
  const entries = [];
  for (let index = 0; index < rows.length; index++) {
    const stored = rows[index];
    const pack = packages[index];
    const member = committed.members[index];
    const fields = { id: stored.delivery_job_id, sourceMessageId: stored.source_message_id,
      index: stored.message_index, messageId: stored.message_id, sourceDomain: stored.source_domain,
      sourceGateway: stored.source_gateway, destinationDomain: stored.destination_domain,
      destinationGateway: stored.destination_gateway, destinationReceiver: stored.destination_receiver, status: stored.status };
    const required = { id: pack.deliveryJobId, sourceMessageId: member.sourceMessageId,
      index: String(pack.messageIndex), messageId: pack.message.messageId, sourceDomain: pack.message.sourceDomain,
      sourceGateway: pack.message.sourceGateway, destinationDomain: pack.message.destinationDomain,
      destinationGateway: pack.message.destinationGateway, destinationReceiver: pack.message.destinationReceiver, status: "READY" };
    if (!isDeepStrictEqual(fields, required) || !isDeepStrictEqual(stored.proof_siblings, pack.merkleProof.siblings)) throw new DeliveryError("CORRUPTED_DELIVERY_JOB");
    // Do not substitute a reconstructed path for a corrupted stored path.
    const job = Object.freeze({ deliveryJobId: pack.deliveryJobId, batchRecordId: row.batch_record_id,
      batchEpoch: pack.batchEpoch, batchId: pack.batchId, messageIndex: deliveryIndex(stored.message_index),
      messageId: pack.message.messageId, sourceDomain: pack.message.sourceDomain, sourceGateway: pack.message.sourceGateway,
      destinationDomain: pack.message.destinationDomain, destinationGateway: pack.message.destinationGateway,
      destinationReceiver: pack.message.destinationReceiver, validatorEpoch: pack.validatorEpoch,
      committeeDigest: pack.committeeDigest, messageRoot: pack.messageRoot, qcDigest: pack.quorumCertificate.qcDigest,
      status: "READY", createdAt: stored.created_at.toISOString(), materializedAt: row.materialized_at.toISOString() });
    entries.push(Object.freeze({ job, package: pack }));
  }
  return Object.freeze(entries);
}

export function createDeliveryRepository({ config, pool }) {
  const lifecycle = deliveryLifecycle(config, pool);
  const scope = normalizeSourceScope(config);
  const jobs = tableName(config.databaseSchema, "delivery_jobs");
  const batches = tableName(config.databaseSchema, "delivery_batches");
  async function entry(client, deliveryJobId) {
    const row = (await client.query(`SELECT j.batch_record_id FROM ${jobs} j JOIN ${batches} b USING (batch_record_id)
      WHERE j.delivery_job_id = $1 AND b.source_domain = $2 AND b.source_gateway = $3`,
    [deliveryJobId, scope.chainDomain, scope.sourceGateway])).rows[0];
    if (!row) throw new DeliveryError("DELIVERY_JOB_NOT_FOUND");
    const entries = await readDeliveryProjection({ config, client, lifecycle, batchRecordId: row.batch_record_id });
    const value = entries.find((value) => value.job.deliveryJobId === deliveryJobId);
    if (!value) throw new DeliveryError("CORRUPTED_DELIVERY_JOB");
    return value;
  }
  return {
    async listReadyDeliveryJobs({ limit = 100 } = {}) {
      deliveryLimit(limit);
      return deliveryTransaction(pool, async (client) => {
        const rows = (await client.query(`SELECT j.delivery_job_id,j.batch_record_id FROM ${jobs} j
          JOIN ${batches} b USING (batch_record_id)
          WHERE b.source_domain = $1 AND b.source_gateway = $2 AND j.status = 'READY'
          ORDER BY b.batch_epoch,j.message_index,j.delivery_job_id LIMIT $3`, [scope.chainDomain, scope.sourceGateway, limit])).rows;
        const projections = new Map();
        const result = [];
        for (const row of rows) {
          if (!projections.has(row.batch_record_id)) projections.set(row.batch_record_id,
            await readDeliveryProjection({ config, client, lifecycle, batchRecordId: row.batch_record_id }));
          const value = projections.get(row.batch_record_id).find((value) => value.job.deliveryJobId === row.delivery_job_id);
          if (!value) throw new DeliveryError("CORRUPTED_DELIVERY_JOB");
          result.push(value.job);
        }
        return Object.freeze(result);
      });
    },
    async getDeliveryJob(deliveryJobId) { return deliveryTransaction(pool, async (client) => (await entry(client, deliveryJobId)).job); },
    async getDeliveryPackage(deliveryJobId) { return deliveryTransaction(pool, async (client) => (await entry(client, deliveryJobId)).package); },
  };
}
