import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { normalizeSourceScope, tableName } from "../db.mjs";
import { createDeliveryRepository } from "../delivery/repository.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { encodeDestinationSubmission } from "./encoding.mjs";
import { RelayerError } from "./config.mjs";

// One Relayer A per database. A session lock is not a job lease or message authority.
const LOCK_NAMESPACE = 738201;
const LOCK_INSTANCE = 1;

export function createRelaySubmissionRepository({ config,pool,queue = createDeliveryRepository({ config,pool }) }) {
  const scope = normalizeSourceScope(config);
  const jobs = tableName(config.databaseSchema,"delivery_jobs");
  const batches = tableName(config.databaseSchema,"delivery_batches");
  const submissions = tableName(config.databaseSchema,"relayer_submissions");
  const intents = tableName(config.databaseSchema,"transaction_intents");
  const verification = { validatorSets: config.validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway };

  function matchingRecord(row,encoded) {
    const pack = encoded.package;
    if (row.delivery_job_id !== pack.deliveryJobId || row.package_digest !== encoded.packageDigest ||
        row.destination_domain !== pack.message.destinationDomain ||
        normalizeAddress(row.destination_gateway) !== pack.message.destinationGateway) throw new RelayerError("CONFLICTING_RELAY_SUBMISSION");
    return Object.freeze({ deliveryJobId: row.delivery_job_id,relayerAddress: normalizeAddress(row.relayer_address),
      destinationDomain: row.destination_domain,destinationGateway: normalizeAddress(row.destination_gateway),
      packageDigest: normalizeBytes32(row.package_digest),transactionHash: normalizeBytes32(row.transaction_hash,"transaction hash"),
      submittedAt: row.submitted_at.toISOString() });
  }

  return {
    async withSingleton(operation) {
      const client = await pool.connect();
      let acquired = false;
      let lost = false;
      const onError = () => { lost = true; };
      client.on("error",onError);
      const assertHeld = () => { if (lost) throw new RelayerError("RELAYER_SESSION_LOST"); };
      try {
        const result = await client.query("SELECT pg_try_advisory_lock($1,$2) AS acquired",[LOCK_NAMESPACE,LOCK_INSTANCE]);
        acquired = result.rows[0].acquired;
        if (!acquired) throw new RelayerError("RELAYER_ALREADY_RUNNING");
        return await operation(assertHeld);
      } finally {
        try {
          if (acquired && !lost) await client.query("SELECT pg_advisory_unlock($1,$2)",[LOCK_NAMESPACE,LOCK_INSTANCE]);
        } finally {
          client.removeListener("error",onError);
          client.release(lost ? new Error("relayer lock connection lost") : undefined);
        }
      }
    },
    async listEligibleJobs({ limit = config.maxJobs } = {}) {
      deliveryLimit(limit);
      // Filter before LIMIT: completed early jobs cannot starve later READY jobs.
      const rows = (await pool.query(`SELECT j.delivery_job_id FROM ${jobs} j JOIN ${batches} b USING (batch_record_id)
        WHERE b.source_domain = $1 AND b.source_gateway = $2 AND j.status = 'READY'
          AND NOT EXISTS (SELECT 1 FROM ${submissions} s WHERE s.delivery_job_id = j.delivery_job_id)
          AND NOT EXISTS (SELECT 1 FROM ${intents} t WHERE t.delivery_job_id = j.delivery_job_id)
        ORDER BY b.batch_epoch,j.message_index,j.delivery_job_id LIMIT $3`,[scope.chainDomain,scope.sourceGateway,limit])).rows;
      const result = [];
      for (const row of rows) result.push(await queue.getDeliveryJob(row.delivery_job_id));
      return Object.freeze(result);
    },
    async getSubmission(deliveryJobId,encoded) {
      const row = (await pool.query(`SELECT * FROM ${submissions} WHERE delivery_job_id = $1`,[deliveryJobId])).rows[0];
      if (!row) return null;
      const actual = encoded ?? await encodeDestinationSubmission(await queue.getDeliveryPackage(deliveryJobId),verification);
      if (actual.package.deliveryJobId !== deliveryJobId) throw new RelayerError("CONFLICTING_RELAY_SUBMISSION");
      return matchingRecord(row,actual);
    },
    async recordSubmission({ deliveryJobId,encoded,transactionHash }) {
      const hash = normalizeBytes32(transactionHash,"transaction hash");
      const actual = await encodeDestinationSubmission(await queue.getDeliveryPackage(deliveryJobId),verification);
      if (encoded.package.deliveryJobId !== deliveryJobId || actual.packageDigest !== encoded.packageDigest) throw new RelayerError("CONFLICTING_RELAY_SUBMISSION");
      await pool.query(`INSERT INTO ${submissions} (delivery_job_id,relayer_address,destination_domain,destination_gateway,package_digest,transaction_hash)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (delivery_job_id) DO NOTHING`,[deliveryJobId,
        normalizeAddress(config.relayerAddress),actual.package.message.destinationDomain,actual.package.message.destinationGateway,actual.packageDigest,hash]);
      const row = (await pool.query(`SELECT * FROM ${submissions} WHERE delivery_job_id = $1`,[deliveryJobId])).rows[0];
      const stored = matchingRecord(row,actual);
      if (stored.transactionHash !== hash || stored.relayerAddress !== normalizeAddress(config.relayerAddress)) throw new RelayerError("CONFLICTING_RELAY_SUBMISSION");
      return stored;
    },
  };
}
