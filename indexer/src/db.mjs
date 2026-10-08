import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import { normalizeAddress, normalizeBytes32, toUint256 } from "./canonical-message.mjs";
import { validateSchemaName } from "./config.mjs";
import {
  normalizeSourceEventIdentity,
  sourceEventIdentityKey,
} from "./source-event-identity.mjs";

const { Pool } = pg;
const MIGRATIONS_DIRECTORY = fileURLToPath(new URL("../migrations/", import.meta.url));
const SOURCE_EVENT_CONSTRAINT = "source_messages_source_event_unique";
const IMMUTABLE_MESSAGE_FIELDS = [
  "messageId",
  "version",
  "sourceDomain",
  "sourceGateway",
  "sourceSender",
  "destinationDomain",
  "destinationGateway",
  "destinationReceiver",
  "nonce",
  "payloadHash",
  "deadline",
  "sourceBlockNumber",
  "sourceBlockHash",
  "sourceTransactionHash",
  "sourceLogIndex",
];

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

async function readMigrations() {
  const names = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((name) => /^\d+_[a-z0-9_]+\.sql$/.test(name))
    .sort((left, right) => left.localeCompare(right, "en"));

  if (names.length === 0) {
    throw new Error("no Chain A Indexer migrations were found");
  }

  return Promise.all(
    names.map(async (name) => ({
      name,
      sql: await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"),
    })),
  );
}

function normalizeMessageRow(row) {
  const version = toUint256(row.version, "message version");
  if (version > 255n) {
    throw new Error("invalid message version");
  }
  if (!Buffer.isBuffer(row.payload) && !(row.payload instanceof Uint8Array)) {
    throw new Error("message payload must be bytes");
  }

  const identity = normalizeSourceEventIdentity(row);
  return {
    messageId: normalizeBytes32(row.messageId, "message ID"),
    version: Number(version),
    sourceDomain: identity.sourceDomain,
    sourceGateway: identity.sourceGateway,
    sourceSender: normalizeAddress(row.sourceSender, "source sender"),
    destinationDomain: toUint256(row.destinationDomain, "destination domain").toString(),
    destinationGateway: normalizeAddress(row.destinationGateway, "destination gateway"),
    destinationReceiver: normalizeAddress(row.destinationReceiver, "destination receiver"),
    nonce: toUint256(row.nonce, "nonce").toString(),
    payload: Buffer.from(row.payload),
    payloadHash: normalizeBytes32(row.payloadHash, "payload hash"),
    deadline: toUint256(row.deadline, "deadline").toString(),
    sourceBlockNumber: toUint256(row.sourceBlockNumber, "source block number").toString(),
    sourceBlockHash: identity.sourceBlockHash,
    sourceTransactionHash: identity.sourceTransactionHash,
    sourceLogIndex: identity.sourceLogIndex,
  };
}

function storedMessageRow(row) {
  return normalizeMessageRow({
    messageId: row.message_id,
    version: row.version,
    sourceDomain: row.source_domain,
    sourceGateway: row.source_gateway,
    sourceSender: row.source_sender,
    destinationDomain: row.destination_domain,
    destinationGateway: row.destination_gateway,
    destinationReceiver: row.destination_receiver,
    nonce: row.nonce,
    payload: row.payload,
    payloadHash: row.payload_hash,
    deadline: row.deadline,
    sourceBlockNumber: row.source_block_number,
    sourceBlockHash: row.source_block_hash,
    sourceTransactionHash: row.source_tx_hash,
    sourceLogIndex: row.source_log_index,
  });
}

function assertConsistentDuplicate(storedRow, candidate) {
  let stored;
  try {
    stored = storedMessageRow(storedRow);
  } catch (error) {
    throw new Error(`stored duplicate source event is invalid: ${error.message}`, { cause: error });
  }

  for (const field of IMMUTABLE_MESSAGE_FIELDS) {
    if (stored[field] !== candidate[field]) {
      throw new Error(
        `inconsistent duplicate source event ${sourceEventIdentityKey(candidate)}: ${field} differs`,
      );
    }
  }

  if (!stored.payload.equals(candidate.payload)) {
    throw new Error(
      `inconsistent duplicate source event ${sourceEventIdentityKey(candidate)}: payload differs`,
    );
  }
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

export async function applyMigrations(pool, schema) {
  const migrations = await readMigrations();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema)}`);
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(schema)}`);
    for (const migration of migrations) {
      await client.query(migration.sql);
    }
    await client.query("COMMIT");
    return migrations.map((migration) => migration.name);
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
      if (rangeEnd < expectedNextBlock) {
        throw new Error("range end block must not precede the range start block");
      }
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

        let inserted = 0;
        let duplicates = 0;

        for (const unnormalizedRow of rows) {
          const row = normalizeMessageRow(unnormalizedRow);
          const insertion = await client.query(
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
             )
             ON CONFLICT ON CONSTRAINT ${SOURCE_EVENT_CONSTRAINT}
             DO NOTHING
             RETURNING id`,
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

          if (insertion.rowCount === 1) {
            inserted += 1;
            continue;
          }
          if (insertion.rowCount !== 0) {
            throw new Error("source event insertion returned an unexpected row count");
          }

          const duplicate = await client.query(
            `SELECT
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
               FROM ${messages}
              WHERE source_domain = $1
                AND source_gateway = $2
                AND source_block_hash = $3
                AND source_tx_hash = $4
                AND source_log_index = $5`,
            [
              row.sourceDomain,
              row.sourceGateway,
              row.sourceBlockHash,
              row.sourceTransactionHash,
              row.sourceLogIndex,
            ],
          );
          if (duplicate.rowCount !== 1) {
            throw new Error("conflicting source event could not be resolved to exactly one stored row");
          }

          assertConsistentDuplicate(duplicate.rows[0], row);
          duplicates += 1;
        }

        const candidateNextBlock = rangeEnd + 1n;
        const updated = await client.query(
          `UPDATE ${cursors}
              SET next_block = GREATEST(next_block, $3::numeric),
                  updated_at = CURRENT_TIMESTAMP
            WHERE chain_domain = $1 AND source_gateway = $2
            RETURNING next_block`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            candidateNextBlock.toString(),
          ],
        );
        if (updated.rowCount !== 1) {
          throw new Error("indexer cursor update did not affect exactly one row");
        }

        await client.query("COMMIT");
        return { inserted, duplicates, nextBlock: BigInt(updated.rows[0].next_block) };
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
