import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createMessageQuery } from "../src/api/message-query.mjs";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { readSnapshot } from "../src/api/read-snapshot.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { commitConfigs } from "../../validator/test/helpers/commit-fixtures.mjs";
import { initializeValidatorState } from "../../validator/test/helpers/process-cluster.mjs";
import { environment } from "../../validator/test/helpers/fixtures.mjs";
import { deterministicPrimary } from "../../validator/src/committee.mjs";
import { signPrePrepare } from "../../validator/src/pre-prepare.mjs";
import { signPrepare } from "../../validator/src/prepare.mjs";

test("real PostgreSQL + HTTP: exact 3-of-4 durable evidence, unsigned READY purity, signed history, read-only locks and corrupted QC rejection", async () => {
  const schema = `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_api`;
  const config = { ...transactionConfig({ DATABASE_URL: process.env.DATABASE_URL, INDEXER_DB_SCHEMA: schema }), finalityBlockDepth: 2n };
  const pools = []; let runtime;
  const pool = createDatabasePool(config); pools.push(pool);
  try {
    await applyMigrations(pool, schema); await resetIndexerTables(pool, schema);
    const { snapshot } = await persistReadyTransactionFixture({ config, pool, count: 1 });
    const qc = snapshot.quorumCertificate;
    const primary = commitConfigs.find(value => value.validatorAddress === deterministicPrimary(value.peers, snapshot.record.epoch));
    assert.ok(primary);
    const proposal = await signPrePrepare(primary, { messageType: "PRE_PREPARE", protocolVersion: "3", sourceDomain: config.chainDomain.toString(),
      sourceGateway: config.sourceGateway, epoch: snapshot.record.epoch.toString(), view: "0", batchId: snapshot.record.batchId,
      messageRoot: snapshot.record.messageRoot, primaryIdentity: primary.validatorAddress });
    const readers = [];
    for (let index = 0; index < 4; index++) {
      const state = await initializeValidatorState(environment({ SOURCE_DATABASE_URL: config.databaseUrl, SOURCE_DB_SCHEMA: schema,
        VALIDATOR_DATABASE_URL: config.databaseUrl, VALIDATOR_DB_SCHEMA: `${schema}_v${index + 1}` }, index), value => pools.push(value));
      readers.push(state);
      await state.store.bindIdentity();
      if (index === 3) continue;
      await state.store.savePrePrepare(proposal, primary.validatorAddress === state.config.validatorAddress ? "ISSUED" : "ACCEPTED");
      for (const signer of commitConfigs.slice(0, 3)) await state.store.savePrepareVote(await signPrepare(signer, { ...qc,
        messageType: "PREPARE", voterIdentity: signer.validatorAddress }));
      for (const vote of qc.commits) await state.store.saveCommitVote(vote);
    }
    const statements = [];
    const readPool = underlying => ({ async connect() {
      const client = await underlying.connect();
      return { release: error => client.release(error), async query(sql, params) {
        statements.push(sql);
        assert.ok(!/\b(INSERT|UPDATE|DELETE|FOR\s+SHARE|FOR\s+UPDATE|pg_.*advisory)/i.test(sql), "GET must not write or acquire worker row/session locks");
        return client.query(sql, params);
      } };
    } });
    const query = createMessageQuery({ config, pool: readPool(pool), validatorReaders: readers.map(state => ({ config: state.config, pool: readPool(state.pool) })) });
    runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query });
    await runtime.listen();
    const url = `http://127.0.0.1:${runtime.server.address().port}/api/v1/messages/${snapshot.batch.messageIds[0]}`;
    const snapshotTables = async () => {
      const result = {};
      for (const table of ["source_messages", "message_batches", "message_batch_members", "batch_quorum_certificates", "batch_quorum_certificate_signatures",
        "delivery_jobs", "transaction_accounts", "transaction_intents", "transaction_attempts", "relayer_job_leases", "transaction_broadcast_events"]) {
        result[table] = (await pool.query(`SELECT * FROM ${tableName(schema, table)} t ORDER BY to_jsonb(t)::text`)).rows;
      }
      return result;
    };
    const before = await snapshotTables();
    for (let count = 0; count < 2; count++) {
      const response = await fetch(url); assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.delivery.status, "READY"); assert.equal(body.destinationTransaction, null); assert.deepEqual(body.deliveryAttempts, []);
      assert.equal(body.validatorVotes.filter(vote => vote.phase === "PREPARE").length, 3);
      assert.equal(body.validatorVotes.filter(vote => vote.phase === "COMMIT").length, 3);
      const missing = body.pbft.observations.find(value => value.validator === readers[3].config.validatorAddress);
      assert.ok(missing); assert.equal(missing.ownCommit, false); assert.equal(missing.ownPrepare, false);
      assert.equal(body.qc.signers.length, 3);
    }
    assert.ok(isDeepStrictEqual(await snapshotTables(), before), "READY GET cannot create an intent, reserve a nonce or alter consensus/finality");
    await assert.rejects(() => createMessageQuery({ config, pool }).getMessageLifecycle(snapshot.batch.messageIds[0]),
      { code: "VALIDATOR_EVIDENCE_UNAVAILABLE", status: 503 });
    assert.ok(statements.some(sql => sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"));
    const lifecycle = createBatchLifecycle({ config, pool });
    const observed = await readSnapshot(pool, client => lifecycle.readBatchObservation({ batchRecordId: snapshot.record.batchRecordId }, client));
    assert.ok(isDeepStrictEqual(observed, await lifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId })), "unlocked observation must retain strict worker snapshot semantics");
    const queue = createDeliveryRepository({ config, pool }); const [job] = await queue.listReadyDeliveryJobs();
    const harness = await transactionHarness({ config, count: 1 });
    const manager = createTransactionManager({ config, pool, queue, rpc: harness.rpc });
    const signed = await manager.prepareDeliveryTransaction(job.deliveryJobId);
    const signedBefore = await snapshotTables();
    const body = await (await fetch(url)).json();
    assert.equal(body.destinationTransaction.state, "PENDING"); assert.equal(body.destinationTransaction.transactionHash, null);
    assert.equal(body.destinationTransaction.candidateTransactionHash, signed.attempt.transactionHash);
    assert.equal(body.deliveryAttempts[0].nonce, signed.intent.nonce);
    assert.ok(!JSON.stringify(body).includes(signed.attempt.rawSignedTransaction));
    assert.equal(harness.calls.broadcast.length, 0);
    assert.ok(isDeepStrictEqual(await snapshotTables(), signedBefore), "SIGNED GET cannot broadcast, retry or update scan cursors");
    const corruptedPool = { async connect() {
      const client = await pool.connect();
      return { release: () => client.release(), query(sql, params) {
        if (sql.includes(`SELECT * FROM ${tableName(schema, "batch_quorum_certificates")}`)) return { rows: [] };
        return client.query(sql, params);
      } };
    } };
    const corrupted = createMessageQuery({ config, pool: corruptedPool, validatorReaders: readers });
    await assert.rejects(() => corrupted.getMessageLifecycle(snapshot.batch.messageIds[0]), { code: "INCONSISTENT_EVIDENCE", status: 409 });
    for (const [name, change] of [["delivery_jobs", row => ({ ...row, message_id: `0x${"00".repeat(32)}` })],
      ["transaction_intents", row => ({ ...row, calldata: "0x00" })],
      ["transaction_attempts", row => ({ ...row, transaction_hash: `0x${"00".repeat(32)}` })]]) {
      const altered = { async connect() {
        const client = await pool.connect();
        return { release: () => client.release(), async query(sql, params) {
          const result = await client.query(sql, params);
          return sql.includes(`SELECT * FROM ${tableName(schema, name)}`) ? { ...result, rows: result.rows.map(change) } : result;
        } };
      } };
      await assert.rejects(() => createMessageQuery({ config, pool: altered, validatorReaders: readers }).getMessageLifecycle(snapshot.batch.messageIds[0]),
        { code: "INCONSISTENT_EVIDENCE", status: 409 });
    }
    assert.ok(isDeepStrictEqual(await snapshotTables(), signedBefore), "corruption detection cannot repair or rewrite protocol rows");
  } finally {
    await runtime?.close(); await Promise.all(pools.map(value => value.end()));
  }
});
