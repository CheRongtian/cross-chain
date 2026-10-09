import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { tableName } from "../../indexer/src/db.mjs";
import { validateSchemaName } from "../../indexer/src/config.mjs";

export function createValidatorPool(config) {
  return new pg.Pool({ connectionString: config.databaseUrl });
}

export async function applyValidatorMigrations(pool, schema) {
  const sql = await readFile(new URL("../migrations/001_validator_foundation.sql", import.meta.url), "utf8");
  const identifier = `"${validateSchemaName(schema)}"`;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${identifier}`);
    await client.query(`SET LOCAL search_path TO ${identifier}`);
    await client.query(sql);
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
      checkIdentity((await pool.query(`SELECT * FROM ${metadata} WHERE singleton = true`)).rows[0]);
    },

    async bindIdentity() {
      return transaction(async (client) => {
        await client.query(`INSERT INTO ${metadata}
          (validator_address, source_domain, source_gateway, finality_block_depth, protocol_version)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (singleton) DO NOTHING`, Object.values(expectedIdentity));
        const result = await client.query(`SELECT * FROM ${metadata} WHERE singleton = true FOR UPDATE`);
        checkIdentity(result.rows[0]);
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
        checkIdentity((await client.query(`SELECT * FROM ${metadata} WHERE singleton = true FOR UPDATE`)).rows[0]);
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
      checkIdentity((await pool.query(`SELECT * FROM ${metadata} WHERE singleton = true`)).rows[0]);
      return (await pool.query(`SELECT * FROM ${observations} ORDER BY batch_id, source_head_number, source_head_hash`)).rows;
    },
  };
}
