import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as pause } from "node:timers/promises";
import { tableName } from "../../src/db.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { createTransactionRepository } from "../../src/transaction-manager/repository.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { createMessageQuery } from "../../src/api/message-query.mjs";
import { createMessageQueryServer } from "../../src/api/server.mjs";
import { assertMessageQueryPrivacy } from "./message-query-privacy.mjs";
import { verifyExplorerAssets, verifyExplorerMessage } from "./explorer-integration.mjs";
import { assertScrapePure, scrapeValue } from "./metrics-assertions.mjs";
import { registerPendingDelivery, PENDING_DELIVERY_NAME } from "../../src/metrics/pending-delivery.mjs";
import { assertDashboardExposition } from "./grafana-contract.mjs";

const sourceTables = ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batches", "message_batch_members",
  "batch_consensus_bindings", "batch_quorum_certificates", "batch_quorum_certificate_signatures", "delivery_batches", "delivery_jobs",
  "relayer_submissions", "relayer_worker_ids", "relayer_job_leases", "transaction_accounts", "transaction_intents", "transaction_attempts",
  "transaction_broadcast_events", "transaction_receipt_observations", "transaction_receipt_orphans"];
const validatorTables = ["validator_metadata", "validator_committee", "validator_set_history", "validated_batch_bindings", "validation_observations",
  "pbft_epoch_views", "pbft_pre_prepares", "pbft_prepare_votes", "pbft_prepared_states", "pbft_commit_votes", "pbft_commit_quorums",
  "pbft_view_change_votes", "pbft_new_views"];
const same = (actual, expected, label) => assert.ok(isDeepStrictEqual(actual, expected), label);
async function tables(pool, schema, names) {
  const result = {};
  for (const name of names) result[name] = (await pool.query(`SELECT * FROM ${tableName(schema, name)} t ORDER BY to_jsonb(t)::text`)).rows;
  return result;
}

// The scenario owns chains, pools and validators. This helper owns only its
// ephemeral HTTP listener and never schedules a production state transition.
export async function verifyMessageQueryHTTP({ config, pool, states, records, messageIds,
  productionGateway = process.env.PRODUCTION_DESTINATION_GATEWAY_ADDRESS?.toLowerCase() ?? null,
  expectedExecution, missingSigner, destinationCheck, label = "existing lifecycle evidence" }) {
  console.log(`\n[read-only message lifecycle API / ${label}]`);
  const entries = Array.isArray(states) ? states.map((state, index) => [index, state]) : [...states];
  const readers = entries.map(([, state]) => ({ config: { databaseSchema: state.config.databaseSchema,
    validatorAddress: state.config.validatorAddress }, pool: state.pool }));
  const queryConfig = { databaseSchema: config.databaseSchema, chainDomain: config.chainDomain, sourceGateway: config.sourceGateway,
    validatorSets: config.validatorSets, finalityBlockDepth: config.finalityBlockDepth,
    destinationConfirmations: config.destinationConfirmations ?? BigInt(process.env.DESTINATION_CONFIRMATIONS ?? "3"),
    productionDestinationGateway: productionGateway,
    identityApplicationAddress: process.env.IDENTITY_APPLICATION_ADDRESS?.toLowerCase() ?? null,
    listenHost: "127.0.0.1", listenPort: 0 };
  const lifecycle = createBatchLifecycle({ config: queryConfig, pool });
  const queue = createDeliveryRepository({ config: queryConfig, pool });
  const expected = [];
  for (const messageId of messageIds) {
    const source = (await pool.query(`SELECT * FROM ${tableName(config.databaseSchema, "source_messages")}
      WHERE message_id = $1 ORDER BY (status <> 'REORGED') DESC,id DESC`, [messageId])).rows[0];
    assert.ok(source);
    const membership = (await pool.query(`SELECT batch_record_id FROM ${tableName(config.databaseSchema, "message_batch_members")}
      WHERE source_message_id = $1`, [source.id])).rows[0];
    const snapshot = membership ? await lifecycle.readBatch({ batchRecordId: membership.batch_record_id }) : null;
    // Let the ordinary scheduler finish its already-committed discovery before
    // mutation snapshots. Never finalize a validator from the query helper.
    if (snapshot?.record.status === "COMMITTED" && records) {
      for (const [index, state] of entries) {
        const record = records instanceof Map ? records.get(index) : records[index];
        if (!record || record.exited) continue;
        const deadline = Date.now() + 30000;
        for (;;) {
          const view = await state.store.readViewState(snapshot.record.epoch);
          if (!view || view.finalized) break;
          assert.ok(Date.now() < deadline, "ordinary validator discovery must settle before observing zero mutations");
          await pause(25);
        }
      }
    }
    const jobRow = (await pool.query(`SELECT delivery_job_id FROM ${tableName(config.databaseSchema, "delivery_jobs")}
      WHERE source_message_id = $1`, [source.id])).rows[0];
    const job = jobRow ? await queue.getDeliveryJob(jobRow.delivery_job_id) : null;
    let transaction = null; let receiptHistory = []; let actualVotes = [];
    if (job) {
      const intent = (await pool.query(`SELECT sender_address,chain_id FROM ${tableName(config.databaseSchema, "transaction_intents")}
        WHERE delivery_job_id = $1`, [job.deliveryJobId])).rows[0];
      if (intent) {
        const pack = await queue.getDeliveryPackage(job.deliveryJobId);
        const encoded = await encodeGatewaySubmission(pack, { validatorSets: config.validatorSets });
        const repository = createTransactionRepository({ config: { ...queryConfig, destinationDomain: BigInt(intent.chain_id), relayerAddress: intent.sender_address }, pool,
          resolveIntent: async () => ({ deliveryJobId: job.deliveryJobId, packageDigest: encoded.packageDigest,
            chainId: intent.chain_id, senderAddress: intent.sender_address, destinationGateway: job.destinationGateway,
            value: "0", calldata: encoded.calldata, historicalCalldata: encoded.data }) });
        transaction = await repository.getTransaction(job.deliveryJobId);
        receiptHistory = await repository.getReceiptObservations(job.deliveryJobId);
      }
    }
    if (snapshot?.quorumCertificate) {
      const qc = snapshot.quorumCertificate;
      const set = qc.protocolVersion === "3" ? config.validatorSets.resolveForBatchEpoch(snapshot.record.epoch) : config.validatorSets.history[0];
      const collected = new Map();
      for (const [, state] of entries.filter(([, value]) => set.validators.includes(value.config.validatorAddress))) {
        for (const [phase, votes] of [["PREPARE", (await state.store.readPrepareState(snapshot.record.epoch, qc.view ?? "0")).votes],
          ["COMMIT", (await state.store.readCommitState(snapshot.record.epoch, qc.view ?? "0")).votes]]) {
          for (const vote of votes) collected.set(`${phase}:${vote.voterIdentity}`, { phase, signer: vote.voterIdentity,
            digest: phase === "PREPARE" ? vote.prepareDigest : vote.commitDigest });
        }
      }
      actualVotes = [...collected.values()];
    }
    expected.push({ source, snapshot, job, transaction, receiptHistory, actualVotes });
  }
  const capture = async () => ({ source: await tables(pool, config.databaseSchema, sourceTables),
    validators: await Promise.all(entries.map(([, state]) => tables(state.pool, state.config.databaseSchema, validatorTables))),
    destination: destinationCheck ? await destinationCheck() : null });
  const before = await capture();
  const pendingMetric = registerPendingDelivery({ config: queryConfig, pool });
  const runtime = createMessageQueryServer({ config: queryConfig, query: createMessageQuery({ config: queryConfig, pool, validatorReaders: readers }) });
  try {
    await runtime.listen();
    console.log("VALID: read-only message query API started on an isolated loopback verification endpoint");
    const url = `http://127.0.0.1:${runtime.server.address().port}/api/v1/messages/`;
    const origin = `http://127.0.0.1:${runtime.server.address().port}`;
    await verifyExplorerAssets(origin);
    for (const value of expected) {
      const { source, snapshot, job, transaction, receiptHistory, actualVotes } = value;
      const response = await fetch(url + source.message_id, { signal: AbortSignal.timeout(30000) });
      const text = await response.text(); const body = JSON.parse(text);
      const diagnostic = ["INCONSISTENT_EVIDENCE", "VALIDATOR_EVIDENCE_UNAVAILABLE", "DEPENDENCY_UNAVAILABLE", "INTERNAL_ERROR", "MESSAGE_NOT_FOUND"].includes(body.error) ? body.error : "UNEXPECTED_RESPONSE";
      assert.equal(response.status, 200, `HTTP lifecycle query failed for ${source.message_id}: ${diagnostic}`);
      assert.equal(body.authority, "OBSERVATIONAL"); assert.equal(body.message.messageId, source.message_id);
      assert.equal(body.message.nonce, source.nonce); assert.equal(body.message.deadline, source.deadline);
      assert.equal(body.sourceTransaction.transactionHash, source.source_tx_hash); assert.equal(body.sourceTransaction.logIndex, source.source_log_index);
      assert.equal(body.sourceBlock.blockHash, source.source_block_hash); assert.equal(body.sourceBlock.blockNumber, source.source_block_number);
      assert.equal(body.finality.status, source.status);
      if (snapshot) {
        assert.equal(body.batch.batchId, snapshot.record.batchId); assert.equal(body.batch.batchEpoch, snapshot.record.epoch.toString());
        assert.equal(body.batch.position, snapshot.members.find(member => member.sourceMessageId === source.id).position?.toString() ?? null);
        assert.equal(body.merkle?.root ?? null, snapshot.record.messageRoot);
      }
      if (snapshot?.quorumCertificate) {
        const qc = snapshot.quorumCertificate;
        assert.equal(body.pbft.status, "COMMITTED"); assert.equal(body.qc.protocolVersion, qc.protocolVersion);
        assert.equal(body.qc.validatorEpoch, qc.validatorEpoch ?? null); assert.equal(body.qc.view, qc.view ?? null);
        assert.equal(body.qc.committeeDigest, qc.committeeDigest); assert.equal(body.qc.qcDigest, qc.qcDigest);
        same(body.qc.signers, qc.commits.map(vote => vote.voterIdentity), "HTTP QC signers must match the production certificate");
        const normalize = votes => votes.map(vote => ({ phase: vote.phase, signer: vote.signer, digest: vote.digest }))
          .sort((a, b) => `${a.phase}:${a.signer}`.localeCompare(`${b.phase}:${b.signer}`));
        same(normalize(body.validatorVotes), normalize(actualVotes), "HTTP votes must equal actual durable vote evidence");
        if (missingSigner) {
          assert.equal(body.qc.signers.length, 3); assert.equal(body.validatorVotes.some(vote => vote.signer === missingSigner), false);
          const missing = body.pbft.observations.find(observation => observation.validator === missingSigner);
          assert.ok(missing); assert.equal(missing.ownPrepare, false); assert.equal(missing.ownCommit, false);
        }
      }
      if (job) assert.equal(body.delivery.deliveryJobId, job.deliveryJobId);
      if (transaction) {
        assert.equal(body.delivery.intent.nonce, transaction.intent.nonce);
        same(body.deliveryAttempts.map(attempt => attempt.transactionHash), transaction.attempts.map(attempt => attempt.transactionHash), "ordered signed history must match production reads");
        same(body.deliveryAttempts.map(attempt => attempt.replacementOfAttemptId), transaction.attempts.map(attempt => attempt.replacementOfAttemptId), "replacement lineage must remain intact");
        assert.equal(body.destinationTransaction.state, transaction.intent.status);
        assert.equal(body.destinationTransaction.transactionHash, transaction.winningAttempt?.transactionHash ?? null);
        assert.equal(body.destinationTransaction.blockHash, transaction.winningAttempt?.receiptBlockHash ?? null);
        assert.equal(body.deliveryAttempts.flatMap(attempt => attempt.receipts).length, receiptHistory.length);
        for (const history of receiptHistory) assert.ok(body.deliveryAttempts.flatMap(attempt => attempt.receipts).some(receipt =>
          receipt.blockHash === history.blockHash && receipt.transactionHash === history.transactionHash && receipt.orphaned === history.orphaned));
        if (expectedExecution) assert.equal(body.execution.status, expectedExecution);
      }
      if (source.status === "REORGED") {
        for (const field of ["batch", "qc", "delivery", "destinationTransaction", "execution"]) assert.equal(body[field], null);
        console.log("VALID: querying a real REORGED source occurrence preserves provenance and exposes no fabricated downstream authority");
      }
      const again = await (await fetch(url + source.message_id, { signal: AbortSignal.timeout(30000) })).json();
      const privacy = { source, privateKeys: entries.map(([, state]) => state.config.privateKey),
        connectionStrings: [config.databaseUrl, ...entries.flatMap(([, state]) => [state.config.databaseUrl, state.config.sourceDatabaseUrl])],
        rawSignedTransactions: transaction?.attempts.map(attempt => attempt.rawSignedTransaction) ?? [] };
      assertMessageQueryPrivacy(body, privacy);
      assertMessageQueryPrivacy(again, privacy);
      const expectedAuthorization = source.source_sender === queryConfig.identityApplicationAddress && source.version === 2 ?
        source.status === "REORGED" ? "HISTORICAL_AUTHORIZED" : "AUTHORIZED" : "UNAVAILABLE";
      await verifyExplorerMessage({ origin, body, source, expectedAuthorization, missingSigner });
      delete body.observedAt; delete again.observedAt;
      same(body, again, "repeated GET must return equivalent protocol fields");
      console.log(`VALID: queried real message ${source.message_id} through HTTP; source provenance/finality, batch/Merkle, persisted votes/QC, delivery history and current destination observation match independent production reads`);
    }
    const exposition = await assertScrapePure(origin);
    assertDashboardExposition(exposition);
    if (expectedExecution === "REORG_RECOVERY") {
      assert.ok(scrapeValue(exposition, PENDING_DELIVERY_NAME) >= 1, "the real reopened destination intent is unresolved again");
    }
    const unknown = `0x${"00".repeat(32)}`;
    assert.equal((await pool.query(`SELECT 1 FROM ${tableName(config.databaseSchema, "source_messages")} WHERE message_id = $1`, [unknown])).rowCount, 0);
    assert.equal((await fetch(url + unknown)).status, 404); console.log("EXPECTED FAILURE: unknown canonical message ID returns 404 without mutation");
    assert.equal((await fetch(url + "0x01")).status, 400); console.log("EXPECTED FAILURE: malformed message ID returns 400 before repository access");
    assert.equal((await fetch(url + messageIds[0], { method: "POST" })).status, 405); console.log("EXPECTED FAILURE: read-only API rejects state-changing HTTP methods");
    same(await capture(), before, "HTTP GET must not mutate source, finality, batch/QC, validator votes/views, lease, account/scan cursors, retry, journals, receipts or destination state");
    console.log("VALID: repeated Prometheus scrapes change no source lifecycle, batch/QC, validator vote, lease, nonce, retry, attempt, receipt, Gateway replay or ApplicationB state");
    if (expectedExecution === "CONFIRMED") {
      assert.equal(before.destination?.executed, true); assert.equal(before.destination?.supplier, true);
      console.log("VALID: Explorer Execution section matches current production DestinationGateway/ApplicationB evidence");
    }
    console.log("VALID: loading, searching and refreshing Explorer views changes no source, consensus, delivery, transaction or destination state");
    console.log("VALID: repeated HTTP queries changed no source/finality/batch/QC/vote/delivery/lease/intent/nonce/retry/attempt/receipt/destination state; no broadcast or recovery was scheduled");
    console.log("VALID: API integer fields remain exact decimal strings and public allowlists exclude raw signed bytes, private keys and connection material");
  } finally { try { await runtime.close(); } finally { pendingMetric.close(); } }
}
