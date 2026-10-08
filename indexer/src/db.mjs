import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { normalizeAddress, toUint256 } from "./canonical-message.mjs";
import { validateSchemaName } from "./config.mjs";

const { Pool } = pg;
const MIGRATION_PATH = fileURLToPath(new URL("../migrations/001_chain_a_indexer.sql", import.meta.url));

function quoteIdentifier(value) {
  return `"${validateSchemaName(value)}"`;
}

function tableName(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function cursorScope(scope) {
  return {
    chainDomain: toUint256(scope.chainDomain, "cursor chain domain").toString(),
    sourceGateway: normalizeAddress(scope.sourceGateway, "cursor source gateway"),
  };
}

export function createDatabasePool({ databaseUrl }) {
  return new Pool({ connectionString: databaseUrl });
}

export async function checkDatabaseConnection(pool) {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1 AS connected");
  } finally {
    client.release();
  }
}

export async function applyMigration(pool, schema) {
  const migration = await readFile(MIGRATION_PATH, "utf8");
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}`);
    await client.query(migration);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function createDatabaseStore(pool, schema) {
  const cursors = tableName(schema, "indexer_cursors");
  const messages = tableName(schema, "source_messages");

  return {
    async loadOrInitializeCursor(scope, configuredStartBlock) {
      const normalizedScope = cursorScope(scope);
      const startBlock = toUint256(configuredStartBlock, "configured start block");
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const existing = await client.query(
          `SELECT chain_domain, source_gateway, next_block
             FROM ${cursors}
            WHERE chain_domain = $1 AND source_gateway = $2
            FOR UPDATE`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway],
        );

        let nextBlock;
        if (existing.rowCount === 0) {
          await client.query(
            `INSERT INTO ${cursors} (chain_domain, source_gateway, next_block)
             VALUES ($1, $2, $3)`,
            [normalizedScope.chainDomain, normalizedScope.sourceGateway, startBlock.toString()],
          );
          nextBlock = startBlock;
        } else {
          const row = existing.rows[0];
          if (
            BigInt(row.chain_domain) !== BigInt(normalizedScope.chainDomain) ||
            normalizeAddress(row.source_gateway, "stored cursor source gateway") !== normalizedScope.sourceGateway
          ) {
            throw new Error("stored cursor identity does not match configured chain and SourceGateway");
          }
          nextBlock = BigInt(row.next_block);
        }

        await client.query("COMMIT");
        return nextBlock;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async persistRange(scope, { fromBlock, toBlock, rows }) {
      const normalizedScope = cursorScope(scope);
      const expectedNextBlock = toUint256(fromBlock, "range start block");
      const rangeEnd = toUint256(toBlock, "range end block");
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const cursor = await client.query(
          `SELECT next_block
             FROM ${cursors}
            WHERE chain_domain = $1 AND source_gateway = $2
            FOR UPDATE`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway],
        );

        if (cursor.rowCount !== 1) {
          throw new Error("indexer cursor is missing for the configured chain and SourceGateway");
        }
        if (BigInt(cursor.rows[0].next_block) !== expectedNextBlock) {
          throw new Error("persisted cursor changed before the block range could be committed");
        }

        for (const row of rows) {
          await client.query(
            `INSERT INTO ${messages} (
                message_id,
                version,
                source_domain,
                source_gateway,
                source_sender,
                destination_domain,
                destination_gateway,
                destination_receiver,
                nonce,
                payload,
                payload_hash,
                deadline,
                source_block_number,
                source_block_hash,
                source_tx_hash,
                source_log_index
             ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8,
                $9, $10, $11, $12, $13, $14, $15, $16
             )`,
            [
              row.messageId,
              row.version,
              row.sourceDomain,
              row.sourceGateway,
              row.sourceSender,
              row.destinationDomain,
              row.destinationGateway,
              row.destinationReceiver,
              row.nonce,
              row.payload,
              row.payloadHash,
              row.deadline,
              row.sourceBlockNumber,
              row.sourceBlockHash,
              row.sourceTransactionHash,
              row.sourceLogIndex,
            ],
          );
        }

        const nextBlock = rangeEnd + 1n;
        const updated = await client.query(
          `UPDATE ${cursors}
              SET next_block = $3, updated_at = CURRENT_TIMESTAMP
            WHERE chain_domain = $1 AND source_gateway = $2`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway, nextBlock.toString()],
        );
        if (updated.rowCount !== 1) {
          throw new Error("indexer cursor update did not affect exactly one row");
        }

        await client.query("COMMIT");
        return { persistedRows: rows.length, nextBlock };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export async function readCursor(pool, schema, scope) {
  const normalizedScope = cursorScope(scope);
  const result = await pool.query(
    `SELECT chain_domain, source_gateway, next_block, updated_at
       FROM ${tableName(schema, "indexer_cursors")}
      WHERE chain_domain = $1 AND source_gateway = $2`,
    [normalizedScope.chainDomain, normalizedScope.sourceGateway],
  );
  return result.rowCount === 0 ? undefined : result.rows[0];
}

export async function readMessages(pool, schema) {
  const result = await pool.query(
    `SELECT * FROM ${tableName(schema, "source_messages")} ORDER BY id ASC`,
  );
  return result.rows;
}

export async function readTableColumns(pool, schema, table) {
  const result = await pool.query(
    `SELECT column_name, data_type, numeric_precision, numeric_scale
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    [validateSchemaName(schema), table],
  );
  return result.rows;
}

export async function resetIndexerTables(pool, schema) {
  await pool.query(
    `TRUNCATE TABLE ${tableName(schema, "source_messages")}, ${tableName(schema, "indexer_cursors")} RESTART IDENTITY`,
  );
}
