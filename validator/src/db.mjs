import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { tableName } from "../../indexer/src/db.mjs";
import { validateSchemaName } from "../../indexer/src/config.mjs";
import { canonicalCommittee, protocolInteger } from "./committee.mjs";
import { authenticatePrePrepare, PrePrepareError } from "./pre-prepare.mjs";

export function createValidatorPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

export async function applyValidatorMigrations(pool, schema) {
  const directory = new URL("../migrations/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
  const migrations = await Promise.all(names.map((name) => readFile(new URL(name, directory), "utf8")));
  const identifier = `"${validateSchemaName(schema)}"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
    await client.query(`SET LOCAL search_path TO ${identifier}`);
    for (const sql of migrations) await client.query(sql);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export function createValidatorStore({ pool, config }) {
  const metadata = tableName(config.databaseSchema, "validator_metadata");
  const bindings = tableName(config.databaseSchema, "validated_batch_bindings");
  const observations = tableName(config.databaseSchema, "validation_observations");
  const committee = tableName(config.databaseSchema, "validator_committee");
  const prepares = tableName(config.databaseSchema, "pbft_pre_prepares");
  const rejections = tableName(config.databaseSchema, "pre_prepare_rejections");
  const expectedCommittee = canonicalCommittee(config.peers);
  const expectedIdentity = {
    validator_address: config.validatorAddress,
    source_domain: config.chainDomain.toString(),
    source_gateway: config.sourceGateway,
    finality_block_depth: config.finalityBlockDepth.toString(),
    protocol_version: 1,
  };

  function checkIdentity(row) {
    if (!row || Object.entries(expectedIdentity).some(([key, value]) => row[key] !== value)) {
      throw new Error("validator state identity or source context mismatch");
    }
  }

  async function checkState(client, lock = "") {
    checkIdentity((await client.query(`SELECT * FROM ${metadata} WHERE singleton = true ${lock}`)).rows[0]);
    const row = (await client.query(`SELECT addresses FROM ${committee} WHERE singleton = true`)).rows[0];
    if (!row || !isDeepStrictEqual(row.addresses, expectedCommittee)) throw new Error("validator committee mismatch");
  }

  function proposalRecord(row) {
    if (!row) return null;
    return { validatorAddress: row.local_validator_identity, direction: row.direction, status: row.status,
      acceptedAt: row.accepted_at.toISOString(), envelope: {
        messageType: "PRE_PREPARE", protocolVersion: "1", sourceDomain: config.chainDomain.toString(),
        sourceGateway: config.sourceGateway, epoch: row.epoch, batchId: row.batch_id, messageRoot: row.message_root,
        primaryIdentity: row.primary_identity, proposalDigest: row.proposal_digest, signature: row.primary_signature,
      } };
  }

  async function transaction(operation) {
    const client = await pool.connect();
    let discarded = false;
    try {
      await client.query("BEGIN");
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (rollbackError) { client.release(rollbackError); discarded = true; }
      throw error;
    } finally { if (!discarded) client.release(); }
  }

  return {
    async checkIdentity() {
      await checkState(pool);
    },

    async bindIdentity() {
      return transaction(async (client) => {
        await client.query(`INSERT INTO ${metadata}
          (validator_address, source_domain, source_gateway, finality_block_depth, protocol_version)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (singleton) DO NOTHING`, Object.values(expectedIdentity));
        const result = await client.query(`SELECT * FROM ${metadata} WHERE singleton = true FOR UPDATE`);
        checkIdentity(result.rows[0]);
        await client.query(`INSERT INTO ${committee} (addresses) VALUES ($1::jsonb)
          ON CONFLICT (singleton) DO NOTHING`, [JSON.stringify(expectedCommittee)]);
        await checkState(client);
        return result.rows[0];
      });
    },

    async recordObservation({ snapshot, head, result, reason = null }) {
      const record = snapshot.record;
      const occurrences = snapshot.batch.messages.map((message, position) => ({
        position: String(position), messageId: message.messageId,
        sourceBlockNumber: message.sourceBlockNumber.toString(), sourceBlockHash: message.sourceBlockHash,
        sourceTransactionHash: message.sourceTransactionHash, sourceLogIndex: message.sourceLogIndex.toString(),
      }));
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await client.query(`INSERT INTO ${bindings}
          (batch_id, batch_epoch, message_root, message_count, ordered_occurrences)
          VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (batch_id) DO NOTHING`,
        [record.batchId, record.epoch.toString(), record.messageRoot, record.messageCount.toString(), JSON.stringify(occurrences)]);
        const binding = (await client.query(`SELECT * FROM ${bindings} WHERE batch_id = $1`, [record.batchId])).rows[0];
        if (binding.batch_epoch !== record.epoch.toString() || binding.message_root !== record.messageRoot ||
            binding.message_count !== record.messageCount.toString() || !isDeepStrictEqual(binding.ordered_occurrences, occurrences)) {
          throw new Error("conflicting validator-local batch snapshot; previous binding preserved");
        }
        await client.query(`INSERT INTO ${observations}
          (batch_id, source_head_number, source_head_hash, result, reason)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (batch_id, source_head_hash) DO NOTHING`,
        [record.batchId, head.number.toString(), head.hash, result, reason]);
        const observation = (await client.query(`SELECT * FROM ${observations} WHERE batch_id = $1 AND source_head_hash = $2`,
          [record.batchId, head.hash])).rows[0];
        if (observation.source_head_number !== head.number.toString() || observation.result !== result || observation.reason !== reason) {
          throw new Error("conflicting validation observation at the same source head; previous observation preserved");
        }
        return observation;
      });
    },

    async readObservations() {
      await checkState(pool);
      return (await pool.query(`SELECT * FROM ${observations} ORDER BY batch_id, source_head_number, source_head_hash`)).rows;
    },

    async readPrePrepare(epoch) {
      await checkState(pool);
      return proposalRecord((await pool.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 AND epoch = $2`,
        [config.validatorAddress, protocolInteger(epoch).toString()])).rows[0]);
    },

    async readPrePrepares() {
      await checkState(pool);
      return (await pool.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 ORDER BY epoch`,
        [config.validatorAddress])).rows.map(proposalRecord);
    },

    async savePrePrepare(input, direction) {
      const p = await authenticatePrePrepare(config, input);
      const expectedDirection = p.primaryIdentity === config.validatorAddress ? "ISSUED" : "ACCEPTED";
      if (direction !== expectedDirection) throw new Error("invalid PRE-PREPARE direction");
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await client.query(`INSERT INTO ${prepares}
          (local_validator_identity, epoch, batch_id, message_root, proposal_digest, primary_identity, primary_signature, direction)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (local_validator_identity, epoch) DO NOTHING`,
        [config.validatorAddress, p.epoch, p.batchId, p.messageRoot, p.proposalDigest, p.primaryIdentity, p.signature, direction]);
        const row = (await client.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 AND epoch = $2`,
          [config.validatorAddress, p.epoch])).rows[0];
        if (row.proposal_digest !== p.proposalDigest || row.batch_id !== p.batchId ||
            row.message_root !== p.messageRoot || row.primary_identity !== p.primaryIdentity || row.direction !== direction) {
          throw new PrePrepareError("CONFLICTING_PRE_PREPARE");
        }
        return proposalRecord(row);
      });
    },

    async recordPrePrepareRejection(input, reason) {
      // Keep only parseable public evidence; untrusted payloads and stacks are never stored.
      const digest = typeof input?.proposalDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.proposalDigest) ? input.proposalDigest.toLowerCase() : null;
      const primary = typeof input?.primaryIdentity === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.primaryIdentity) ? input.primaryIdentity.toLowerCase() : null;
      let epoch = null;
      try { epoch = protocolInteger(input?.epoch).toString(); } catch { /* malformed epoch is omitted */ }
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await client.query(`INSERT INTO ${rejections} (proposal_digest, primary_identity, epoch, reason)
          VALUES ($1, $2, $3, $4)`, [digest, primary, epoch, reason]);
      });
    },
  };
}
