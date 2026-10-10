import { readFile, readdir } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import pg from "pg";
import { tableName } from "../../indexer/src/db.mjs";
import { validateSchemaName } from "../../indexer/src/config.mjs";
import { canonicalCommittee, committeeDigest, protocolInteger } from "./committee.mjs";
import { authenticatePrePrepare, PrePrepareError } from "./pre-prepare.mjs";
import { authenticatePrepare, PrepareError, signPrepare } from "./prepare.mjs";
import { normalizeAddress } from "../../indexer/src/canonical-message.mjs";
import { authenticateCommit, COMMIT_STATEMENT_FIELDS, CommitError, signCommit } from "./commit.mjs";
import { buildPreparedCertificate, sameProposal, ViewChangeError } from "./prepared-certificate.mjs";
import { authenticateNewView, authenticateViewChange, signViewChange } from "./view-change.mjs";
import { buildQuorumCertificate, expectedCommitStatement, qcDigest } from "./quorum-certificate.mjs";

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
  const prepareVotes = tableName(config.databaseSchema, "pbft_prepare_votes");
  const preparedStates = tableName(config.databaseSchema, "pbft_prepared_states");
  const prepareRejections = tableName(config.databaseSchema, "prepare_rejections");
  const commitVotes = tableName(config.databaseSchema, "pbft_commit_votes");
  const commitQuorums = tableName(config.databaseSchema, "pbft_commit_quorums");
  const commitRejections = tableName(config.databaseSchema, "commit_rejections");
  const epochViews = tableName(config.databaseSchema, "pbft_epoch_views");
  const viewVotes = tableName(config.databaseSchema, "pbft_view_change_votes");
  const newViews = tableName(config.databaseSchema, "pbft_new_views");
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
        messageType: "PRE_PREPARE", protocolVersion: String(row.protocol_version), ...(row.protocol_version === 2 ? { view: row.view } : {}), sourceDomain: config.chainDomain.toString(),
        sourceGateway: config.sourceGateway, epoch: row.epoch, batchId: row.batch_id, messageRoot: row.message_root,
        primaryIdentity: row.primary_identity, proposalDigest: row.proposal_digest, signature: row.primary_signature,
      } };
  }

  function prepareVoteRecord(row) {
    if (!row) return null;
    return {
      messageType: "PREPARE", protocolVersion: String(row.protocol_version), ...(row.protocol_version === 2 ? { view: row.view } : {}), sourceDomain: row.source_domain,
      sourceGateway: row.source_gateway, epoch: row.epoch, batchId: row.batch_id,
      messageRoot: row.message_root, proposalDigest: row.proposal_digest,
      voterIdentity: row.voter_identity, prepareDigest: row.prepare_digest,
      signature: row.voter_signature,
    };
  }

  function preparedRecord(row) {
    if (!row) return null;
    return { validatorAddress: row.local_validator_identity, epoch: row.epoch, view: row.view, batchId: row.batch_id,
      messageRoot: row.message_root, proposalDigest: row.proposal_digest,
      quorumVoters: row.quorum_voters, preparedAt: row.prepared_at.toISOString() };
  }

  async function prepareResult(client, epoch, voterIdentity, view = "0") {
    const normalizedEpoch = protocolInteger(epoch).toString();
    let vote = null;
    if (voterIdentity !== undefined) {
      const voter = normalizeAddress(voterIdentity);
      vote = prepareVoteRecord((await client.query(`SELECT * FROM ${prepareVotes}
        WHERE local_validator_identity = $1 AND epoch = $2 AND voter_identity = $3 AND view = $4 AND protocol_version = 2`,
      [config.validatorAddress, normalizedEpoch, voter, view])).rows[0]);
      if (!vote) return null;
    }
    const votes = (await client.query(`SELECT * FROM ${prepareVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2 ORDER BY voter_identity`,
    [config.validatorAddress, normalizedEpoch, view])).rows.map(prepareVoteRecord);
    const prepared = preparedRecord((await client.query(`SELECT * FROM ${preparedStates}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`,
    [config.validatorAddress, normalizedEpoch, view])).rows[0]);
    if (prepared) {
      const quorumVoters = prepared.quorumVoters;
      const persistedVoters = new Set(votes.map((entry) => entry.voterIdentity));
      if (!Array.isArray(quorumVoters) || quorumVoters.length !== 3 ||
          new Set(quorumVoters).size !== 3 || quorumVoters.some((voter) => !persistedVoters.has(voter))) {
        throw new Error("invalid persisted PREPARED quorum evidence");
      }
    }
    return voterIdentity === undefined
      ? { validatorAddress: config.validatorAddress, epoch: normalizedEpoch, view, voteCount: votes.length, votes, prepared }
      : { vote, voteCount: votes.length, prepared };
  }

  async function requirePrepared(client, epoch, view = "0") {
    const accepted = proposalRecord((await client.query(`SELECT * FROM ${prepares}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`, [config.validatorAddress, epoch, view])).rows[0]);
    if (!accepted) throw new CommitError("NOT_PREPARED");
    await authenticatePrePrepare(config, accepted.envelope);
    const state = await prepareResult(client, epoch, undefined, view);
    if (!state.prepared) throw new CommitError("NOT_PREPARED");
    const statement = expectedCommitStatement(accepted.envelope, config.peers);
    if (state.prepared.batchId !== statement.batchId || state.prepared.messageRoot !== statement.messageRoot ||
        state.prepared.proposalDigest !== statement.proposalDigest) throw new CommitError("WRONG_PREPARED_PROPOSAL");
    for (const vote of state.votes) {
      const verified = await authenticatePrepare(config, vote);
      if (["epoch", "view", "batchId", "messageRoot", "proposalDigest"].some((field) => verified[field] !== statement[field])) {
        throw new CommitError("WRONG_PREPARED_PROPOSAL");
      }
    }
    return statement;
  }

  function commitVoteRecord(row) {
    return { messageType: "COMMIT", protocolVersion: String(row.protocol_version), ...(row.protocol_version === 2 ? { view: row.view } : {}), sourceDomain: row.source_domain,
      sourceGateway: row.source_gateway, epoch: row.epoch, batchId: row.batch_id,
      messageRoot: row.message_root, proposalDigest: row.proposal_digest, committeeDigest: row.committee_digest,
      voterIdentity: row.voter_identity, commitDigest: row.commit_digest, signature: row.voter_signature };
  }

  async function commitResult(client, epoch, view = "0") {
    const rows = (await client.query(`SELECT * FROM ${commitVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2 ORDER BY voter_identity`, [config.validatorAddress, epoch, view])).rows;
    const votes = await Promise.all(rows.map((row) => authenticateCommit(config, commitVoteRecord(row))));
    const row = (await client.query(`SELECT * FROM ${commitQuorums}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`, [config.validatorAddress, epoch, view])).rows[0];
    let quorum = null;
    let certificate = null;
    if (votes.length || row) {
      const statement = await requirePrepared(client, epoch, view);
      if (votes.some((vote) => COMMIT_STATEMENT_FIELDS.some((field) => vote[field] !== statement[field]))) {
        throw new Error("persisted COMMIT does not match PREPARED statement");
      }
      if (votes.length >= 3 && !row) throw new Error("durable COMMIT quorum state missing");
      if (row) {
        const voters = row.quorum_voters;
        if (!Array.isArray(voters) || voters.length !== 3 || new Set(voters).size !== 3 ||
            voters.some((voter) => !votes.some((vote) => vote.voterIdentity === voter)) ||
            row.qc_digest !== qcDigest(statement) || row.committee_digest !== statement.committeeDigest ||
            row.batch_id !== statement.batchId || row.message_root !== statement.messageRoot ||
            row.proposal_digest !== statement.proposalDigest) throw new Error("invalid persisted COMMIT quorum");
        certificate = await buildQuorumCertificate(votes.filter((vote) => voters.includes(vote.voterIdentity)),
          { peers: config.peers, expected: statement });
        quorum = { validatorAddress: config.validatorAddress, status: "COMMIT_QUORUM", ...statement,
          qcDigest: row.qc_digest, quorumVoters: voters, reachedAt: row.reached_at.toISOString() };
      }
    }
    return { validatorAddress: config.validatorAddress, epoch, view, voteCount: votes.length, votes, quorum, certificate };
  }

  async function persistCommit(client, vote) {
    await assertActive(client, vote.epoch, vote.view, CommitError);
    const statement = await requirePrepared(client, vote.epoch, vote.view);
    const existing = (await client.query(`SELECT * FROM ${commitVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND voter_identity = $3 AND view = $4 AND protocol_version = 2`,
    [config.validatorAddress, vote.epoch, vote.voterIdentity, vote.view])).rows[0];
    if (existing && existing.commit_digest !== vote.commitDigest) throw new CommitError("CONFLICTING_COMMIT");
    const mismatchReasons = { protocolVersion: "WRONG_VERSION", sourceDomain: "WRONG_CONTEXT",
      sourceGateway: "WRONG_CONTEXT", epoch: "WRONG_EPOCH", view: "WRONG_VIEW", batchId: "WRONG_BATCH_ID",
      messageRoot: "WRONG_ROOT", proposalDigest: "WRONG_PROPOSAL", committeeDigest: "WRONG_COMMITTEE" };
    for (const field of COMMIT_STATEMENT_FIELDS) {
      if (vote[field] !== statement[field]) throw new CommitError(mismatchReasons[field]);
    }
    if (!existing) {
      await client.query(`INSERT INTO ${commitVotes}
        (local_validator_identity, voter_identity, epoch, source_domain, source_gateway, batch_id, message_root,
         proposal_digest, committee_digest, commit_digest, voter_signature, view, protocol_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,2)`,
      [config.validatorAddress, vote.voterIdentity, vote.epoch, vote.sourceDomain, vote.sourceGateway, vote.batchId,
        vote.messageRoot, vote.proposalDigest, vote.committeeDigest, vote.commitDigest, vote.signature, vote.view]);
      await progress(client, vote.epoch);
    }
    const voters = (await client.query(`SELECT voter_identity FROM ${commitVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2 ORDER BY voter_identity`, [config.validatorAddress, vote.epoch, vote.view])).rows;
    if (voters.length >= 3) {
      await client.query(`INSERT INTO ${commitQuorums}
        (local_validator_identity, epoch, batch_id, message_root, proposal_digest, committee_digest, qc_digest, quorum_voters, view, protocol_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,2) ON CONFLICT (local_validator_identity, epoch, view, protocol_version) DO NOTHING`,
      [config.validatorAddress, vote.epoch, vote.batchId, vote.messageRoot, vote.proposalDigest,
        committeeDigest(config.peers), qcDigest(statement), JSON.stringify(voters.slice(0, 3).map((entry) => entry.voter_identity)), vote.view]);
    }
    return commitResult(client, vote.epoch, vote.view);
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

  async function persistPrepare(client, vote) {
        await assertActive(client, vote.epoch, vote.view, PrepareError);
        const accepted = (await client.query(`SELECT * FROM ${prepares}
          WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2 FOR UPDATE`,
        [config.validatorAddress, vote.epoch, vote.view])).rows[0];
        if (!accepted) throw new PrepareError("PRE_PREPARE_REQUIRED");
        if (accepted.batch_id !== vote.batchId) throw new PrepareError("WRONG_BATCH_ID");
        if (accepted.message_root !== vote.messageRoot) throw new PrepareError("WRONG_ROOT");
        if (accepted.proposal_digest !== vote.proposalDigest) throw new PrepareError("WRONG_PROPOSAL");
        const existing = (await client.query(`SELECT * FROM ${prepareVotes}
          WHERE local_validator_identity = $1 AND epoch = $2 AND voter_identity = $3 AND view = $4 AND protocol_version = 2 FOR UPDATE`,
        [config.validatorAddress, vote.epoch, vote.voterIdentity, vote.view])).rows[0];
        if (existing && existing.prepare_digest !== vote.prepareDigest) throw new PrepareError("CONFLICTING_PREPARE");
        if (!existing) {
          await client.query(`INSERT INTO ${prepareVotes}
            (local_validator_identity, voter_identity, epoch, source_domain, source_gateway, batch_id,
             message_root, proposal_digest, prepare_digest, voter_signature, view, protocol_version)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 2)`,
          [config.validatorAddress, vote.voterIdentity, vote.epoch, vote.sourceDomain, vote.sourceGateway,
            vote.batchId, vote.messageRoot, vote.proposalDigest, vote.prepareDigest, vote.signature, vote.view]);
          await progress(client, vote.epoch);
        }
        const matching = (await client.query(`SELECT voter_identity FROM ${prepareVotes}
          WHERE local_validator_identity = $1 AND epoch = $2 AND batch_id = $3
            AND message_root = $4 AND proposal_digest = $5 AND view = $6 AND protocol_version = 2 ORDER BY voter_identity`,
        [config.validatorAddress, vote.epoch, vote.batchId, vote.messageRoot, vote.proposalDigest, vote.view])).rows;
        if (matching.length >= 3) {
          const quorumVoters = matching.slice(0, 3).map((row) => row.voter_identity);
          await client.query(`INSERT INTO ${preparedStates}
            (local_validator_identity, epoch, batch_id, message_root, proposal_digest, quorum_voters, view, protocol_version)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 2)
            ON CONFLICT (local_validator_identity, epoch, view, protocol_version) DO NOTHING`,
          [config.validatorAddress, vote.epoch, vote.batchId, vote.messageRoot, vote.proposalDigest,
            JSON.stringify(quorumVoters), vote.view]);
        }
        const result = await prepareResult(client, vote.epoch, vote.voterIdentity, vote.view);
        if (!result || result.vote.prepareDigest !== vote.prepareDigest) {
          throw new PrepareError("CONFLICTING_PREPARE");
        }
        if (result.prepared && (result.prepared.batchId !== vote.batchId ||
            result.prepared.messageRoot !== vote.messageRoot ||
            result.prepared.proposalDigest !== vote.proposalDigest)) {
          throw new Error("invalid persisted PREPARED state");
        }
        return result;

  }

  async function currentView(client, epoch) {
    const row = (await client.query(`SELECT current_view FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`,
      [config.validatorAddress, protocolInteger(epoch).toString()])).rows[0];
    return row?.current_view ?? "0";
  }
  async function ensureEpoch(client, proposal) {
    await client.query(`INSERT INTO ${epochViews} (local_validator_identity,epoch,batch_id,message_root)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [config.validatorAddress, proposal.epoch, proposal.batchId, proposal.messageRoot]);
  }
  async function assertSafe(client, proposal, ErrorType) {
    const row = (await client.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`,
      [config.validatorAddress, proposal.epoch])).rows[0];
    if (row && (row.batch_id !== proposal.batchId || row.message_root !== proposal.messageRoot)) throw new ErrorType(ErrorType === PrePrepareError ? "CONFLICTING_PRE_PREPARE" : "UNSAFE_SELECTED_PROPOSAL");
  }
  async function assertActive(client, epoch, view, ErrorType, allowFinalizedDuplicate = false) {
    const row = (await client.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`,
      [config.validatorAddress, epoch])).rows[0];
    const current = row?.current_view ?? "0";
    if (protocolInteger(view, "view").toString() !== current) throw new ErrorType(BigInt(view) < BigInt(current) ? "STALE_VIEW" : "NEW_VIEW_REQUIRED");
    if (row?.finalized && !allowFinalizedDuplicate) throw new ErrorType("ALREADY_COMMITTED");
    if (row?.changing_view) throw new ErrorType("VIEW_CHANGE_IN_PROGRESS");
  }
  async function assertCommitLock(client, epoch) {
    const row = (await client.query(`SELECT batch_id,message_root FROM ${epochViews}
      WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, epoch])).rows[0];
    const locks = (await client.query(`SELECT batch_id,message_root FROM ${commitVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND voter_identity = $1`, [config.validatorAddress, epoch])).rows;
    if (locks.some((lock) => !row || lock.batch_id !== row.batch_id || lock.message_root !== row.message_root)) throw new CommitError("DOUBLE_COMMIT");
  }
  async function progress(client, epoch) {
    await client.query(`UPDATE ${epochViews} SET progress_at = CURRENT_TIMESTAMP, progress_revision = progress_revision + 1
      WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, epoch]);
  }
  async function highestPrepared(client, epoch) {
    const rows = (await client.query(`SELECT * FROM ${preparedStates}
      WHERE local_validator_identity = $1 AND epoch = $2 ORDER BY view DESC,protocol_version DESC LIMIT 1`,
      [config.validatorAddress, epoch])).rows;
    if (!rows.length) return null;
    const row = rows[0];
    const proposal = proposalRecord((await client.query(`SELECT * FROM ${prepares}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = $4`,
      [config.validatorAddress, epoch, row.view, row.protocol_version])).rows[0])?.envelope;
    const votes = (await client.query(`SELECT * FROM ${prepareVotes}
      WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = $4 ORDER BY voter_identity`,
      [config.validatorAddress, epoch, row.view, row.protocol_version])).rows.map(prepareVoteRecord);
    return buildPreparedCertificate(proposal, votes.filter((vote) => row.quorum_voters.includes(vote.voterIdentity)), config);
  }

  return {
    async registerEpoch(proposal) {
      return transaction(async (client) => { await checkState(client, "FOR UPDATE"); await ensureEpoch(client, proposal); await assertSafe(client, proposal, ViewChangeError); });
    },
    async readViewStates() {
      await checkState(pool);
      return (await pool.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 ORDER BY epoch`, [config.validatorAddress])).rows;
    },
    async currentView(epoch) { await checkState(pool); return currentView(pool, epoch); },
    async checkSafeProposal(proposal) { await checkState(pool); return assertSafe(pool, proposal, ViewChangeError); },
    async checkActive(epoch, view, ErrorType = ViewChangeError) {
      await checkState(pool); return assertActive(pool, protocolInteger(epoch).toString(), view, ErrorType);
    },
    async preparedCertificate(epoch) {
      return transaction(async (client) => { await checkState(client, "FOR SHARE"); return highestPrepared(client, protocolInteger(epoch).toString()); });
    },
    async castViewChange(epoch, expected = {}) {
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        epoch = protocolInteger(epoch).toString();
        const state = (await client.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, epoch])).rows[0];
        if (!state || state.finalized) throw new ViewChangeError(state ? "ALREADY_COMMITTED" : "UNKNOWN_EPOCH");
        if (expected.view !== undefined && protocolInteger(expected.view).toString() !== state.current_view) throw new ViewChangeError("STALE_VIEW");
        if ((expected.progressRevision !== undefined && String(expected.progressRevision) !== String(state.progress_revision)) ||
            (expected.targetView !== undefined && protocolInteger(expected.targetView).toString() !== state.target_view)) {
          throw new ViewChangeError("SUPERSEDED_TIMEOUT");
        }
        let targetView = state.changing_view ? state.target_view : protocolInteger(BigInt(state.current_view) + 1n).toString();
        if (expected.now !== undefined) {
          if (!Number.isFinite(expected.now)) throw new ViewChangeError("MALFORMED_TIMEOUT");
          const deadline = new Date(state.changing_view ? state.view_change_at : state.progress_at).getTime() + config.viewTimeoutMs;
          if (expected.now < deadline) throw new ViewChangeError("SUPERSEDED_TIMEOUT");
          if (state.changing_view) targetView = protocolInteger(BigInt(targetView) + 1n).toString();
        }
        const previous = (await client.query(`SELECT envelope FROM ${viewVotes} WHERE local_validator_identity = $1 AND epoch = $2 AND target_view = $3 AND voter_identity = $1`,
          [config.validatorAddress, epoch, targetView])).rows[0];
        if (previous) return authenticateViewChange(config, previous.envelope);
        const accepted = proposalRecord((await client.query(`SELECT * FROM ${prepares}
          WHERE local_validator_identity = $1 AND epoch = $2 ORDER BY view DESC,protocol_version DESC LIMIT 1`, [config.validatorAddress, epoch])).rows[0]);
        const vote = await signViewChange(config, { epoch, targetView, acceptedProposal: accepted?.envelope ?? null,
          preparedCertificate: await highestPrepared(client, epoch) });
        await client.query(`INSERT INTO ${viewVotes}
          (local_validator_identity,epoch,target_view,voter_identity,digest,envelope) VALUES ($1,$2,$3,$4,$5,$6::jsonb)`,
          [config.validatorAddress, epoch, targetView, config.validatorAddress, vote.viewChangeDigest, JSON.stringify(vote)]);
        await client.query(`UPDATE ${epochViews} SET changing_view = true,target_view = $3,
          view_change_at = COALESCE($4::timestamptz,CURRENT_TIMESTAMP)
          WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, epoch, targetView,
            expected.now === undefined ? null : new Date(expected.now)]);
        return vote;
      });
    },
    async saveViewChange(input) {
      const vote = await authenticateViewChange(config, input);
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        const state = (await client.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, vote.epoch])).rows[0];
        if (!state || state.finalized) throw new ViewChangeError(state ? "ALREADY_COMMITTED" : "UNKNOWN_EPOCH");
        if (BigInt(vote.targetView) <= BigInt(state.current_view)) throw new ViewChangeError("STALE_VIEW");
        const nextTarget = (BigInt(state.target_view) > BigInt(state.current_view) ? BigInt(state.target_view) : BigInt(state.current_view) + 1n) + 1n;
        if (BigInt(vote.targetView) > nextTarget) throw new ViewChangeError("WRONG_TARGET_VIEW");
        await client.query(`INSERT INTO ${viewVotes} VALUES ($1,$2,$3,$4,$5,$6::jsonb) ON CONFLICT DO NOTHING`,
          [config.validatorAddress, vote.epoch, vote.targetView, vote.voterIdentity, vote.viewChangeDigest, JSON.stringify(vote)]);
        const row = (await client.query(`SELECT * FROM ${viewVotes} WHERE local_validator_identity = $1 AND epoch = $2 AND target_view = $3 AND voter_identity = $4`,
          [config.validatorAddress, vote.epoch, vote.targetView, vote.voterIdentity])).rows[0];
        if (row.digest !== vote.viewChangeDigest) throw new ViewChangeError("CONFLICTING_VIEW_CHANGE");
        return row.envelope;
      });
    },
    async readViewChanges(epoch, targetView) {
      await checkState(pool);
      const rows = (await pool.query(`SELECT envelope FROM ${viewVotes}
        WHERE local_validator_identity = $1 AND epoch = $2 AND target_view = $3 ORDER BY voter_identity`,
        [config.validatorAddress, protocolInteger(epoch).toString(), protocolInteger(targetView).toString()])).rows;
      return Promise.all(rows.map((row) => authenticateViewChange(config, row.envelope)));
    },
    async readViewChangeTargets(epoch) {
      await checkState(pool);
      return (await pool.query(`SELECT target_view FROM ${viewVotes} WHERE local_validator_identity = $1 AND epoch = $2
        GROUP BY target_view HAVING COUNT(*) >= 3 ORDER BY target_view DESC`, [config.validatorAddress, protocolInteger(epoch).toString()])).rows.map((row) => row.target_view);
    },
    async readLatestIssuedNewView(epoch) {
      await checkState(pool);
      return (await pool.query(`SELECT envelope FROM ${newViews} WHERE local_validator_identity = $1 AND epoch = $2
        AND envelope->>'primaryIdentity' = $1 ORDER BY view DESC LIMIT 1`,
        [config.validatorAddress, protocolInteger(epoch).toString()])).rows[0]?.envelope ?? null;
    },
    async readNewView(epoch, view) {
      await checkState(pool);
      const row = (await pool.query(`SELECT envelope FROM ${newViews} WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3`,
        [config.validatorAddress, protocolInteger(epoch).toString(), protocolInteger(view).toString()])).rows[0];
      return row?.envelope ?? null;
    },
    async acceptNewView(input, pendingProposal) {
      const message = await authenticateNewView(config, input, pendingProposal);
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await ensureEpoch(client, message.selectedProposal);
        await assertSafe(client, message.selectedProposal, ViewChangeError);
        const state = (await client.query(`SELECT * FROM ${epochViews} WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, message.epoch])).rows[0];
        if (state.finalized) throw new ViewChangeError("ALREADY_COMMITTED");
        const existing = (await client.query(`SELECT * FROM ${newViews} WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3`,
          [config.validatorAddress, message.epoch, message.view])).rows[0];
        if (existing && existing.digest !== message.newViewDigest) throw new ViewChangeError("CONFLICTING_NEW_VIEW");
        if (BigInt(message.view) < BigInt(state.current_view)) throw new ViewChangeError("STALE_VIEW");
        if (message.view === state.current_view) { if (!existing) throw new ViewChangeError("MISSING_NEW_VIEW"); return existing.envelope; }
        const prepared = await highestPrepared(client, message.epoch);
        if (prepared && !sameProposal(prepared.proposal, message.selectedProposal)) throw new ViewChangeError("UNSAFE_SELECTED_PROPOSAL");
        await assertCommitLock(client, message.epoch);
        await client.query(`INSERT INTO ${newViews} VALUES ($1,$2,$3,$4,$5::jsonb)`,
          [config.validatorAddress, message.epoch, message.view, message.newViewDigest, JSON.stringify(message)]);
        await client.query(`UPDATE ${epochViews} SET current_view = $3, target_view = GREATEST(target_view,$3), changing_view = target_view > $3,
          progress_at = CURRENT_TIMESTAMP, progress_revision = progress_revision + 1,
          view_change_at = CASE WHEN target_view > $3 THEN view_change_at ELSE NULL END
          WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, message.epoch, message.view]);
        return message;
      });
    },
    async finalizeEpoch(proposal) {
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE"); await ensureEpoch(client, proposal);
        await assertSafe(client, proposal, ViewChangeError);
        await client.query(`UPDATE ${epochViews} SET finalized = true, changing_view = false
          WHERE local_validator_identity = $1 AND epoch = $2`, [config.validatorAddress, proposal.epoch]);
      });
    },
    async readCommitState(epoch, view) {
      return transaction(async (client) => {
        await checkState(client, "FOR SHARE");
        return commitResult(client, protocolInteger(epoch).toString(), view ?? await currentView(client, epoch));
      });
    },

    async readCommitStates() {
      return transaction(async (client) => {
        await checkState(client, "FOR SHARE");
        const epochs = (await client.query(`SELECT epoch, view FROM ${prepares}
          WHERE local_validator_identity = $1 AND protocol_version = 2 ORDER BY epoch, view`, [config.validatorAddress])).rows;
        const states = [];
        for (const row of epochs) states.push(await commitResult(client, row.epoch, row.view));
        return states;
      });
    },

    async castCommitVote(epoch, sign = signCommit) {
      return transaction(async (client) => {
        // Serialize the lock check, signature creation, and persistence across processes.
        await checkState(client, "FOR UPDATE");
        const normalized = protocolInteger(epoch).toString();
        const view = await currentView(client, normalized);
        await assertCommitLock(client, normalized);
        const statement = await requirePrepared(client, normalized, view);
        const existing = (await client.query(`SELECT * FROM ${commitVotes}
          WHERE local_validator_identity = $1 AND epoch = $2 AND voter_identity = $3 AND view = $4 AND protocol_version = 2`,
        [config.validatorAddress, normalized, config.validatorAddress, view])).rows[0];
        if (existing) {
          const vote = await authenticateCommit(config, commitVoteRecord(existing));
          if (COMMIT_STATEMENT_FIELDS.some((field) => vote[field] !== statement[field])) throw new CommitError("DOUBLE_COMMIT");
          await assertSafe(client, vote, CommitError);
          await assertActive(client, normalized, view, CommitError, true);
          return commitResult(client, normalized, view);
        }
        await assertActive(client, normalized, view, CommitError);
        const vote = await authenticateCommit(config, await sign(config,
          { messageType: "COMMIT", ...statement, voterIdentity: config.validatorAddress }));
        return persistCommit(client, vote);
      });
    },

    async saveCommitVote(input) {
      const vote = await authenticateCommit(config, input);
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        return persistCommit(client, vote);
      });
    },

    async recordCommitRejection(input, reason) {
      let epoch = null;
      try { epoch = protocolInteger(input?.epoch).toString(); } catch { /* omit malformed values */ }
      const digest = typeof input?.commitDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.commitDigest)
        ? input.commitDigest.toLowerCase() : null;
      const voter = typeof input?.voterIdentity === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.voterIdentity)
        ? input.voterIdentity.toLowerCase() : null;
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await client.query(`INSERT INTO ${commitRejections} (commit_digest, voter_identity, epoch, reason)
          VALUES ($1,$2,$3,$4)`, [digest, voter, epoch, reason]);
      });
    },

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

    async readPrePrepare(epoch, view) {
      await checkState(pool);
      return proposalRecord((await pool.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`,
        [config.validatorAddress, protocolInteger(epoch).toString(), view ?? await currentView(pool, epoch)])).rows[0]);
    },

    async readPrePrepareByDigest(proposalDigest) {
      await checkState(pool);
      return proposalRecord((await pool.query(`SELECT * FROM ${prepares}
        WHERE local_validator_identity = $1 AND proposal_digest = $2 ORDER BY epoch LIMIT 1`,
      [config.validatorAddress, proposalDigest])).rows[0]);
    },

    async readPrePrepares() {
      await checkState(pool);
      return (await pool.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 ORDER BY epoch, view, protocol_version`,
        [config.validatorAddress])).rows.map(proposalRecord);
    },

    async savePrePrepare(input, direction) {
      const p = await authenticatePrePrepare(config, input);
      const expectedDirection = p.primaryIdentity === config.validatorAddress ? "ISSUED" : "ACCEPTED";
      if (direction !== expectedDirection) throw new Error("invalid PRE-PREPARE direction");
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await ensureEpoch(client, p);
        await assertActive(client, p.epoch, p.view, PrePrepareError);
        await assertSafe(client, p, PrePrepareError);
        const inserted = await client.query(`INSERT INTO ${prepares}
          (local_validator_identity, epoch, batch_id, message_root, proposal_digest, primary_identity, primary_signature, direction, view, protocol_version)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 2)
          ON CONFLICT (local_validator_identity, epoch, view, protocol_version) DO NOTHING`,
        [config.validatorAddress, p.epoch, p.batchId, p.messageRoot, p.proposalDigest, p.primaryIdentity, p.signature, direction, p.view]);
        const row = (await client.query(`SELECT * FROM ${prepares} WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`,
          [config.validatorAddress, p.epoch, p.view])).rows[0];
        if (row.proposal_digest !== p.proposalDigest || row.batch_id !== p.batchId ||
            row.message_root !== p.messageRoot || row.primary_identity !== p.primaryIdentity || row.direction !== direction) {
          throw new PrePrepareError("CONFLICTING_PRE_PREPARE");
        }
        if (inserted.rowCount) await progress(client, p.epoch);
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

    async readPrepareVote(epoch, voterIdentity, view) {
      return transaction(async (client) => {
        await checkState(client, "FOR SHARE");
        return prepareResult(client, epoch, voterIdentity, view ?? await currentView(client, epoch));
      });
    },

    async readPrepareState(epoch, view) {
      return transaction(async (client) => {
        await checkState(client, "FOR SHARE");
        return prepareResult(client, epoch, undefined, view ?? await currentView(client, epoch));
      });
    },

    async readPrepareStates() {
      return transaction(async (client) => {
        await checkState(client, "FOR SHARE");
        const epochs = (await client.query(`SELECT epoch, view FROM ${prepares}
          WHERE local_validator_identity = $1 AND protocol_version = 2 ORDER BY epoch, view`, [config.validatorAddress])).rows;
        const states = [];
        for (const row of epochs) states.push(await prepareResult(client, row.epoch, undefined, row.view));
        return states;
      });
    },

    async castPrepareVote(epoch, sign = signPrepare) {
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        epoch = protocolInteger(epoch).toString();
        const view = await currentView(client, epoch);
        await assertActive(client, epoch, view, PrepareError);
        const accepted = proposalRecord((await client.query(`SELECT * FROM ${prepares}
          WHERE local_validator_identity = $1 AND epoch = $2 AND view = $3 AND protocol_version = 2`,
          [config.validatorAddress, epoch, view])).rows[0]);
        if (!accepted) throw new PrepareError("PRE_PREPARE_REQUIRED");
        const existing = await prepareResult(client, epoch, config.validatorAddress, view);
        if (existing) return existing;
        const proposal = accepted.envelope;
        const vote = await authenticatePrepare(config, await sign(config, { messageType: "PREPARE",
          protocolVersion: proposal.protocolVersion, sourceDomain: proposal.sourceDomain, sourceGateway: proposal.sourceGateway,
          epoch, view, batchId: proposal.batchId, messageRoot: proposal.messageRoot,
          proposalDigest: proposal.proposalDigest, voterIdentity: config.validatorAddress }));
        return persistPrepare(client, vote);
      });
    },
    async savePrepareVote(input) {
      const vote = await authenticatePrepare(config, input);
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        return persistPrepare(client, vote);
      });
    },

    async recordPrepareRejection(input, reason) {
      const digest = typeof input?.prepareDigest === "string" && /^0x[0-9a-fA-F]{64}$/.test(input.prepareDigest)
        ? input.prepareDigest.toLowerCase() : null;
      const voter = typeof input?.voterIdentity === "string" && /^0x[0-9a-fA-F]{40}$/.test(input.voterIdentity)
        ? input.voterIdentity.toLowerCase() : null;
      let epoch = null;
      try { epoch = protocolInteger(input?.epoch).toString(); } catch { /* malformed epoch is omitted */ }
      return transaction(async (client) => {
        await checkState(client, "FOR UPDATE");
        await client.query(`INSERT INTO ${prepareRejections} (prepare_digest, voter_identity, epoch, reason)
          VALUES ($1, $2, $3, $4)`, [digest, voter, epoch, reason]);
      });
    },
  };
}
