import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import pg from "pg";

import {
  CanonicalDivergenceError,
  CanonicalHistoryBootstrapError,
  FinalizedSourceReorgError,
  normalizeCanonicalBlock,
  validateCanonicalBlockSequence,
} from "./canonical-block.mjs";
import { normalizeAddress, normalizeBytes32, toUint256 } from "./canonical-message.mjs";
import { validateSchemaName } from "./config.mjs";
import { determineFinalityTransition, MESSAGE_STATUS } from "./finality-policy.mjs";
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

export function tableName(schema, table) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

export function normalizeSourceScope(scope) {
  return {
    chainDomain: toUint256(scope.chainDomain, "source scope chain domain").toString(),
    sourceGateway: normalizeAddress(scope.sourceGateway, "source scope gateway"),
  };
}

function storedCanonicalBlock(row) {
  if (row === undefined) {
    return undefined;
  }
  return normalizeCanonicalBlock({
    number: row.block_number,
    hash: row.block_hash,
    parentHash: row.parent_hash,
  });
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
  const canonicalBlocks = tableName(schema, "indexed_source_blocks");

  return {
    async loadOrInitializeCursor(scope, configuredStartBlock) {
      const normalizedScope = normalizeSourceScope(scope);
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

    async persistRange(scope, { fromBlock, toBlock, blocks, rows }) {
      const normalizedScope = normalizeSourceScope(scope);
      const expectedNextBlock = toUint256(fromBlock, "range start block");
      const rangeEnd = toUint256(toBlock, "range end block");
      if (rangeEnd < expectedNextBlock) {
        throw new Error("range end block must not precede the range start block");
      }
      let normalizedBlocks = validateCanonicalBlockSequence(blocks, {
        fromBlock: expectedNextBlock,
        toBlock: rangeEnd,
      });
      const canonicalHashByNumber = new Map(
        normalizedBlocks.map((block) => [block.number.toString(), block.hash]),
      );
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

        if (expectedNextBlock > 0n) {
          const predecessorResult = await client.query(
            `SELECT block_number, block_hash, parent_hash
               FROM ${canonicalBlocks}
              WHERE source_domain = $1
                AND source_gateway = $2
                AND block_number = $3`,
            [
              normalizedScope.chainDomain,
              normalizedScope.sourceGateway,
              (expectedNextBlock - 1n).toString(),
            ],
          );
          if (predecessorResult.rowCount !== 1) {
            throw new CanonicalDivergenceError(
              `canonical predecessor block ${expectedNextBlock - 1n} is missing`,
            );
          }
          normalizedBlocks = validateCanonicalBlockSequence(normalizedBlocks, {
            fromBlock: expectedNextBlock,
            toBlock: rangeEnd,
            predecessor: storedCanonicalBlock(predecessorResult.rows[0]),
          });
        }

        for (const block of normalizedBlocks) {
          const insertion = await client.query(
            `INSERT INTO ${canonicalBlocks} (
                source_domain,
                source_gateway,
                block_number,
                block_hash,
                parent_hash
             ) VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (source_domain, source_gateway, block_number)
             DO NOTHING
             RETURNING block_number`,
            [
              normalizedScope.chainDomain,
              normalizedScope.sourceGateway,
              block.number.toString(),
              block.hash,
              block.parentHash,
            ],
          );

          if (insertion.rowCount === 1) {
            continue;
          }
          if (insertion.rowCount !== 0) {
            throw new Error("canonical block insertion returned an unexpected row count");
          }

          const existing = await client.query(
            `SELECT block_number, block_hash, parent_hash
               FROM ${canonicalBlocks}
              WHERE source_domain = $1
                AND source_gateway = $2
                AND block_number = $3`,
            [
              normalizedScope.chainDomain,
              normalizedScope.sourceGateway,
              block.number.toString(),
            ],
          );
          if (existing.rowCount !== 1) {
            throw new Error("conflicting canonical block could not be read after insertion");
          }
          const stored = storedCanonicalBlock(existing.rows[0]);
          if (stored.hash !== block.hash || stored.parentHash !== block.parentHash) {
            throw new CanonicalDivergenceError(
              `canonical block ${block.number} conflicts with persisted hash ${stored.hash}`,
            );
          }
        }

        let inserted = 0;
        let duplicates = 0;

        for (const unnormalizedRow of rows) {
          const row = normalizeMessageRow(unnormalizedRow);
          const canonicalBlockHash = canonicalHashByNumber.get(row.sourceBlockNumber);
          if (canonicalBlockHash === undefined) {
            throw new CanonicalDivergenceError(
              `source event block ${row.sourceBlockNumber} is outside persisted range ${expectedNextBlock}-${rangeEnd}`,
            );
          }
          if (canonicalBlockHash !== row.sourceBlockHash) {
            throw new CanonicalDivergenceError(
              `source event block hash ${row.sourceBlockHash} does not match canonical block ${row.sourceBlockNumber} hash ${canonicalBlockHash}`,
            );
          }
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

export function createCanonicalStore(pool, schema) {
  const cursors = tableName(schema, "indexer_cursors");
  const messages = tableName(schema, "source_messages");
  const canonicalBlocks = tableName(schema, "indexed_source_blocks");

  return {
    async readCanonicalHistoryState(scope) {
      const normalizedScope = normalizeSourceScope(scope);
      const result = await pool.query(
        `SELECT
            COUNT(*) AS block_count,
            MIN(block_number) AS first_block,
            MAX(block_number) AS last_block
           FROM ${canonicalBlocks}
          WHERE source_domain = $1 AND source_gateway = $2`,
        [normalizedScope.chainDomain, normalizedScope.sourceGateway],
      );
      const row = result.rows[0];
      const count = Number(row.block_count);
      return {
        count,
        firstBlock: count === 0 ? undefined : BigInt(row.first_block),
        lastBlock: count === 0 ? undefined : BigInt(row.last_block),
      };
    },

    async readCanonicalBlock(scope, blockNumber) {
      const normalizedScope = normalizeSourceScope(scope);
      const normalizedNumber = toUint256(blockNumber, "canonical block number");
      const result = await pool.query(
        `SELECT block_number, block_hash, parent_hash
           FROM ${canonicalBlocks}
          WHERE source_domain = $1
            AND source_gateway = $2
            AND block_number = $3`,
        [
          normalizedScope.chainDomain,
          normalizedScope.sourceGateway,
          normalizedNumber.toString(),
        ],
      );
      return result.rowCount === 0 ? undefined : storedCanonicalBlock(result.rows[0]);
    },

    async readCanonicalBlocksDescending(scope, throughBlock) {
      const normalizedScope = normalizeSourceScope(scope);
      const normalizedThrough = toUint256(throughBlock, "canonical history upper block");
      const result = await pool.query(
        `SELECT block_number, block_hash, parent_hash
           FROM ${canonicalBlocks}
          WHERE source_domain = $1
            AND source_gateway = $2
            AND block_number <= $3
          ORDER BY block_number DESC`,
        [
          normalizedScope.chainDomain,
          normalizedScope.sourceGateway,
          normalizedThrough.toString(),
        ],
      );
      return result.rows.map(storedCanonicalBlock);
    },

    async bootstrapCanonicalHistory(scope, { expectedNextBlock, blocks }) {
      const normalizedScope = normalizeSourceScope(scope);
      const normalizedNextBlock = toUint256(expectedNextBlock, "bootstrap cursor next block");
      if (blocks.length === 0) {
        throw new CanonicalHistoryBootstrapError(
          "canonical history bootstrap requires at least one anchor block",
        );
      }
      const normalizedBlocks = validateCanonicalBlockSequence(blocks, {
        fromBlock: blocks[0].number,
        toBlock: blocks[blocks.length - 1].number,
      });
      const blockHashes = new Map(
        normalizedBlocks.map((block) => [block.number.toString(), block.hash]),
      );
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
          throw new CanonicalHistoryBootstrapError(
            "indexer cursor is missing during canonical history bootstrap",
          );
        }
        if (BigInt(cursor.rows[0].next_block) !== normalizedNextBlock) {
          throw new CanonicalHistoryBootstrapError(
            "indexer cursor changed during canonical history bootstrap",
          );
        }

        const existingHistory = await client.query(
          `SELECT COUNT(*) AS block_count
             FROM ${canonicalBlocks}
            WHERE source_domain = $1 AND source_gateway = $2`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway],
        );
        if (Number(existingHistory.rows[0].block_count) !== 0) {
          throw new CanonicalHistoryBootstrapError(
            "canonical history appeared while bootstrap was in progress",
          );
        }

        const existingMessages = await client.query(
          `SELECT id, source_block_number, source_block_hash
             FROM ${messages}
            WHERE source_domain = $1 AND source_gateway = $2
            ORDER BY source_block_number ASC, source_log_index ASC, id ASC
            FOR UPDATE`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway],
        );
        for (const message of existingMessages.rows) {
          const blockNumber = BigInt(message.source_block_number).toString();
          const canonicalHash = blockHashes.get(blockNumber);
          const messageHash = normalizeBytes32(
            message.source_block_hash,
            "stored message source block hash",
          );
          if (canonicalHash === undefined || canonicalHash !== messageHash) {
            throw new CanonicalHistoryBootstrapError(
              "Pre-existing canonical mismatch detected while bootstrapping reorg history. Automatic recovery is unsafe because canonical block history was not persisted before migration 004.",
            );
          }
        }

        for (const block of normalizedBlocks) {
          await client.query(
            `INSERT INTO ${canonicalBlocks} (
                source_domain,
                source_gateway,
                block_number,
                block_hash,
                parent_hash
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              normalizedScope.chainDomain,
              normalizedScope.sourceGateway,
              block.number.toString(),
              block.hash,
              block.parentHash,
            ],
          );
        }

        await client.query("COMMIT");
        return { blocksPersisted: normalizedBlocks.length };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async recoverCanonicalReorg(scope, { commonAncestor, forkBlock }) {
      const normalizedScope = normalizeSourceScope(scope);
      const normalizedAncestor = normalizeCanonicalBlock(commonAncestor);
      const normalizedFork = toUint256(forkBlock, "canonical fork block");
      if (normalizedFork !== normalizedAncestor.number + 1n) {
        throw new Error("canonical fork block must immediately follow the common ancestor");
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
          throw new Error("indexer cursor is missing during source reorg recovery");
        }

        const storedAncestor = await client.query(
          `SELECT block_number, block_hash, parent_hash
             FROM ${canonicalBlocks}
            WHERE source_domain = $1
              AND source_gateway = $2
              AND block_number = $3
            FOR UPDATE`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            normalizedAncestor.number.toString(),
          ],
        );
        if (storedAncestor.rowCount !== 1) {
          throw new Error("persisted common ancestor is missing during source reorg recovery");
        }
        const lockedAncestor = storedCanonicalBlock(storedAncestor.rows[0]);
        if (
          lockedAncestor.hash !== normalizedAncestor.hash ||
          lockedAncestor.parentHash !== normalizedAncestor.parentHash
        ) {
          throw new CanonicalDivergenceError(
            "persisted common ancestor changed before source reorg recovery",
          );
        }

        const orphanedMessages = await client.query(
          `SELECT id, status
             FROM ${messages}
            WHERE source_domain = $1
              AND source_gateway = $2
              AND source_block_number >= $3
              AND status IN ('OBSERVED', 'FINALIZING', 'FINALIZED')
            ORDER BY source_block_number ASC, source_log_index ASC, id ASC
            FOR UPDATE`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            normalizedFork.toString(),
          ],
        );
        const finalizedMessages = orphanedMessages.rows.filter(
          (message) => message.status === MESSAGE_STATUS.FINALIZED,
        ).length;
        if (finalizedMessages > 0) {
          throw new FinalizedSourceReorgError(normalizedFork, finalizedMessages);
        }

        const reorged = await client.query(
          `UPDATE ${messages}
              SET status = 'REORGED',
                  reorged_at = COALESCE(reorged_at, CURRENT_TIMESTAMP)
            WHERE source_domain = $1
              AND source_gateway = $2
              AND source_block_number >= $3
              AND status IN ('OBSERVED', 'FINALIZING')`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            normalizedFork.toString(),
          ],
        );

        const deleted = await client.query(
          `DELETE FROM ${canonicalBlocks}
            WHERE source_domain = $1
              AND source_gateway = $2
              AND block_number >= $3`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            normalizedFork.toString(),
          ],
        );

        const rewound = await client.query(
          `UPDATE ${cursors}
              SET next_block = $3,
                  updated_at = CURRENT_TIMESTAMP
            WHERE chain_domain = $1 AND source_gateway = $2
            RETURNING next_block`,
          [
            normalizedScope.chainDomain,
            normalizedScope.sourceGateway,
            normalizedFork.toString(),
          ],
        );
        if (rewound.rowCount !== 1) {
          throw new Error("source reorg cursor rewind did not affect exactly one row");
        }

        await client.query("COMMIT");
        return {
          reorgedMessages: reorged.rowCount,
          deletedCanonicalBlocks: deleted.rowCount,
          rewoundNextBlock: BigInt(rewound.rows[0].next_block),
        };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
  };
}

export function createFinalityStore(pool, schema) {
  const messages = tableName(schema, "source_messages");

  return {
    async advanceFinality(scope, { headBlock, finalityBlockDepth }) {
      const normalizedScope = normalizeSourceScope(scope);
      const normalizedHead = toUint256(headBlock, "finality head block");
      const normalizedDepth = toUint256(finalityBlockDepth, "finality block depth");
      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const candidates = await client.query(
          `SELECT id, status, source_block_number
             FROM ${messages}
            WHERE source_domain = $1
              AND source_gateway = $2
              AND status IN ('OBSERVED', 'FINALIZING')
            ORDER BY source_block_number ASC, source_log_index ASC, id ASC
            FOR UPDATE`,
          [normalizedScope.chainDomain, normalizedScope.sourceGateway],
        );

        const result = {
          headBlock: normalizedHead,
          candidatesChecked: candidates.rowCount,
          observedToFinalizing: 0,
          observedToFinalized: 0,
          finalizingToFinalized: 0,
          unchangedFinalizing: 0,
        };

        for (const candidate of candidates.rows) {
          const transition = determineFinalityTransition({
            status: candidate.status,
            sourceBlockNumber: candidate.source_block_number,
            headBlockNumber: normalizedHead,
            finalityBlockDepth: normalizedDepth,
          });

          if (transition === null) {
            result.unchangedFinalizing += 1;
            continue;
          }

          let updated;
          if (transition === MESSAGE_STATUS.FINALIZING) {
            updated = await client.query(
              `UPDATE ${messages}
                  SET status = 'FINALIZING',
                      finalizing_at = COALESCE(finalizing_at, CURRENT_TIMESTAMP)
                WHERE id = $1 AND status = 'OBSERVED'`,
              [candidate.id],
            );
            result.observedToFinalizing += 1;
          } else if (transition === MESSAGE_STATUS.FINALIZED) {
            updated = await client.query(
              `UPDATE ${messages}
                  SET status = 'FINALIZED',
                      finalized_at = COALESCE(finalized_at, CURRENT_TIMESTAMP),
                      finalized_at_head = COALESCE(finalized_at_head, $2)
                WHERE id = $1 AND status = $3`,
              [candidate.id, normalizedHead.toString(), candidate.status],
            );

            if (candidate.status === MESSAGE_STATUS.OBSERVED) {
              result.observedToFinalized += 1;
            } else {
              result.finalizingToFinalized += 1;
            }
          } else {
            throw new Error(`unsupported finality transition: ${transition}`);
          }

          if (updated.rowCount !== 1) {
            throw new Error(
              `message ${candidate.id} changed status before its finality transition could be committed`,
            );
          }
        }

        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },

    async listBatchEligibleMessages(scope) {
      const normalizedScope = normalizeSourceScope(scope);
      const result = await pool.query(
        `SELECT *
           FROM ${messages}
          WHERE source_domain = $1
            AND source_gateway = $2
            AND status = 'FINALIZED'
          ORDER BY
            source_block_number ASC,
            source_log_index ASC,
            source_block_hash COLLATE "C" ASC,
            source_tx_hash COLLATE "C" ASC,
            message_id COLLATE "C" ASC`,
        [normalizedScope.chainDomain, normalizedScope.sourceGateway],
      );
      return result.rows;
    },
  };
}

export async function readCursor(pool, schema, scope) {
  const normalizedScope = normalizeSourceScope(scope);
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

export async function readIndexedSourceBlocks(pool, schema, scope) {
  const normalizedScope = normalizeSourceScope(scope);
  const result = await pool.query(
    `SELECT
        source_domain,
        source_gateway,
        block_number,
        block_hash,
        parent_hash,
        indexed_at
       FROM ${tableName(schema, "indexed_source_blocks")}
      WHERE source_domain = $1 AND source_gateway = $2
      ORDER BY block_number ASC`,
    [normalizedScope.chainDomain, normalizedScope.sourceGateway],
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
    `TRUNCATE TABLE
        ${tableName(schema, "message_batch_members")},
        ${tableName(schema, "message_batches")},
        ${tableName(schema, "source_messages")},
        ${tableName(schema, "indexer_cursors")},
        ${tableName(schema, "indexed_source_blocks")}
      RESTART IDENTITY`,
  );
}
