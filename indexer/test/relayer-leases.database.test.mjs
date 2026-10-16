import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readdir,readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { applyMigrations, createDatabasePool, resetIndexerTables, tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { createRelayerLeaseRepository } from "../src/relayer/leases.mjs";
import { createRelayerWorker } from "../src/relayer/service.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig, transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture, transactionBody,rpcExecutionRevert,rpcUnavailable } from "./helpers/destination-rpc-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_leases`,
  CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]',RELAYER_LEASE_MS: "60000" });
const configB = { ...config,workerId: "relayer-b" };
const pool = createDatabasePool(config); const poolB = createDatabasePool(configB);
const queue = createDeliveryRepository({ config,pool }); const queueB = createDeliveryRepository({ config: configB,pool: poolB });
const leases = createRelayerLeaseRepository({ config,pool,queue });
const leasesB = createRelayerLeaseRepository({ config: configB,pool: poolB,queue: queueB });
const leaseTable = tableName(config.databaseSchema,"relayer_job_leases");
const intentTable = tableName(config.databaseSchema,"transaction_intents");
const attemptTable = tableName(config.databaseSchema,"transaction_attempts");
let jobs; let h; let destination; let reader;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema); await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
  destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const row = (await pool.query(`SELECT delivery_job_id,attempt_id FROM ${attemptTable} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(row,"another DB client must see committed signed bytes before send");
    const stored = await reader.repository.getTransaction(row.delivery_job_id);
    const attempt = stored.attempts.find(a => a.attemptId === row.attempt_id); await verifySignedTransaction(stored.intent,attempt);
    return transactionBody(stored.intent,attempt);
  } }); reader = manager();
});
after(async () => { await Promise.all([pool.end(),poolB.end()]); });
function manager({ cfg = config,db = pool,rpc = destination.rpc,...options } = {}) {
  return createTransactionManager({ config: cfg,pool: db,queue: createDeliveryRepository({ config: cfg,pool: db }),rpc,clock: h.clock,...options });
}
async function expire(id) {
  // Verification-only controlled expiry; production has no force-steal API.
  await pool.query(`UPDATE ${leaseTable} SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
}
async function counts() {
  return (await pool.query(`SELECT (SELECT COUNT(*) FROM ${intentTable})::int AS intents,
    (SELECT COUNT(*) FROM ${attemptTable})::int AS attempts`)).rows[0];
}

test("SQL READY selection bulk-reads only selected identities and never expands a batch into leases", async () => {
  const reads = [];
  const observedQueue = { ...queue,
    async getDeliveryJob() { assert.fail("selection must use the grouped queue read"); },
    async getDeliveryEntries(ids) { reads.push([...ids]); return queue.getDeliveryEntries(ids); },
  };
  const selectedLeases = createRelayerLeaseRepository({ config,pool,queue: observedQueue });
  await selectedLeases.withWorker(async session => {
    assert.deepEqual(await selectedLeases.listClaimableJobs({ session,limit: 3 }),jobs);
    assert.deepEqual(reads,[jobs.map(job => job.deliveryJobId)]);
    assert.deepEqual(await selectedLeases.listClaimableJobs({ session,limit: 1 }),[jobs[0]]);
    assert.deepEqual(reads[1],[jobs[0].deliveryJobId]);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${leaseTable}`)).rows[0].count,0);
  });
});

async function useMultiDestinationFixture() {
  await resetIndexerTables(pool,config.databaseSchema);
  await persistReadyTransactionFixture({ config,pool,multiDestination: true });
  jobs = await queue.listReadyDeliveryJobs();
}

async function rejectEstimatesFor(ids) {
  const calldata = new Set(await Promise.all(ids.map(async id => (await reader.resolveIntent(id)).calldata)));
  destination.nodes.forEach(node => node.faults.set("eth_estimateGas",({ params,forward }) => {
    if (calldata.has(params[0].data)) throw rpcExecutionRevert();
    return forward();
  }));
  return calldata;
}
async function preparationDue(id) {
  await pool.query(`UPDATE ${leaseTable} SET preparation_retry_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
}
async function runInFreshProcess(rejectedIds,{ kind,jobIds = [],receiptJobIds = [],interrupt = false } = {}) {
  return new Promise((resolve,reject) => {
    const child = spawn(process.execPath,[fileURLToPath(new URL("./helpers/lease-selection-process.mjs",import.meta.url)),
      ...(kind ? [kind + (interrupt ? "-selected" : "")] : [])],{
      env: { ...process.env,DATABASE_URL: config.databaseUrl,INDEXER_DB_SCHEMA: config.databaseSchema,
        PREPARATION_REJECT_JOB_IDS: JSON.stringify(rejectedIds),OBSERVATION_JOB_IDS: JSON.stringify(jobIds),
        OBSERVATION_RECEIPT_JOB_IDS: JSON.stringify(receiptJobIds) },
      stdio: ["ignore","pipe","pipe"],timeout: 30000,
    });
    let output = ""; let diagnostics = "";
    child.stdout.on("data",chunk => { output += chunk; });
    child.stderr.on("data",chunk => { diagnostics += chunk; });
    child.once("error",reject);
    child.once("close",code => {
      if (code !== (interrupt ? 73 : 0)) return reject(new Error(`fresh transaction process failed (${code}): ${diagnostics}`));
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
}

for (const kind of ["receipt","recovery"]) {
  test(`fresh OS ${kind} passes rotate behind missing earlier receipts without new signatures or broadcasts`, async () => {
    for (const job of jobs) await reader.submitDelivery(job.deliveryJobId);
    const ids = jobs.map(job => job.deliveryJobId); const account = await reader.repository.getAccount();
    const before = await sourceState(pool,config.databaseSchema);
    const journal = tableName(config.databaseSchema,"transaction_broadcast_events");
    const journalBefore = (await pool.query(`SELECT * FROM ${journal} ORDER BY event_id`)).rows;
    for (let round = 0; round < 3; round++) {
      const result = await runInFreshProcess([],{ kind,jobIds: ids,receiptJobIds: [ids[2]] });
      assert.equal(result.scanned,1); assert.deepEqual(result.ids,[ids[round]]); assert.equal(result.finalized,round === 2 ? 1 : 0);
    }
    assert.equal((await reader.repository.getTransaction(ids[0])).intent.status,"PENDING");
    assert.equal((await reader.repository.getTransaction(ids[2])).intent.status,"CONFIRMED");
    assert.equal((await pool.query(`SELECT ${kind === "receipt" ? "recovery_scan_cursor_nonce" : "receipt_scan_cursor_nonce"}::text AS cursor
      FROM ${tableName(config.databaseSchema,"transaction_accounts")}`)).rows[0].cursor,null);
    assert.deepEqual(await reader.repository.getAccount(),account);
    assert.deepEqual((await pool.query(`SELECT * FROM ${journal} ORDER BY event_id`)).rows,journalBefore);
    assert.deepEqual(await counts(),{ intents: 3,attempts: 3 }); assert.deepEqual(await sourceState(pool,config.databaseSchema),before);
  });

  test(`fresh OS ${kind} selection crash is durable and wrap revisits the skipped intent within N rounds`, async () => {
    for (const job of jobs) await reader.submitDelivery(job.deliveryJobId);
    const ids = jobs.map(job => job.deliveryJobId);
    const before = await Promise.all(ids.map(id => reader.repository.getRecoverySnapshot(id)));
    const account = await reader.repository.getAccount();
    const interrupted = await runInFreshProcess([],{ kind,jobIds: ids,interrupt: true });
    assert.equal(interrupted.interrupted,true); assert.deepEqual(interrupted.selectedIds,[ids[0]]);
    assert.deepEqual(await Promise.all(ids.map(id => reader.repository.getRecoverySnapshot(id))),before);
    const revisited = [];
    for (let round = 0; round < 3; round++) {
      const result = await runInFreshProcess([],{ kind,jobIds: ids });
      assert.equal(result.scanned,1); revisited.push(...result.ids);
    }
    assert.deepEqual(revisited,[ids[1],ids[2],ids[0]]);
    assert.deepEqual(await reader.repository.getAccount(),account);
    assert.deepEqual(await Promise.all(ids.map(id => reader.repository.getRecoverySnapshot(id))),before);
  });
}

test("SQL explicit estimate defer persists across clients without intent, account nonce, attempt, journal or send", async () => {
  const id = jobs[0].deliveryJobId; await rejectEstimatesFor([id]);
  const before = await sourceState(pool,config.databaseSchema);
  const worker = createRelayerWorker({ config,pool,queue,transactionManager: reader });
  const result = await worker.submitJob(id);
  assert.equal(result.action,"PREPARATION_DEFERRED"); assert.equal(result.submitted,false);
  assert.equal("nonce" in result,false); assert.equal("transactionHash" in result,false);
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(config.databaseSchema,"transaction_broadcast_events")}`)).rows[0].count,0);
  assert.equal(destination.nodes.flatMap(node => node.calls).some(call => ["eth_getTransactionCount","eth_maxPriorityFeePerGas","eth_sendRawTransaction"].includes(call.method)),false);
  const fresh = createDatabasePool(config);
  try {
    const restarted = createRelayerLeaseRepository({ config,pool: fresh,queue });
    const stored = await restarted.getLease(id);
    assert.equal(stored.preparationRetryAt,result.retryAt); assert.equal(stored.preparationDeferReason,"ESTIMATE_EXECUTION_REVERT");
    assert.notEqual(stored.releasedAt,null);
    // Keep this not-due assertion independent of test host speed.
    await pool.query(`UPDATE ${leaseTable} SET preparation_retry_at = clock_timestamp() + interval '1 hour' WHERE delivery_job_id = $1`,[id]);
    await restarted.withWorker(async session => {
      assert.equal(await restarted.tryAcquireLease(id,session),null);
      const selected = await restarted.listClaimableJobs({ session,limit: 1 });
      assert.equal(selected[0].deliveryJobId,jobs[1].deliveryJobId);
    });
    assert.equal((await createRelayerWorker({ config,pool: fresh,queue,leases: restarted,transactionManager: reader }).submitJob(id)).action,"PREPARATION_DEFERRED");
  } finally { await fresh.end(); }
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs); assert.deepEqual(await sourceState(pool,config.databaseSchema),before);
});

test("SQL automatic larger pass defers one estimate rejection and still submits following READY jobs", async () => {
  await rejectEstimatesFor([jobs[0].deliveryJobId]);
  const result = await createRelayerWorker({ config,pool,queue,transactionManager: reader }).runOnce();
  assert.equal(result.selected,3); assert.equal(result.deferred,1); assert.equal(result.submitted,2);
  assert.deepEqual(await counts(),{ intents: 2,attempts: 2 });
  assert.equal(await reader.repository.getTransaction(jobs[0].deliveryJobId),null);
});

test("SQL due retry renews defer, then state improvement clears scheduling in the intent commit", async () => {
  const id = jobs[0].deliveryJobId; const rejected = await rejectEstimatesFor([id]);
  const worker = () => createRelayerWorker({ config,pool: poolB,queue: queueB,transactionManager: manager({ db: poolB }) });
  await worker().submitJob(id); await preparationDue(id);
  const old = await leases.getLease(id); const again = await worker().submitJob(id);
  assert.equal(again.action,"PREPARATION_DEFERRED"); assert.ok(Date.parse(again.retryAt) > Date.parse(old.preparationRetryAt));
  rejected.clear(); await preparationDue(id);
  const prepared = await worker().submitJob(id);
  assert.equal(prepared.submitted,true); assert.equal((await leases.getLease(id)).preparationRetryAt,null);
  assert.equal((await leases.getLease(id)).preparationDeferReason,null);
  const attempts = prepared.attempts; const gas = destination.nodes.flatMap(node => node.calls).filter(call => call.method === "eth_estimateGas").length;
  await pool.query(`UPDATE ${leaseTable} SET preparation_retry_at = clock_timestamp() + interval '1 hour',preparation_defer_reason = 'ESTIMATE_EXECUTION_REVERT' WHERE delivery_job_id = $1`,[id]);
  assert.deepEqual((await worker().submitJob(id)).attempts,attempts);
  assert.equal(destination.nodes.flatMap(node => node.calls).filter(call => call.method === "eth_estimateGas").length,gas);
});

test("SQL persistent fairness survives fresh OS processes, slow one-shots and continuous genuine READY arrivals", async () => {
  // Three due deferred jobs, then one newly committed/materialized batch on
  // EVERY round. No in-memory selection cursor and no real sleep are involved.
  const deferredIds = jobs.map(job => job.deliveryJobId);
  for (const id of deferredIds) {
    const [item] = await runInFreshProcess(deferredIds);
    assert.equal(item.deliveryJobId,id); assert.equal(item.action,"PREPARATION_DEFERRED");
    await pool.query(`UPDATE ${leaseTable} SET preparation_retry_at = clock_timestamp() + interval '1 hour' WHERE delivery_job_id = $1`,[id]);
  }
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 });
  for (const id of deferredIds) await preparationDue(id);
  const seen = []; const ordinary = [];
  for (let round = 0; round < 6; round++) {
    await persistReadyTransactionFixture({ config,pool,append: true,count: 1,epoch: 24n + BigInt(round),messageOffset: 100 + round });
    // Shift all schedules by the SAME elapsed interval, preserving their
    // relative retry order. Every invocation models a gap longer than defer.
    await pool.query(`UPDATE ${leaseTable} SET preparation_retry_at = preparation_retry_at -
      $1::bigint * interval '1 millisecond' WHERE preparation_retry_at IS NOT NULL`,[config.rebroadcastIntervalMs + 1]);
    const [item] = await runInFreshProcess(deferredIds); assert.ok(item);
    const id = item.deliveryJobId;
    if (deferredIds.includes(id)) {
      seen.push(id); assert.equal(item.action,"PREPARATION_DEFERRED"); assert.equal(item.submitted,false);
      assert.equal(await reader.repository.getTransaction(id),null);
    } else {
      ordinary.push(id); assert.equal(item.submitted,true);
      const prepared = await reader.repository.getTransaction(id);
      // Finalize through the existing repository so no unrelated pending
      // intent can compete with the preparation-only selection assertion.
      await reader.repository.recordOutcome(id,{ transactionHash: prepared.attempt.transactionHash,status: 1,
        blockNumber: 100n,blockHash: config.destinationGenesisHash,head: 102n });
    }
  }
  assert.equal(ordinary.length,3); assert.equal(new Set(seen).size,3);
  assert.ok(deferredIds.every(id => seen.includes(id)),"D=3 due jobs are reconsidered within 2D=6 rounds despite fresh arrivals");
});

test("SQL job-row gate serializes a late defer behind a concurrently committing initial intent", async () => {
  const id = jobs[0].deliveryJobId;
  let signed; let commit; let attempted;
  const entered = new Promise(resolve => { signed = resolve; });
  const release = new Promise(resolve => { commit = resolve; });
  const waiting = new Promise(resolve => { attempted = resolve; });
  const watched = { async connect() {
    const client = await poolB.connect();
    return { query(sql,params) {
      const pending = client.query(sql,params);
      if (sql.includes("FOR NO KEY UPDATE")) attempted();
      return pending;
    },release: () => client.release() };
  } };
  await leases.withWorker(async session => {
    const fence = await leases.tryAcquireLease(id,session);
    const creator = manager({ beforeSignedCommit: async () => { signed(); await release; } });
    const preparation = creator.prepareDeliveryTransaction(id);
    let deferred;
    try {
      await entered;
      const contender = createRelayerLeaseRepository({ config,pool: watched,queue });
      deferred = contender.deferPreparation(fence);
      await waiting;
    } finally { commit(); }
    const stored = await preparation;
    assert.equal(await deferred,null);
    assert.equal((await leases.getLease(id)).preparationRetryAt,null);
    assert.equal((await reader.repository.getTransaction(id)).attempt.transactionHash,stored.attempt.transactionHash);
    assert.deepEqual(await counts(),{ intents: 1,attempts: 1 });
  });
});

test("SQL stale owners cannot defer and concurrent initial intent creation takes precedence", async () => {
  const id = jobs[0].deliveryJobId;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const old = await leases.tryAcquireLease(id,a); await expire(id);
    const current = await leasesB.tryAcquireLease(id,b);
    await assert.rejects(leases.deferPreparation(old),{ code: "STALE_FENCE" });
    assert.equal((await leases.getLease(id)).preparationRetryAt,null);
    await leasesB.deferPreparation(current);
    // Exercise the unfenced direct Manager path against the same job-row gate.
    const stored = await reader.prepareDeliveryTransaction(id);
    assert.equal((await leases.getLease(id)).preparationRetryAt,null);
    assert.equal(await leasesB.deferPreparation(current),null);
    assert.deepEqual((await reader.repository.getTransaction(id)).attempt,stored.attempt);
    assert.deepEqual(await counts(),{ intents: 1,attempts: 1 });
  }));
});

test("SQL failed initial intent commit rolls back preparation-schedule clearing with the nonce and attempt", async () => {
  const id = jobs[0].deliveryJobId; const rejected = await rejectEstimatesFor([id]);
  await createRelayerWorker({ config,pool,queue,transactionManager: reader }).submitJob(id);
  rejected.clear(); await preparationDue(id);
  const before = await leases.getLease(id);
  const failed = manager({ beforeSignedCommit: async () => { throw new Error("controlled preparation commit failure"); } });
  await assert.rejects(createRelayerWorker({ config,pool,queue,transactionManager: failed }).submitJob(id),/controlled preparation commit failure/);
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
  assert.equal((await leases.getLease(id)).preparationRetryAt,before.preparationRetryAt);
  assert.equal((await leases.getLease(id)).preparationDeferReason,before.preparationDeferReason);
});

test("SQL infrastructure errors and invalid evidence stay fail-fast without preparation scheduling", async () => {
  destination.nodes.forEach(node => node.faults.set("eth_estimateGas",() => { throw rpcUnavailable(); }));
  await assert.rejects(createRelayerWorker({ config,pool,queue,transactionManager: reader }).runOnce(),{ code: "RPC_UNAVAILABLE" });
  assert.equal((await leases.getLease(jobs[0].deliveryJobId)).preparationRetryAt,null);
  const invalidQueue = { ...queue,async getDeliveryEntries(ids) {
    const entries = structuredClone(await queue.getDeliveryEntries(ids));
    entries[0].package.messageRoot = `0x${"ff".repeat(32)}`;
    return entries;
  } };
  await assert.rejects(createRelayerWorker({ config,pool,queue: invalidQueue,transactionManager: reader }).submitJob(jobs[0].deliveryJobId));
  assert.equal((await leases.getLease(jobs[0].deliveryJobId)).preparationRetryAt,null);
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
});

test("preparation migration upgrades existing leases and signed history without backfill or outcome changes", async () => {
  const schema = "preparation_upgrade_" + randomUUID().replaceAll("-",""); const cfg = { ...config,databaseSchema: schema };
  const client = await pool.connect(); let open = false;
  try {
    const names = (await readdir(new URL("../migrations/",import.meta.url))).filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0,3)) <= 15).sort();
    await client.query("BEGIN"); open = true; await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const name of names) {
      await client.query(await readFile(new URL("../migrations/" + name,import.meta.url),"utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)",[name]);
    }
    await client.query("COMMIT"); open = false;
    await persistReadyTransactionFixture({ config: cfg,pool });
    const q = createDeliveryRepository({ config: cfg,pool }); const oldJobs = await q.listReadyDeliveryJobs(); const id = oldJobs[0].deliveryJobId;
    await pool.query(`INSERT INTO ${tableName(schema,"relayer_worker_ids")} (worker_id) VALUES ('relayer-a')`);
    await pool.query(`INSERT INTO ${tableName(schema,"relayer_job_leases")}
      (delivery_job_id,owner_id,owner_session_id,fencing_token,lease_acquired_at,lease_expires_at,last_renewed_at)
      VALUES ($1,'relayer-a',$2,1,clock_timestamp(),clock_timestamp() + interval '1 hour',clock_timestamp())`,[id,randomUUID()]);
    const legacy = manager({ cfg,db: pool }); const signed = await legacy.prepareDeliveryTransaction(oldJobs[1].deliveryJobId);
    const account = await legacy.repository.getAccount(); const source = await sourceState(pool,schema);
    const before = (await pool.query(`SELECT * FROM ${tableName(schema,"relayer_job_leases")}`)).rows[0];
    assert.ok((await applyMigrations(pool,schema)).includes("016_relayer_preparation_defer.sql"));
    const upgraded = (await pool.query(`SELECT * FROM ${tableName(schema,"relayer_job_leases")}`)).rows[0];
    const { preparation_retry_at,preparation_defer_reason,...unchanged } = upgraded;
    assert.equal(preparation_retry_at,null); assert.equal(preparation_defer_reason,null); assert.deepEqual(unchanged,before);
    assert.equal((await pool.query(`SELECT preparation_deferred_turn FROM ${tableName(schema,"relayer_worker_ids")}`)).rows[0].preparation_deferred_turn,false);
    await applyMigrations(pool,schema);
    assert.deepEqual(await legacy.repository.getTransaction(oldJobs[1].deliveryJobId),{ intent: signed.intent,attempt: signed.attempt,attempts: signed.attempts,winningAttempt: signed.winningAttempt });
    assert.deepEqual(await legacy.repository.getAccount(),account); assert.deepEqual(await q.listReadyDeliveryJobs(),oldJobs);
    assert.deepEqual(await sourceState(pool,schema),source);
    await assert.rejects(pool.query(`UPDATE ${tableName(schema,"relayer_job_leases")} SET preparation_defer_reason = 'UNBOUNDED_RAW_PROVIDER_TEXT' WHERE delivery_job_id = $1`,[id]));
  } finally {
    try { if (open) await client.query("ROLLBACK"); await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); }
    finally { client.release(); }
  }
});

test("SQL filters a foreign-first prefix before LIMIT=1 and refuses foreign lease acquisition", async () => {
  await useMultiDestinationFixture();
  assert.deepEqual(jobs.map(job => job.destinationDomain),["2001","3001","2001"]);
  const scoped = { ...configB,destinationDomain: 3001n,maxJobs: 1 };
  const repository = createRelayerLeaseRepository({ config: scoped,pool: poolB,queue: queueB });
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  await repository.withWorker(async session => {
    assert.deepEqual(await repository.listClaimableJobs({ session,limit: 1 }),[jobs[1]]);
    for (const job of [jobs[0],jobs[2]]) {
      assert.equal(await repository.tryAcquireLease(job.deliveryJobId,session),null);
      assert.equal(await repository.getLease(job.deliveryJobId),null);
    }
    const acquired = await repository.tryAcquireLease(jobs[1].deliveryJobId,session);
    assert.equal(acquired.ownerId,session.workerId); assert.equal(acquired.ownerSessionId,session.sessionId);
    assert.equal(acquired.fencingToken,"1");
    assert.ok(Date.parse(acquired.leaseExpiresAt) > Date.parse(acquired.leaseAcquiredAt));
  });
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 });
  assert.equal(await reader.repository.getAccount(),null);
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
});

test("SQL all-foreign selection preserves existing foreign lease owner, expiry, fence and READY data", async () => {
  const before = await leases.withWorker(session => leases.tryAcquireLease(jobs[0].deliveryJobId,session));
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const scoped = { ...configB,destinationDomain: 4001n,maxJobs: 1 };
  const repository = createRelayerLeaseRepository({ config: scoped,pool: poolB,queue: queueB });
  const rpc = destinationRpcFixture({ config: scoped });
  const transactionManager = manager({ cfg: scoped,db: poolB,rpc: rpc.rpc });
  const worker = createRelayerWorker({ config: scoped,pool: poolB,queue: queueB,leases: repository,transactionManager });
  const result = await worker.runOnce();
  assert.equal(result.selected,0); assert.equal(result.submitted,0); assert.equal(result.skipped,0);
  assert.deepEqual(result.results,[]);
  await repository.withWorker(async session => {
    assert.deepEqual(await repository.listClaimableJobs({ session,limit: 100 }),[]);
    for (const job of jobs) assert.equal(await repository.tryAcquireLease(job.deliveryJobId,session),null);
  });
  assert.deepEqual(await leases.getLease(jobs[0].deliveryJobId),before);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${leaseTable}`)).rows[0].count,1);
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 });
  assert.equal(await transactionManager.repository.getAccount(),null);
  assert.equal(rpc.nodes.flatMap(node => node.broadcasts).length,0);
  assert.equal(rpc.nodes.flatMap(node => node.calls).some(call => ["eth_estimateGas","eth_getTransactionCount"].includes(call.method)),false);
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
});

test("SQL mixed destinations preserve local order and submit only local jobs at a larger limit", async () => {
  await useMultiDestinationFixture();
  const local = [jobs[0],jobs[2]];
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  await leases.withWorker(async session => {
    assert.deepEqual(await leases.listClaimableJobs({ session,limit: 100 }),local);
  });
  const worker = createRelayerWorker({ config,pool,queue,leases,transactionManager: reader });
  const result = await worker.runOnce();
  assert.equal(result.selected,2); assert.equal(result.submitted,2);
  assert.deepEqual(result.results.map(record => record.intent.deliveryJobId),local.map(job => job.deliveryJobId));
  assert.equal(await leases.getLease(jobs[1].deliveryJobId),null);
  assert.deepEqual(await counts(),{ intents: 2,attempts: 2 });
  assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
});

test("explicit foreign submission fails specifically before lease, intent, nonce, signing and RPC", async () => {
  await useMultiDestinationFixture();
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  let preparations = 0; let signatures = 0;
  const account = { ...h.options.account,async signTransaction(...args) {
    signatures++; return h.options.account.signTransaction(...args);
  } };
  const active = manager({ account });
  const transactionManager = { ...active,async prepareDeliveryTransaction(...args) {
    preparations++; return active.prepareDeliveryTransaction(...args);
  } };
  const worker = createRelayerWorker({ config,pool,queue,leases,transactionManager });
  await assert.rejects(worker.submitJob(jobs[1].deliveryJobId),{ code: "DESTINATION_CONTEXT_MISMATCH" });
  assert.equal(preparations,0); assert.equal(signatures,0);
  assert.equal(await leases.getLease(jobs[1].deliveryJobId),null);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${leaseTable}`)).rows[0].count,0);
  assert.deepEqual(await counts(),{ intents: 0,attempts: 0 });
  assert.equal(await active.repository.getAccount(),null);
  assert.deepEqual(destination.nodes.flatMap(node => node.calls),[]);
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
});

test("migration reruns preserve lease history; independent clients contend for one owner", async () => {
  const id = jobs[0].deliveryJobId;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const claims = await Promise.all([leases.tryAcquireLease(id,a),leasesB.tryAcquireLease(id,b)]);
    assert.equal(claims.filter(Boolean).length,1);
    const first = claims.find(Boolean); const repo = first.ownerId === a.workerId ? leases : leasesB;
    const session = first.ownerId === a.workerId ? a : b;
    assert.deepEqual(await repo.tryAcquireLease(id,session),first);
    await applyMigrations(pool,config.databaseSchema); assert.deepEqual(await repo.getLease(id),first);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${leaseTable} WHERE delivery_job_id = $1`,[id])).rows[0].count,1);
    await assert.rejects(pool.query(`UPDATE ${leaseTable} SET fencing_token = 0 WHERE delivery_job_id = $1`,[id]));
    await assert.rejects(pool.query(`DELETE FROM ${leaseTable} WHERE delivery_job_id = $1`,[id]),/history/);
  }));
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
});

test("DB time, renewal, stale rejection and release/reacquire retain monotonic tokens across clients", async () => {
  const id = jobs[0].deliveryJobId; let old;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    old = await leases.tryAcquireLease(id,a);
    // A different process clock cannot authoritatively expire a DB lease.
    h.advance(1000000000); assert.equal(await leasesB.tryAcquireLease(id,b),null);
    const renewed = await leases.renewLease(old); assert.equal(renewed.fencingToken,old.fencingToken);
    assert.ok(Date.parse(renewed.leaseExpiresAt) >= Date.parse(old.leaseExpiresAt));
    await assert.rejects(leasesB.renewLease({ ...old,ownerId: b.workerId,ownerSessionId: b.sessionId }),{ code: "STALE_FENCE" });
    await expire(id); const current = await leasesB.tryAcquireLease(id,b); assert.equal(current.fencingToken,"2");
    for (const action of [() => leases.renewLease(old),() => leases.releaseLease(old)]) await assert.rejects(action(),{ code: "STALE_FENCE" });
    const released = await leasesB.releaseLease(current); assert.deepEqual(await leasesB.releaseLease(current),released);
    const third = await leases.tryAcquireLease(id,a); assert.equal(third.fencingToken,"3");
    await leases.releaseLease(third); assert.equal((await leasesB.tryAcquireLease(id,b)).fencingToken,"4");
  }));
  const fresh = createDatabasePool(config);
  try {
    const restarted = createRelayerLeaseRepository({ config,pool: fresh,queue });
    assert.deepEqual(await restarted.getLease(id),await leases.getLease(id));
    await restarted.withWorker(async a => assert.equal(await restarted.tryAcquireLease(id,a),null));
  } finally { await fresh.end(); }
});

test("duplicate configured IDs fail fast without blocking distinct workers", async () => {
  const duplicate = createRelayerLeaseRepository({ config,pool: poolB,queue });
  await leases.withWorker(async a => {
    await assert.rejects(duplicate.withWorker(async () => {}),{ code: "RELAYER_WORKER_ALREADY_RUNNING" });
    await leasesB.withWorker(async b => {
      assert.notEqual(a.sessionId,b.sessionId); assert.notEqual(a.workerId,b.workerId);
      await leases.tryAcquireLease(jobs[0].deliveryJobId,a);
      const available = await leasesB.listClaimableJobs({ session: b });
      assert.equal(available.some(j => j.deliveryJobId === jobs[0].deliveryJobId),false);
      assert.ok(await leasesB.tryAcquireLease(available[0].deliveryJobId,b));
    });
  });
  await duplicate.withWorker(async () => {});
});

test("not-yet-due pending jobs do not fill the selection limit ahead of new work", async () => {
  const id = jobs[0].deliveryJobId;
  // Use the actual wall clock for retry scheduling, independent of the unit fixture clock.
  const active = manager({ clock: { now: Date.now } });
  const first = await active.submitDelivery(id);
  assert.equal(first.attempt.status,"BROADCAST");
  await leasesB.withWorker(async b => {
    const selected = await leasesB.listClaimableJobs({ session: b,limit: 1 });
    assert.equal(selected.length,1); assert.notEqual(selected[0].deliveryJobId,id);
  });
});

test("stale create/broadcast cannot mutate nonce or attempts; existing SIGNED identity survives takeover", async () => {
  const id = jobs[0].deliveryJobId; const beforeSource = await sourceState(pool,config.databaseSchema);
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const old = await leases.tryAcquireLease(id,a); await expire(id); const current = await leasesB.tryAcquireLease(id,b);
    await assert.rejects(reader.prepareDeliveryTransaction(id,{ fence: old }),{ code: "STALE_FENCE" });
    assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
    const active = manager({ cfg: configB,db: poolB });
    const results = await Promise.all(Array.from({ length: 4 },() => active.prepareDeliveryTransaction(id,{ fence: current })));
    assert.equal(results.filter(r => r.created).length,1); const signed = results[0]; const account = await active.repository.getAccount();
    await expire(id); const next = await leases.tryAcquireLease(id,a);
    const resumed = await reader.prepareDeliveryTransaction(id,{ fence: next });
    assert.deepEqual(resumed.attempt,signed.attempt); assert.deepEqual(resumed.intent,signed.intent);
    await assert.rejects(active.continueDeliveryTransactionOnce(id,{ fence: current }),{ code: "STALE_FENCE" });
    await assert.rejects(active.repository.broadcastPrepared(id,async () => { throw new Error("stale fence reached network"); },{ fence: current }),{ code: "STALE_FENCE" });
    assert.deepEqual(await reader.repository.getTransaction(id),{
      intent: signed.intent,attempt: signed.attempt,attempts: signed.attempts,winningAttempt: signed.winningAttempt });
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,0);
    destination.nodes[0].available = false;
    const sent = await reader.continueDeliveryTransactionOnce(id,{ fence: next });
    assert.equal(sent.acceptedEndpointLabel,"rpc-1"); assert.equal(sent.attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction);
    assert.equal(sent.attempt.transactionHash,signed.attempt.transactionHash); assert.equal(sent.intent.senderAddress,signed.intent.senderAddress);
    assert.deepEqual(await reader.repository.getAccount(),account); assert.deepEqual(await counts(),{ intents: 1,attempts: 1 });
    assert.deepEqual(await leases.getLease(id),await leasesB.getLease(id));
  }));
  assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs); assert.deepEqual(await sourceState(pool,config.databaseSchema),beforeSource);
});

test("different current owners race preparation through the same account lock without a second nonce space", async () => {
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const idA = jobs[0].deliveryJobId; const idB = jobs[1].deliveryJobId;
    const fenceA = await leases.tryAcquireLease(idA,a); const fenceB = await leasesB.tryAcquireLease(idB,b);
    const active = manager({ cfg: configB,db: poolB });
    const candidates = [{ manager: reader,id: idA,fence: fenceA },{ manager: active,id: idB,fence: fenceB }];
    const prepared = await Promise.allSettled(candidates.map(c => c.manager.prepareDeliveryTransaction(c.id,{ fence: c.fence })));
    assert.equal(prepared.filter(result => result.status === "fulfilled").length,1);
    const winner = candidates[prepared.findIndex(result => result.status === "fulfilled")];
    const waiting = candidates[prepared.findIndex(result => result.status === "rejected")];
    assert.equal(prepared.find(result => result.status === "rejected").reason.code,"SIGNED_TRANSACTION_REQUIRES_EXPLICIT_BROADCAST");
    const first = await winner.manager.continueDeliveryTransactionOnce(winner.id,{ fence: winner.fence });
    const secondPrepared = await waiting.manager.prepareDeliveryTransaction(waiting.id,{ fence: waiting.fence });
    const second = await waiting.manager.continueDeliveryTransactionOnce(waiting.id,{ fence: waiting.fence });
    assert.equal(BigInt(second.intent.nonce),BigInt(first.intent.nonce) + 1n); assert.equal(second.intent.senderAddress,first.intent.senderAddress);
    assert.equal(second.attempt.rawSignedTransaction,secondPrepared.attempt.rawSignedTransaction);
    assert.equal((await reader.repository.getAccount()).nextNonce,(BigInt(second.intent.nonce) + 1n).toString());
    assert.deepEqual(await counts(),{ intents: 2,attempts: 2 });
  }));
});

test("fence is rechecked after RPC and inside the signed commit boundary", async () => {
  const id = jobs[0].deliveryJobId;
  await leases.withWorker(async a => leasesB.withWorker(async b => {
    const old = await leases.tryAcquireLease(id,a);
    let switched = false;
    const stale = manager({ rpc: { ...destination.rpc,async fees() {
      const value = await destination.rpc.fees(); await expire(id); await leasesB.tryAcquireLease(id,b); switched = true; return value;
    } } });
    await assert.rejects(stale.prepareDeliveryTransaction(id,{ fence: old }),{ code: "STALE_FENCE" });
    assert.equal(switched,true); assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
    const current = await leasesB.getLease(id);
    const expiredDuringCommit = manager({ cfg: configB,db: poolB,beforeSignedCommit: async ({ client }) => {
      await client.query(`UPDATE ${leaseTable} SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
    } });
    await assert.rejects(expiredDuringCommit.prepareDeliveryTransaction(id,{ fence: current }),{ code: "STALE_FENCE" });
    assert.deepEqual(await counts(),{ intents: 0,attempts: 0 }); assert.equal(await reader.repository.getAccount(),null);
  }));
});

test("pending/replacement state is reused, final jobs and exhausted retries are excluded", async () => {
  const id = jobs[0].deliveryJobId;
  const workerA = createRelayerWorker({ config,pool,queue,leases,transactionManager: reader });
  const active = manager({ cfg: configB,db: poolB });
  const workerB = createRelayerWorker({ config: configB,pool: poolB,queue: queueB,leases: leasesB,transactionManager: active });
  const first = await workerA.submitJob(id); const pending = await workerB.submitJob(id);
  assert.deepEqual(pending.attempt,first.attempt);
  h.advance(config.replacementAfterMs); const replacement = await reader.prepareReplacement(id);
  const account = await reader.repository.getAccount(); destination.nodes[0].available = false;
  const sent = await workerB.submitJob(id);
  assert.equal(sent.attempts.length,2); assert.equal(sent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction);
  assert.equal(sent.attempt.nonce,first.attempt.nonce); assert.deepEqual(sent.attempts[0],replacement.attempts[0]);
  assert.deepEqual(await reader.repository.getAccount(),account);
  await reader.repository.stopRetry(id,"MAX_ATTEMPTS_REACHED"); const stopped = await reader.repository.getTransaction(id);
  assert.equal((await workerA.submitJob(id)).action,"BUSY"); assert.deepEqual(await reader.repository.getTransaction(id),stopped);
  // Existing independent manager outcome persistence does not require a lease.
  await reader.repository.recordOutcome(id,{ transactionHash: sent.attempt.transactionHash,status: 1,
    blockNumber: 100n,blockHash: config.destinationGenesisHash,head: 100n + config.destinationConfirmations - 1n });
  await leasesB.withWorker(async b => {
    assert.equal((await leasesB.listClaimableJobs({ session: b })).some(job => job.deliveryJobId === id),false);
    assert.equal(await leasesB.tryAcquireLease(id,b),null);
  });
  assert.deepEqual(await counts(),{ intents: 1,attempts: 2 });
});
