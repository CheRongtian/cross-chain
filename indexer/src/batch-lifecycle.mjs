import { normalizeBytes32 } from "./canonical-message.mjs";
import { createFinalityStore, normalizeSourceScope, tableName } from "./db.mjs";
import {
  buildMessageBatch,
  databaseRowToBatchMessage,
  MESSAGE_BATCH_VERSION,
  normalizeBatchMessage,
  validateMessageBatch,
} from "./message-batch.mjs";
import { buildMessageMerkleTree } from "./message-merkle.mjs";
import { expectedCommitStatement, QuorumCertificateError, verifyQuorumCertificate } from "../../validator/src/quorum-certificate.mjs";
import {
  BATCH_STATUS,
  nextBatchEpoch,
  normalizeBatchEpoch,
  validateBatchTransition,
} from "./batch-lifecycle-policy.mjs";

function databaseId(value, label) {
  if (
    typeof value !== "bigint" &&
    !(typeof value === "string" && /^[0-9]+$/.test(value)) &&
    !(typeof value === "number" && Number.isSafeInteger(value))
  ) {
    throw new Error(`invalid ${label}`);
  }
  const id = BigInt(value);
  if (id <= 0n || id > (1n << 63n) - 1n) {
    throw new Error(`invalid ${label}`);
  }
  return id.toString();
}

function lifecycleRecord(row) {
  return Object.freeze({
    batchRecordId: row.batch_record_id,
    sourceDomain: BigInt(row.source_domain),
    sourceGateway: row.source_gateway,
    epoch: normalizeBatchEpoch(row.epoch),
    status: row.status,
    version: BigInt(row.version),
    batchId: row.batch_id,
    messageRoot: row.message_root,
    messageCount: row.message_count === null ? null : BigInt(row.message_count),
    createdAt: row.created_at,
    sealedAt: row.sealed_at,
    consensusPendingAt: row.consensus_pending_at,
    committedAt: row.committed_at,
  });
}

export function createBatchLifecycle({ config, pool, committee = config.peers, afterCertificatePersisted = async () => {} }) {
  const scope = normalizeSourceScope(config);
  const protocolScope = {
    sourceDomain: BigInt(scope.chainDomain),
    sourceGateway: scope.sourceGateway,
  };
  const batches = tableName(config.databaseSchema, "message_batches");
  const members = tableName(config.databaseSchema, "message_batch_members");
  const sources = tableName(config.databaseSchema, "source_messages");
  const cursors = tableName(config.databaseSchema, "indexer_cursors");
  const certificates = tableName(config.databaseSchema, "batch_quorum_certificates");
  const certificateSignatures = tableName(config.databaseSchema, "batch_quorum_certificate_signatures");
  const scopeParameters = [scope.chainDomain, scope.sourceGateway];

  function certificateOptions(record) {
    if (!committee) throw new Error("expected static committee is required to verify a COMMITTED batch");
    return { peers: committee, expected: expectedCommitStatement({ ...protocolScope, epoch: record.epoch,
      batchId: record.batchId, messageRoot: record.messageRoot }, committee) };
  }

  async function readCertificate(client, record) {
    const rows = (await client.query(`SELECT * FROM ${certificates} WHERE batch_record_id = $1`, [record.batchRecordId])).rows;
    if (rows.length !== 1) throw new Error("COMMITTED batch is missing its persisted QC");
    const q = rows[0];
    const statement = { protocolVersion: String(q.protocol_version), sourceDomain: q.source_domain,
      sourceGateway: q.source_gateway, epoch: q.epoch, batchId: q.batch_id, messageRoot: q.message_root,
      proposalDigest: q.proposal_digest, committeeDigest: q.committee_digest };
    const signatures = (await client.query(`SELECT * FROM ${certificateSignatures}
      WHERE batch_record_id = $1 ORDER BY voter_identity`, [record.batchRecordId])).rows;
    const commits = signatures.map((row) => ({ messageType: "COMMIT", ...statement,
      voterIdentity: row.voter_identity, commitDigest: row.commit_digest, signature: row.signature }));
    return verifyQuorumCertificate({ messageType: "QUORUM_CERTIFICATE", ...statement,
      qcDigest: q.qc_digest, commits }, certificateOptions(record));
  }

  async function transaction(operation, { lockScope = true } = {}) {
    const client = await pool.connect();
    let discarded = false;
    try {
      await client.query("BEGIN");
      if (lockScope) {
        const cursor = await client.query(
          `SELECT next_block FROM ${cursors}
            WHERE chain_domain = $1 AND source_gateway = $2 FOR UPDATE`,
          scopeParameters,
        );
        if (cursor.rowCount !== 1) {
          throw new Error("source cursor is required before batch lifecycle operations");
        }
      }
      const result = await operation(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch (rollbackError) {
        client.release(rollbackError);
        discarded = true;
        throw error;
      }
      throw error;
    } finally {
      // A failed rollback already released and discarded the interrupted client.
      if (!discarded) {
        client.release();
      }
    }
  }

  async function readRecord(client, batchRecordId, lock = "FOR UPDATE") {
    const id = databaseId(batchRecordId, "batch record ID");
    const result = await client.query(
      `SELECT * FROM ${batches}
        WHERE batch_record_id = $1 AND source_domain = $2 AND source_gateway = $3 ${lock}`,
      [id, ...scopeParameters],
    );
    if (result.rowCount !== 1) {
      throw new Error("batch record does not exist in the configured source scope");
    }
    return result.rows[0];
  }

  async function ensureBuilding(client, initialEpoch) {
    const history = await client.query(
      `SELECT * FROM ${batches} WHERE source_domain = $1 AND source_gateway = $2
        ORDER BY epoch DESC`,
      scopeParameters,
    );
    const latest = history.rows[0];
    if (initialEpoch !== undefined && latest !== undefined) {
      const firstEpoch = normalizeBatchEpoch(history.rows.at(-1).epoch);
      if (normalizeBatchEpoch(initialEpoch) !== firstEpoch) {
        throw new Error("initial epoch does not match persisted batch history");
      }
    }
    if (latest?.status === BATCH_STATUS.BUILDING) {
      return readRecord(client, latest.batch_record_id);
    }
    const epoch = latest === undefined ? normalizeBatchEpoch(initialEpoch) : nextBatchEpoch(latest.epoch);
    const inserted = await client.query(
      `INSERT INTO ${batches} (source_domain, source_gateway, epoch, version)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [...scopeParameters, epoch.toString(), Number(MESSAGE_BATCH_VERSION)],
    );
    return inserted.rows[0];
  }

  async function readMembership(client, row) {
    const result = await client.query(
      `SELECT s.*, m.message_id AS assigned_message_id, m.canonical_position
         FROM ${members} m JOIN ${sources} s ON s.id = m.source_message_id
        WHERE m.batch_record_id = $1
        ORDER BY m.canonical_position ASC NULLS LAST, s.id ASC
        FOR SHARE OF s`,
      [row.batch_record_id],
    );
    return result.rows;
  }

  function validateMembers(rows) {
    return rows.map((row) => {
      const message = normalizeBatchMessage(databaseRowToBatchMessage(row), protocolScope);
      if (normalizeBytes32(row.assigned_message_id, "assigned message ID") !== message.messageId) {
        throw new Error("persisted membership message ID differs from its source occurrence");
      }
      return message;
    });
  }

  async function snapshot(client, row) {
    const record = lifecycleRecord(row);
    if (record.version !== MESSAGE_BATCH_VERSION) {
      throw new Error("persisted batch version mismatch");
    }
    const rows = await readMembership(client, row);
    const messages = validateMembers(rows);
    const persistedMembers = Object.freeze(rows.map((member) => Object.freeze({
      sourceMessageId: member.id,
      messageId: normalizeBytes32(member.assigned_message_id, "assigned message ID"),
      position: member.canonical_position === null ? null : BigInt(member.canonical_position),
    })));

    if (record.status === BATCH_STATUS.BUILDING) {
      if (
        record.batchId !== null || record.messageRoot !== null || record.messageCount !== null ||
        persistedMembers.some((member) => member.position !== null)
      ) {
        throw new Error("BUILDING batch contains a partial sealed snapshot");
      }
      return Object.freeze({ record, members: persistedMembers, batch: null, tree: null });
    }

    if (![BATCH_STATUS.SEALED, BATCH_STATUS.CONSENSUS_PENDING, BATCH_STATUS.COMMITTED].includes(record.status)) {
      throw new Error("unknown persisted batch lifecycle status");
    }
    const batch = buildMessageBatch({ ...protocolScope, epoch: record.epoch, messages });
    if (batch === undefined || record.messageCount !== BigInt(messages.length)) {
      throw new Error("sealed batch membership count mismatch");
    }
    for (let index = 0; index < rows.length; index += 1) {
      if (persistedMembers[index].position !== BigInt(index) || messages[index].messageId !== batch.messageIds[index]) {
        throw new Error("sealed batch member positions or canonical order mismatch");
      }
    }
    validateMessageBatch({ ...batch, batchId: record.batchId });
    const tree = buildMessageMerkleTree(batch);
    if (normalizeBytes32(record.messageRoot, "persisted Message Root") !== tree.messageRoot) {
      throw new Error("persisted sealed Message Root mismatch");
    }
    if (record.status === BATCH_STATUS.COMMITTED) {
      const quorumCertificate = await readCertificate(client, record);
      return Object.freeze({ record, members: persistedMembers, batch, tree, quorumCertificate });
    }
    const orphan = await client.query(`SELECT batch_record_id FROM ${certificates} WHERE batch_record_id = $1`, [record.batchRecordId]);
    if (orphan.rowCount) throw new Error("persisted QC exists without a COMMITTED batch");
    return Object.freeze({ record, members: persistedMembers, batch, tree });
  }

  async function assign(client, row, sourceMessageIds) {
    if (row.status !== BATCH_STATUS.BUILDING) {
      throw new Error("members can only be assigned to a BUILDING batch");
    }
    if (!Array.isArray(sourceMessageIds)) {
      throw new Error("source message IDs must be an array");
    }
    const eligible = await createFinalityStore(client, config.databaseSchema).listBatchEligibleMessages(scope);
    const eligibleById = new Map(eligible.map((message) => [message.id, message]));
    let assignedCount = 0;
    for (const value of sourceMessageIds) {
      const id = databaseId(value, "source message ID");
      const source = eligibleById.get(id);
      if (source === undefined) {
        throw new Error("source occurrence must be FINALIZED in the configured scope");
      }
      const message = normalizeBatchMessage(databaseRowToBatchMessage(source), protocolScope);
      const existing = await client.query(
        `SELECT batch_record_id, message_id FROM ${members} WHERE source_message_id = $1`,
        [id],
      );
      if (existing.rowCount !== 0) {
        if (existing.rows[0].batch_record_id !== row.batch_record_id) {
          throw new Error("source occurrence already belongs to another lifecycle batch");
        }
        if (existing.rows[0].message_id !== message.messageId) {
          throw new Error("existing batch membership is inconsistent");
        }
        continue;
      }
      await client.query(
        `INSERT INTO ${members} (batch_record_id, source_message_id, message_id) VALUES ($1, $2, $3)`,
        [row.batch_record_id, id, message.messageId],
      );
      assignedCount += 1;
    }
    return assignedCount;
  }

  function checkExpectations(result, expectedBatchId, expectedMessageRoot) {
    if (expectedBatchId !== undefined && normalizeBytes32(expectedBatchId, "expected batch ID") !== result.batch.batchId) {
      throw new Error("sealed batch ID does not match caller expectation");
    }
    if (expectedMessageRoot !== undefined && normalizeBytes32(expectedMessageRoot, "expected Message Root") !== result.tree.messageRoot) {
      throw new Error("sealed Message Root does not match caller expectation");
    }
  }

  return {
    async commitWithCertificate({ certificate }) {
      const id = normalizeBytes32(certificate?.batchId, "QC batch ID");
      return transaction(async (client) => {
        const result = await client.query(`SELECT * FROM ${batches}
          WHERE batch_id = $1 AND source_domain = $2 AND source_gateway = $3 FOR UPDATE`, [id, ...scopeParameters]);
        if (result.rowCount !== 1) throw new QuorumCertificateError("QC_BATCH_NOT_FOUND");
        const row = result.rows[0];
        if (![BATCH_STATUS.CONSENSUS_PENDING, BATCH_STATUS.COMMITTED].includes(row.status)) {
          throw new QuorumCertificateError("QC_REQUIRES_PENDING_BATCH");
        }
        const existing = await snapshot(client, row);
        const verified = await verifyQuorumCertificate(certificate, certificateOptions(existing.record));
        if (row.status === BATCH_STATUS.COMMITTED) {
          if (existing.quorumCertificate.qcDigest !== verified.qcDigest) throw new Error("conflicting QC for COMMITTED batch");
          return existing;
        }
        await client.query(`INSERT INTO ${certificates}
          (batch_record_id, protocol_version, source_domain, source_gateway, epoch, batch_id,
           message_root, proposal_digest, committee_digest, qc_digest)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [row.batch_record_id, Number(verified.protocolVersion), verified.sourceDomain, verified.sourceGateway,
          verified.epoch, verified.batchId, verified.messageRoot, verified.proposalDigest, verified.committeeDigest, verified.qcDigest]);
        for (const vote of verified.commits) {
          await client.query(`INSERT INTO ${certificateSignatures}
            (batch_record_id, voter_identity, commit_digest, signature) VALUES ($1,$2,$3,$4)`,
          [row.batch_record_id, vote.voterIdentity, vote.commitDigest, vote.signature]);
        }
        await afterCertificatePersisted();
        const updated = await client.query(`UPDATE ${batches}
          SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP
          WHERE batch_record_id = $1 AND status = 'CONSENSUS_PENDING' RETURNING *`, [row.batch_record_id]);
        if (updated.rowCount !== 1) throw new Error("QC commit did not transition exactly one pending batch");
        return snapshot(client, updated.rows[0]);
      }, { lockScope: false });
    },

    async getOrCreateBuilding({ initialEpoch } = {}) {
      return transaction(async (client) => snapshot(client, await ensureBuilding(client, initialEpoch)));
    },

    async collectEligible({ initialEpoch } = {}) {
      return transaction(async (client) => {
        const row = await ensureBuilding(client, initialEpoch);
        const eligible = await createFinalityStore(client, config.databaseSchema).listBatchEligibleMessages(scope);
        const claimed = await client.query(
          `SELECT m.source_message_id FROM ${members} m
            JOIN ${batches} b ON b.batch_record_id = m.batch_record_id
           WHERE b.source_domain = $1 AND b.source_gateway = $2`,
          scopeParameters,
        );
        const claimedIds = new Set(claimed.rows.map((member) => member.source_message_id));
        const available = eligible.filter((source) => !claimedIds.has(source.id)).map((source) => source.id);
        const assignedCount = await assign(client, row, available);
        return { snapshot: await snapshot(client, row), assignedCount };
      });
    },

    async assignMessages({ batchRecordId, sourceMessageIds }) {
      return transaction(async (client) => {
        const row = await readRecord(client, batchRecordId);
        const assignedCount = await assign(client, row, sourceMessageIds);
        return { snapshot: await snapshot(client, row), assignedCount };
      });
    },

    async sealBatch({ batchRecordId, expectedBatchId, expectedMessageRoot }) {
      return transaction(async (client) => {
        const row = await readRecord(client, batchRecordId);
        if (row.status !== BATCH_STATUS.BUILDING) {
          const existing = await snapshot(client, row);
          checkExpectations(existing, expectedBatchId, expectedMessageRoot);
          return existing;
        }
        const rows = await readMembership(client, row);
        if (rows.some((member) => member.canonical_position !== null)) {
          throw new Error("BUILDING batch contains partial sealed positions");
        }
        const batch = buildMessageBatch({ ...protocolScope, epoch: normalizeBatchEpoch(row.epoch), messages: validateMembers(rows) });
        if (batch === undefined) {
          throw new Error("cannot seal an empty BUILDING batch");
        }
        validateMessageBatch(batch);
        const tree = buildMessageMerkleTree(batch);
        checkExpectations({ batch, tree }, expectedBatchId, expectedMessageRoot);
        const sourceIdsByMessageId = new Map(rows.map((member) => [member.message_id, member.id]));
        for (let index = 0; index < batch.messageIds.length; index += 1) {
          const positioned = await client.query(
            `UPDATE ${members} SET canonical_position = $3
              WHERE batch_record_id = $1 AND source_message_id = $2`,
            [row.batch_record_id, sourceIdsByMessageId.get(batch.messageIds[index]), index.toString()],
          );
          if (positioned.rowCount !== 1) {
            throw new Error("batch seal did not position exactly one assigned occurrence");
          }
        }
        validateBatchTransition(row.status, BATCH_STATUS.SEALED);
        const sealed = await client.query(
          `UPDATE ${batches} SET status = 'SEALED', batch_id = $2, message_root = $3,
                  message_count = $4, sealed_at = CURRENT_TIMESTAMP
            WHERE batch_record_id = $1 AND status = 'BUILDING' RETURNING *`,
          [row.batch_record_id, batch.batchId, tree.messageRoot, batch.messages.length.toString()],
        );
        if (sealed.rowCount !== 1) {
          throw new Error("batch seal did not update exactly one BUILDING record");
        }
        return snapshot(client, sealed.rows[0]);
      });
    },

    async readBatch({ batchRecordId }) {
      return transaction(async (client) => snapshot(client, await readRecord(client, batchRecordId, "FOR SHARE")), { lockScope: false });
    },

    async markConsensusPending({ batchRecordId }) {
      return transaction(async (client) => {
        const row = await readRecord(client, batchRecordId);
        validateBatchTransition(row.status, BATCH_STATUS.CONSENSUS_PENDING);
        const existing = await snapshot(client, row);
        if (row.status === BATCH_STATUS.CONSENSUS_PENDING) {
          return existing;
        }
        const updated = await client.query(
          `UPDATE ${batches} SET status = 'CONSENSUS_PENDING', consensus_pending_at = CURRENT_TIMESTAMP
            WHERE batch_record_id = $1 AND status = 'SEALED' RETURNING *`,
          [row.batch_record_id],
        );
        if (updated.rowCount !== 1) {
          throw new Error("consensus-pending transition did not update exactly one SEALED record");
        }
        return snapshot(client, updated.rows[0]);
      });
    },
  };
}
