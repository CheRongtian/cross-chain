import assert from "node:assert/strict";
import { after,before,beforeEach,test } from "node:test";
import { privateKeyToAccount } from "viem/accounts";
import { randomUUID } from "node:crypto";
import { readdir,readFile } from "node:fs/promises";
import { applyMigrations,createDatabasePool,resetIndexerTables,tableName } from "../src/db.mjs";
import { createDeliveryRepository } from "../src/delivery/repository.mjs";
import { deliveryJson } from "../src/delivery/package.mjs";
import { formatRelayerSummary } from "../src/relayer/summary.mjs";
import { createTransactionManager } from "../src/transaction-manager/service.mjs";
import { verifySignedTransaction,signDeliveryTransaction } from "../src/transaction-manager/transaction.mjs";
import { transactionConfig,transactionHarness } from "./helpers/transaction-fixtures.mjs";
import { persistReadyTransactionFixture } from "./helpers/transaction-database-fixtures.mjs";
import { destinationRpcFixture,transactionBody,rpcTimeout } from "./helpers/destination-rpc-fixtures.mjs";
import { fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { sourceState } from "../../validator/test/helpers/four-process.mjs";
import { developmentKeys } from "../../validator/test/helpers/fixtures.mjs";

const config = transactionConfig({ DATABASE_URL: process.env.DATABASE_URL,
  INDEXER_DB_SCHEMA: `${process.env.INDEXER_DB_SCHEMA ?? "cross_chain_indexer_database_test"}_recovery`,
  CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]' });
const pool = createDatabasePool(config); const queue = createDeliveryRepository({ config,pool });
const eventTable = tableName(config.databaseSchema,"transaction_broadcast_events");
const attemptTable = tableName(config.databaseSchema,"transaction_attempts");
let h; let jobs; let destination; let reader;
before(async () => { await applyMigrations(pool,config.databaseSchema); });
beforeEach(async () => {
  await resetIndexerTables(pool,config.databaseSchema); await persistReadyTransactionFixture({ config,pool });
  jobs = await queue.listReadyDeliveryJobs(); h = await transactionHarness({ config });
  destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const attempt = (await pool.query(`SELECT * FROM ${attemptTable} WHERE raw_signed_transaction = $1`,[raw])).rows[0];
    assert.ok(attempt); const stored = await reader.repository.getTransaction(attempt.delivery_job_id);
    const journal = await reader.repository.getBroadcastEvents(attempt.delivery_job_id);
    assert.ok(journal.some(e => e.attemptId === attempt.attempt_id && e.endpointLabel !== null && e.completedAt === null),"committed endpoint marker must be visible before every raw send");
    const exact = stored.attempts.find(a => a.attemptId === attempt.attempt_id); await verifySignedTransaction(stored.intent,exact);
    return transactionBody(stored.intent,exact);
  } }); reader = manager();
});
after(async () => { await pool.end(); });
function manager({ db = pool,cfg = config,hooks = {},rpc = destination.rpc,account } = {}) {
  return createTransactionManager({ config: cfg,pool: db,queue: createDeliveryRepository({ config: cfg,pool: db }),rpc,hooks,account,clock: h.clock });
}
function crashOnce() { let active = true; return async () => { if (active) { active = false; throw Object.assign(new Error("controlled database checkpoint"),{ code: "TEST_CHECKPOINT" }); } }; }
async function mine(id,attemptId,status = 1) {
  const stored = await reader.repository.getTransaction(id); const winner = stored.attempts.find(a => a.attemptId === attemptId);
  destination.receipts.set(winner.transactionHash,{ transactionHash: winner.transactionHash,blockNumber: "0x64",blockHash: fixtureHash(1100),status: status ? "0x1" : "0x0" });
  destination.transactions.set(winner.transactionHash,transactionBody(stored.intent,winner,100n,fixtureHash(1100)));
  destination.nodes.forEach(node => { node.head = 102n; node.latestNonce = BigInt(stored.intent.nonce) + 1n; });
}

const accountTable = tableName(config.databaseSchema,"transaction_accounts");
async function scanProgress(db = pool,cfg = config) {
  return (await db.query(`SELECT receipt_scan_cursor_nonce::text AS receipt,recovery_scan_cursor_nonce::text AS recovery,
    next_nonce::text AS next_nonce,updated_at FROM ${accountTable} WHERE chain_id = $1 AND sender_address = $2`,
    [cfg.destinationDomain.toString(),cfg.relayerAddress])).rows[0];
}
async function pendingPopulation() {
  for (const job of jobs) await reader.submitDelivery(job.deliveryJobId);
}
async function incompleteEarlierReceipts() {
  await pendingPopulation();
  for (const job of jobs) {
    const stored = await reader.repository.getTransaction(job.deliveryJobId);
    await mine(job.deliveryJobId,stored.attempt.attemptId);
    if (job !== jobs.at(-1)) destination.receipts.delete(stored.attempt.transactionHash);
  }
}

test("SQL observation selectors wrap with exact large nonces and leave allocation, recovery versions and signed evidence unchanged", async () => {
  assert.deepEqual(await reader.repository.listRecoveryIntents({ limit: 1 }),[]);
  assert.deepEqual(await reader.repository.listTrackingIntents({ limit: 1 }),[]); assert.equal(await reader.repository.getAccount(),null);
  const base = (1n << 200n) + 17n; destination.nodes.forEach(node => { node.pendingNonce = base; });
  await pendingPopulation();
  const ids = jobs.map(job => job.deliveryJobId);
  const before = await Promise.all(ids.map(id => reader.repository.getRecoverySnapshot(id)));
  const account = await reader.repository.getAccount(); const activity = destination.nodes.map(node => node.calls.length);
  const fresh = createDatabasePool(config);
  try {
    for (const kind of ["receipt","recovery"]) {
      const select = async limit => {
        const repository = manager({ db: fresh }).repository;
        return kind === "receipt" ? (await repository.listTrackingIntents({ limit })).map(r => r.intent.deliveryJobId) : repository.listRecoveryIntents({ limit });
      };
      assert.deepEqual(await select(1),[ids[0]]);
      assert.equal((await scanProgress())[kind],base.toString());
      assert.deepEqual(await select(1),[ids[1]]);
      assert.deepEqual(await select(100),[ids[2],ids[0],ids[1]]);
      const column = kind === "receipt" ? "receipt_scan_cursor_nonce" : "recovery_scan_cursor_nonce";
      await pool.query(`UPDATE ${accountTable} SET ${column} = $3 WHERE chain_id = $1 AND sender_address = $2`,
        [config.destinationDomain.toString(),config.relayerAddress,((1n << 256n) - 1n).toString()]);
      assert.deepEqual(await select(100),ids);
      assert.equal((await scanProgress())[kind],(base + 2n).toString());
    }
    assert.deepEqual(await Promise.all(ids.map(id => reader.repository.getRecoverySnapshot(id))),before);
    assert.deepEqual(await reader.repository.getAccount(),account);
    assert.deepEqual(destination.nodes.map(node => node.calls.length),activity);
  } finally { await fresh.end(); }
});

for (const kind of ["receipt","recovery"]) {
  test(`SQL ${kind} limit=1 fresh pools observe a later canonical receipt behind incomplete earlier evidence`, async () => {
    await incompleteEarlierReceipts();
    const offered = []; const activity = destination.nodes.flatMap(node => node.broadcasts).length;
    for (let round = 0; round < jobs.length; round++) {
      const fresh = createDatabasePool(config);
      try {
        const observer = manager({ db: fresh });
        const result = kind === "receipt" ? await observer.checkReceiptsOnce({ limit: 1 }) : await observer.recoverTransactionsOnce({ limit: 1 });
        assert.equal(kind === "receipt" ? result.checked : result.scanned,1);
        offered.push(kind === "receipt" ? result.results[0].intent.deliveryJobId : result.results[0].deliveryJobId);
        assert.equal(kind === "receipt" ? result.confirmed : result.finalized,round === 2 ? 1 : 0);
      } finally { await fresh.end(); }
    }
    assert.deepEqual(offered,jobs.map(job => job.deliveryJobId));
    assert.equal((await reader.repository.getTransaction(jobs[0].deliveryJobId)).intent.status,"PENDING");
    assert.equal((await reader.repository.getTransaction(jobs[0].deliveryJobId)).intent.retryStoppedAt,null);
    assert.equal((await reader.repository.getTransaction(jobs[2].deliveryJobId)).intent.status,"CONFIRMED");
    assert.equal((await scanProgress())[kind === "receipt" ? "recovery" : "receipt"],null);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,activity);
    if (kind === "recovery") {
      const before = await scanProgress();
      await reader.recoverTransactionsOnce({ deliveryJobId: jobs[0].deliveryJobId });
      assert.deepEqual(await scanProgress(),before,"explicit recovery must not move either bulk cursor");
    }
  });
}

test("SQL concurrent cursor selection serializes ranges while receipt and recovery progress remain independent", async () => {
  await pendingPopulation(); const fresh = createDatabasePool(config);
  try {
    const other = manager({ db: fresh });
    const selected = await Promise.all([reader.repository.listRecoveryIntents({ limit: 1 }),other.repository.listRecoveryIntents({ limit: 1 })]);
    assert.deepEqual(new Set(selected.flat()),new Set(jobs.slice(0,2).map(job => job.deliveryJobId)));
    const nonces = await Promise.all(jobs.map(async job => (await reader.repository.getTransaction(job.deliveryJobId)).intent.nonce));
    assert.equal((await scanProgress()).recovery,nonces[1]); assert.equal((await scanProgress()).receipt,null);
    const [receipt,recovery] = await Promise.all([other.repository.listTrackingIntents({ limit: 1 }),reader.repository.listRecoveryIntents({ limit: 1 })]);
    assert.equal(receipt[0].intent.deliveryJobId,jobs[0].deliveryJobId); assert.deepEqual(recovery,[jobs[2].deliveryJobId]);
    const progress = await scanProgress(); assert.equal(progress.receipt,nonces[0]); assert.equal(progress.recovery,nonces[2]);
  } finally { await fresh.end(); }
});

test("SQL observation account locks are released before receipt or recovery RPC access", async () => {
  await pendingPopulation(); const fresh = createDatabasePool(config); let probes = 0;
  try {
    const rpc = { ...destination.rpc,async verifyChain() {
      // NOWAIT makes an accidental account lock across RPC fail immediately.
      await fresh.query(`SELECT chain_id FROM ${accountTable} WHERE chain_id = $1 AND sender_address = $2 FOR UPDATE NOWAIT`,
        [config.destinationDomain.toString(),config.relayerAddress]); probes++;
      return destination.rpc.verifyChain();
    } };
    await manager({ rpc }).checkReceiptsOnce({ limit: 1 });
    await manager({ rpc }).recoverTransactionsOnce({ limit: 1 });
    assert.ok(probes >= 2);
  } finally { await fresh.end(); }
});

test("SQL cursors isolate senders and chains without creating an account or changing a nonce allocator", async () => {
  for (const job of jobs.slice(0,2)) await reader.submitDelivery(job.deliveryJobId);
  const key = developmentKeys(9)[8]; const account = privateKeyToAccount(key);
  const cfg = { ...config,privateKey: key,relayerAddress: account.address.toLowerCase() };
  const rpc = destinationRpcFixture({ config: cfg }); const other = manager({ cfg,rpc: rpc.rpc,account });
  await other.submitDelivery(jobs[2].deliveryJobId);
  assert.deepEqual(await reader.repository.listRecoveryIntents({ limit: 100 }),jobs.slice(0,2).map(job => job.deliveryJobId));
  assert.equal((await scanProgress(pool,cfg)).recovery,null);
  assert.deepEqual(await other.repository.listRecoveryIntents({ limit: 100 }),[jobs[2].deliveryJobId]);
  assert.equal((await scanProgress()).receipt,null); assert.equal((await scanProgress(pool,cfg)).receipt,null);
  const otherChain = manager({ cfg: { ...config,destinationDomain: 3001n } });
  assert.deepEqual(await otherChain.repository.listRecoveryIntents({ limit: 1 }),[]);
  assert.deepEqual(await otherChain.repository.listTrackingIntents({ limit: 1 }),[]);
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${accountTable}`)).rows[0].count,2);
});

test("SQL observation sees a newly allocated highest nonce before wrapping to earlier pending work", async () => {
  await pendingPopulation(); const ids = jobs.map(job => job.deliveryJobId);
  await reader.repository.listRecoveryIntents({ limit: 2 }); await reader.repository.listTrackingIntents({ limit: 2 });
  await persistReadyTransactionFixture({ config,pool,append: true,count: 1,epoch: 24n,messageOffset: 100 });
  const next = (await queue.listReadyDeliveryJobs()).find(job => !ids.includes(job.deliveryJobId));
  await reader.submitDelivery(next.deliveryJobId);
  assert.deepEqual(await reader.repository.listRecoveryIntents({ limit: 3 }),[ids[2],next.deliveryJobId,ids[0]]);
  assert.deepEqual((await reader.repository.listTrackingIntents({ limit: 3 })).map(r => r.intent.deliveryJobId),[ids[2],next.deliveryJobId,ids[0]]);
});

test("SQL wrap includes a newly eligible earlier nonce, drops terminal rows and repeats single pending work", async () => {
  const prepared = [];
  for (const job of jobs) prepared.push(await reader.prepareDeliveryTransaction(job.deliveryJobId));
  // Only later hashes have become visible to the existing manager so far.
  for (let index = 1; index < 3; index++) await reader.repository.markKnownAttempt(jobs[index].deliveryJobId,prepared[index].attempt.attemptId);
  assert.equal((await reader.repository.listTrackingIntents({ limit: 2 }))[1].intent.deliveryJobId,jobs[2].deliveryJobId);
  await reader.repository.markKnownAttempt(jobs[0].deliveryJobId,prepared[0].attempt.attemptId);
  assert.equal((await reader.repository.listTrackingIntents({ limit: 1 }))[0].intent.deliveryJobId,jobs[0].deliveryJobId);
  for (let index = 0; index < 2; index++) await reader.repository.recordOutcome(jobs[index].deliveryJobId,{
    transactionHash: prepared[index].attempt.transactionHash,status: 1,blockNumber: 100n,blockHash: fixtureHash(1100),head: 102n });
  for (let round = 0; round < 3; round++) assert.deepEqual(await reader.repository.listRecoveryIntents({ limit: 100 }),[jobs[2].deliveryJobId]);
  await reader.repository.recordOutcome(jobs[2].deliveryJobId,{ transactionHash: prepared[2].attempt.transactionHash,
    status: 0,blockNumber: 100n,blockHash: fixtureHash(1100),head: 102n });
  const progress = await scanProgress();
  assert.deepEqual(await reader.repository.listRecoveryIntents({ limit: 1 }),[]);
  assert.deepEqual(await reader.repository.listTrackingIntents({ limit: 1 }),[]);
  assert.deepEqual(await scanProgress(),progress);
});

test("observation migration preserves old accounts, allocator, winners, receipts, journal and recovery versions", async () => {
  const schema = "scan_upgrade_" + randomUUID().replaceAll("-",""); const cfg = { ...config,databaseSchema: schema };
  const client = await pool.connect(); let open = false; let failure;
  try {
    const names = (await readdir(new URL("../migrations/",import.meta.url))).filter(name => /^\d+_.*\.sql$/.test(name) && Number(name.slice(0,3)) <= 16).sort();
    await client.query("BEGIN"); open = true; await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query("CREATE TABLE schema_migrations (name TEXT PRIMARY KEY,applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const name of names) {
      await client.query(await readFile(new URL("../migrations/" + name,import.meta.url),"utf8"));
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)",[name]);
    }
    await client.query("COMMIT"); open = false;
    await persistReadyTransactionFixture({ config: cfg,pool });
    const q = createDeliveryRepository({ config: cfg,pool }); const oldJobs = await q.listReadyDeliveryJobs();
    const legacy = manager({ cfg });
    // Freeze the pre-upgrade data shape with the existing signing primitive
    // and old SQL guards. Do not run a new-schema manager against old tables.
    await client.query("BEGIN"); open = true;
    await client.query(`INSERT INTO ${tableName(schema,"transaction_accounts")} (chain_id,sender_address,next_nonce) VALUES ($1,$2,9)`,
      [cfg.destinationDomain.toString(),cfg.relayerAddress]);
    for (const [index,job] of oldJobs.entries()) {
      const intent = await legacy.resolveIntent(job.deliveryJobId); const nonce = 9n + BigInt(index);
      const signed = await signDeliveryTransaction({ ...intent,nonce: nonce.toString() },{
        nonce,gasLimit: 123456n,maxFeePerGas: 3000000000n,maxPriorityFeePerGas: 1000000000n },privateKeyToAccount(cfg.privateKey));
      await client.query(`UPDATE ${tableName(schema,"transaction_accounts")} SET next_nonce = $1`,[(nonce + 1n).toString()]);
      await client.query(`INSERT INTO ${tableName(schema,"transaction_intents")} (delivery_job_id,package_digest,chain_id,sender_address,
        destination_gateway,value,calldata,nonce,next_action_at) VALUES ($1,$2,$3,$4,$5,0,$6,$7,$8)`,
      [job.deliveryJobId,intent.packageDigest,intent.chainId,intent.senderAddress,intent.destinationGateway,intent.calldata,nonce.toString(),new Date(h.clock.now())]);
      const a = (await client.query(`INSERT INTO ${tableName(schema,"transaction_attempts")} (delivery_job_id,chain_id,sender_address,status,nonce,gas_limit,
        max_fee_per_gas,max_priority_fee_per_gas,transaction_type,raw_signed_transaction,transaction_hash)
        VALUES ($1,$2,$3,'SIGNED',$4,123456,3000000000,1000000000,2,$5,$6) RETURNING attempt_id`,
      [job.deliveryJobId,intent.chainId,intent.senderAddress,nonce.toString(),signed.rawSignedTransaction,signed.transactionHash])).rows[0];
      await client.query(`UPDATE ${tableName(schema,"transaction_attempts")} SET status = 'BROADCAST',broadcast_at = $2,
        broadcast_attempt_count = 1,last_broadcast_attempt_at = $2 WHERE attempt_id = $1`,[a.attempt_id,new Date(h.clock.now())]);
      const event = (await client.query(`INSERT INTO ${tableName(schema,"transaction_broadcast_events")} (attempt_id,broadcast_sequence) VALUES ($1,1) RETURNING event_id`,[a.attempt_id])).rows[0];
      await client.query(`UPDATE ${tableName(schema,"transaction_broadcast_events")} SET completed_at = clock_timestamp(),result_class = 'ACCEPTED',returned_tx_hash = $2
        WHERE event_id = $1`,[event.event_id,signed.transactionHash]);
    }
    await client.query("COMMIT"); open = false;
    for (const [index,status] of [1,0].entries()) {
      const stored = await legacy.repository.getTransaction(oldJobs[index].deliveryJobId);
      // Construct a genuine pre-upgrade terminal cache using that schema's
      // existing guards; the current manager requires the new migration.
      await client.query("BEGIN"); open = true;
      await client.query(`UPDATE ${tableName(schema,"transaction_attempts")} SET status = $2,receipt_block_number = 100,
        receipt_block_hash = $3,receipt_status = $4,confirmed_head = 102,confirmed_at = $5 WHERE attempt_id = $1`,
      [stored.attempt.attemptId,status === 1 ? "CONFIRMED" : "REVERTED",fixtureHash(1100),status,new Date(h.clock.now())]);
      await client.query(`UPDATE ${tableName(schema,"transaction_intents")} SET status = $2,winning_attempt_id = $3,next_action_at = NULL WHERE delivery_job_id = $1`,
      [oldJobs[index].deliveryJobId,status === 1 ? "CONFIRMED" : "REVERTED",stored.attempt.attemptId]);
      await client.query("COMMIT"); open = false;
    }
    const accountName = tableName(schema,"transaction_accounts");
    const account = (await pool.query(`SELECT * FROM ${accountName}`)).rows[0];
    const snapshots = await Promise.all(oldJobs.map(job => legacy.repository.getRecoverySnapshot(job.deliveryJobId)));
    const source = await sourceState(pool,schema);
    assert.equal((await applyMigrations(pool,schema)).at(-1),"018_destination_receipt_reconciliation.sql");
    const { receipt_scan_cursor_nonce,recovery_scan_cursor_nonce,terminal_scan_cursor_nonce,...unchanged } = (await pool.query(`SELECT * FROM ${accountName}`)).rows[0];
    assert.equal(receipt_scan_cursor_nonce,null); assert.equal(recovery_scan_cursor_nonce,null); assert.equal(terminal_scan_cursor_nonce,null); assert.deepEqual(unchanged,account);
    for (const [index,status] of [1,0].entries()) {
      const history = await legacy.repository.getReceiptObservations(oldJobs[index].deliveryJobId);
      assert.equal(history.length,1); assert.equal(history[0].status,status); assert.equal(history[0].orphaned,false);
      assert.equal(history[0].transactionHash,snapshots[index].winningAttempt.transactionHash);
      assert.equal(history[0].blockHash,snapshots[index].winningAttempt.receiptBlockHash);
      assert.equal(history[0].confirmedAt,snapshots[index].winningAttempt.confirmedAt);
    }
    await applyMigrations(pool,schema);
    assert.deepEqual(await Promise.all(oldJobs.map(job => legacy.repository.getRecoverySnapshot(job.deliveryJobId))),snapshots);
    assert.deepEqual(await sourceState(pool,schema),source);
    const columns = (await pool.query(`SELECT column_name,data_type,numeric_precision,numeric_scale,is_nullable FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = 'transaction_accounts' AND column_name IN ('receipt_scan_cursor_nonce','recovery_scan_cursor_nonce')`,[schema])).rows;
    assert.equal(columns.length,2);
    for (const column of columns) {
      assert.equal(column.data_type,"numeric"); assert.equal(column.numeric_precision,78); assert.equal(column.numeric_scale,0); assert.equal(column.is_nullable,"YES");
    }
    for (const value of ["-1",(1n << 256n).toString()]) await assert.rejects(pool.query(`UPDATE ${accountName} SET receipt_scan_cursor_nonce = $1`,[value]),
      error => error.code === "23514" && error.constraint === "transaction_accounts_receipt_scan_cursor_nonce_check");
    const progress = ((1n << 200n) + 123n).toString();
    await pool.query(`UPDATE ${accountName} SET receipt_scan_cursor_nonce = $1`,[progress]);
    await applyMigrations(pool,schema);
    assert.equal((await pool.query(`SELECT receipt_scan_cursor_nonce::text AS cursor FROM ${accountName}`)).rows[0].cursor,progress);
    assert.equal((await legacy.repository.getAccount()).nextNonce,account.next_nonce);
  } catch (error) { failure = error; throw error; }
  finally {
    try {
      if (open) await client.query("ROLLBACK");
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch (error) { if (!failure) throw error; console.error("observation upgrade cleanup failed: " + error.message); }
    finally { client.release(); }
  }
});

const immutableAttemptFields = ["attemptId","attemptNumber","replacementOfAttemptId","nonce","gasLimit",
  "maxFeePerGas","maxPriorityFeePerGas","rawSignedTransaction","transactionHash","createdAt"];

async function terminalSqlFixture(status = 1) {
  const id = jobs[0].deliveryJobId; const sent = await reader.submitDelivery(id);
  await mine(id,sent.attempt.attemptId,status); await reader.checkReceiptsOnce();
  const original = await reader.repository.getTransaction(id);
  assert.equal(original.intent.status,status ? "CONFIRMED" : "REVERTED");
  return { id,original,account: await reader.repository.getAccount(),source: await sourceState(pool,config.databaseSchema),
    history: await reader.repository.getReceiptObservations(id),journal: await reader.repository.getBroadcastEvents(id) };
}
function orphanSqlBranch(original,{ replay = false } = {}) {
  destination.receipts.clear(); destination.transactions.clear();
  destination.nodes.forEach(node => {
    node.blocks.set("100",{ number: "0x64",hash: fixtureHash(7000) });
    node.latestNonce = BigInt(original.intent.nonce); node.pendingNonce = BigInt(original.intent.nonce); node.replay = replay;
  });
}

for (const status of [1,0]) test(`SQL proven reorg preserves ${status ? "CONFIRMED" : "REVERTED"} history and recovers exact signed bytes through fresh clients`, async () => {
  const f = await terminalSqlFixture(status); const { id,original,account,history } = f;
  const intentTable = tableName(config.databaseSchema,"transaction_intents");
  await assert.rejects(pool.query(`UPDATE ${intentTable} SET status = 'PENDING',winning_attempt_id = NULL,
    current_receipt_observation_id = NULL,next_action_at = clock_timestamp() WHERE delivery_job_id = $1`,[id]),/proven-reorg/);
  await assert.rejects(pool.query(`UPDATE ${attemptTable} SET status = 'BROADCAST' WHERE delivery_job_id = $1`,[id]),/illegal transaction status transition/);
  const receiptTable = tableName(config.databaseSchema,"transaction_receipt_observations");
  await assert.rejects(pool.query(`DELETE FROM ${receiptTable} WHERE delivery_job_id = $1`,[id]),/append-only/);
  await assert.rejects(pool.query(`UPDATE ${receiptTable} SET block_hash = $2 WHERE delivery_job_id = $1`,[id,fixtureHash(9000)]),/append-only/);
  orphanSqlBranch(original);
  const activity = destination.nodes.flatMap(node => node.calls).filter(call => ["eth_estimateGas","eth_maxPriorityFeePerGas"].includes(call.method)).length;
  const fresh = createDatabasePool(config);
  try {
    const restarted = manager({ db: fresh });
    assert.equal((await restarted.checkReceiptsOnce()).terminal.results[0].action,"REORG_RECOVERY");
    const recovering = await restarted.repository.getTransaction(id);
    assert.equal(recovering.intent.status,"PENDING"); assert.equal(recovering.intent.winningAttemptId,null);
    assert.equal(recovering.intent.reorgRecovery.rebroadcastRequired,true);
    assert.equal(recovering.intent.nextActionAt,new Date(h.clock.now()).toISOString());
    assert.equal(recovering.intent.retryStoppedAt,null); assert.equal(recovering.intent.retryStopReason,null);
    for (const field of immutableAttemptFields) assert.ok(recovering.attempt[field] === original.attempt[field],`reorg must preserve ${field}`);
    const [old] = await restarted.repository.getReceiptObservations(id);
    for (const field of ["observationId","transactionHash","blockNumber","blockHash","status","confirmedHead","confirmedAt"]) {
      assert.equal(old[field],history[0][field],`archived ${field} must remain unchanged`);
    }
    assert.equal(old.orphaned,true);
    await assert.rejects(pool.query(`UPDATE ${tableName(config.databaseSchema,"transaction_receipt_orphans")} SET observed_head = observed_head + 1`),/append-only/);
    assert.equal((await restarted.processTransactionRetriesOnce()).broadcasts,1);
    await mine(id,original.attempt.attemptId,status);
    // Re-inclusion uses a genuinely different canonical cache in the fixture.
    const receipt = destination.receipts.get(original.attempt.transactionHash); receipt.blockHash = fixtureHash(7000);
    destination.transactions.set(original.attempt.transactionHash,transactionBody(original.intent,original.attempt,100n,fixtureHash(7000)));
    await restarted.checkReceiptsOnce();
    const final = await restarted.repository.getTransaction(id); assert.equal(final.intent.status,status ? "CONFIRMED" : "REVERTED");
    assert.equal(final.attempts.length,1); assert.equal(final.winningAttempt.receiptBlockHash,fixtureHash(7000));
    const observed = await restarted.repository.getReceiptObservations(id);
    assert.equal(observed.length,2); assert.deepEqual(observed[0],old); assert.equal(observed[1].orphaned,false);
    assert.deepEqual(await restarted.repository.getAccount(),account);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),f.source);
    assert.equal(destination.nodes.flatMap(node => node.calls).filter(call => ["eth_estimateGas","eth_maxPriorityFeePerGas"].includes(call.method)).length,activity);
    const journal = await restarted.repository.getBroadcastEvents(id);
    assert.deepEqual(journal.slice(0,f.journal.length),f.journal);
    assert.equal(journal.filter(event => event.parentEventId === null && event.resultClass === "ACCEPTED").length,2);
    const state = await restarted.repository.getTransaction(id); const preserved = await restarted.repository.getReceiptObservations(id);
    await applyMigrations(pool,config.databaseSchema);
    assert.deepEqual(await restarted.repository.getTransaction(id),state); assert.deepEqual(await restarted.repository.getReceiptObservations(id),preserved);
  } finally { await fresh.end(); }
});

for (const status of [1,0]) test(`SQL proven reorg preserves a stopped ${status ? "CONFIRMED" : "REVERTED"} intent without scheduling another send`, async () => {
  const id = jobs[0].deliveryJobId; const sent = await reader.submitDelivery(id);
  await reader.repository.stopRetry(id,"MAX_ATTEMPTS_REACHED");
  const stopped = await reader.repository.getTransaction(id);
  assert.notEqual(stopped.intent.retryStoppedAt,null); assert.equal(stopped.intent.nextActionAt,null);
  await mine(id,sent.attempt.attemptId,status); await reader.checkReceiptsOnce();
  const original = await reader.repository.getTransaction(id);
  assert.equal(original.intent.status,status ? "CONFIRMED" : "REVERTED");
  const account = await reader.repository.getAccount(); const journal = await reader.repository.getBroadcastEvents(id);
  const [historical] = await reader.repository.getReceiptObservations(id);
  const sends = destination.nodes.flatMap(node => node.broadcasts).length;
  orphanSqlBranch(original);
  const result = await reader.checkReceiptsOnce();
  assert.equal(result.terminal.results[0].action,"REORG_RECOVERY");
  const recovering = await reader.repository.getTransaction(id);
  assert.equal(recovering.intent.status,"PENDING"); assert.equal(recovering.intent.winningAttemptId,null);
  assert.equal(recovering.intent.nextActionAt,null);
  assert.equal(recovering.intent.retryStoppedAt,stopped.intent.retryStoppedAt);
  assert.equal(recovering.intent.retryStopReason,"MAX_ATTEMPTS_REACHED");
  assert.equal(recovering.intent.reorgRecovery.rebroadcastRequired,true);
  for (const field of immutableAttemptFields) assert.ok(recovering.attempt[field] === original.attempt[field],`stopped reorg must preserve ${field}`);
  const [orphaned] = await reader.repository.getReceiptObservations(id);
  for (const field of ["observationId","transactionHash","blockNumber","blockHash","status","confirmedHead","confirmedAt"]) {
    assert.equal(orphaned[field],historical[field],`stopped reorg must retain archived ${field}`);
  }
  assert.equal(orphaned.orphaned,true);
  assert.equal((await reader.processTransactionRetriesOnce()).processed,0);
  assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,sends);
  assert.deepEqual((await reader.repository.getTransaction(id)).intent,recovering.intent);
  assert.deepEqual(await reader.repository.getBroadcastEvents(id),journal);
  assert.deepEqual(await reader.repository.getAccount(),account);
  await assert.rejects(pool.query(`UPDATE ${tableName(config.databaseSchema,"transaction_intents")}
    SET retry_stopped_at = NULL,retry_stop_reason = NULL,next_action_at = clock_timestamp() WHERE delivery_job_id = $1`,[id]),/cannot be reset/);
});

test("SQL concurrent canonicality passes archive one orphan and preserve bounded terminal progress across clients", async () => {
  const { id,original,account } = await terminalSqlFixture(); orphanSqlBranch(original);
  const fresh = createDatabasePool(config);
  try {
    const restarted = manager({ db: fresh });
    await Promise.all([reader.checkReceiptsOnce({ limit: 1 }),restarted.checkReceiptsOnce({ limit: 1 })]);
    const observations = await restarted.repository.getReceiptObservations(id);
    assert.equal(observations.length,1); assert.equal(observations[0].orphaned,true);
    assert.deepEqual(await restarted.repository.getTransaction(id),await reader.repository.getTransaction(id));
    const progress = (await fresh.query(`SELECT terminal_scan_cursor_nonce::text AS terminal FROM ${accountTable}`)).rows[0];
    assert.equal(progress.terminal,original.intent.nonce); assert.deepEqual(await restarted.repository.getAccount(),account);
    await Promise.all([reader.processTransactionRetriesOnce(),restarted.processTransactionRetriesOnce()]);
    assert.equal((await reader.repository.getTransaction(id)).attempts.length,1);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  } finally { await fresh.end(); }
});

test("SQL terminal scan is independent, bounded and fair while pending receipt work continues", async () => {
  for (const job of jobs) await reader.submitDelivery(job.deliveryJobId);
  for (const job of jobs.slice(0,2)) {
    const stored = await reader.repository.getTransaction(job.deliveryJobId); await mine(job.deliveryJobId,stored.attempt.attemptId);
  }
  await reader.checkReceiptsOnce();
  const observed = [];
  for (let round = 0; round < 4; round++) {
    const fresh = createDatabasePool(config);
    try {
      const result = await manager({ db: fresh }).checkReceiptsOnce({ limit: 1 });
      assert.equal(result.checked,1); assert.equal(result.results[0].intent.deliveryJobId,jobs[2].deliveryJobId);
      assert.equal(result.terminal.checked,1); observed.push(result.terminal.results[0].deliveryJobId);
    } finally { await fresh.end(); }
  }
  assert.deepEqual(observed,[jobs[0].deliveryJobId,jobs[1].deliveryJobId,jobs[0].deliveryJobId,jobs[1].deliveryJobId]);
});

test("SQL canonical re-inclusion adopts an existing sibling without re-signing or a new send", async () => {
  const id = jobs[0].deliveryJobId; const parent = await reader.submitDelivery(id);
  h.advance(config.replacementAfterMs); const child = await reader.prepareReplacement(id);
  await mine(id,parent.attempt.attemptId); await reader.checkReceiptsOnce();
  const original = await reader.repository.getTransaction(id); orphanSqlBranch(original);
  await mine(id,child.attempt.attemptId);
  destination.receipts.get(child.attempt.transactionHash).blockHash = fixtureHash(7000);
  destination.transactions.set(child.attempt.transactionHash,transactionBody(original.intent,child.attempt,100n,fixtureHash(7000)));
  const result = await reader.checkReceiptsOnce(); assert.equal(result.terminal.results[0].action,"REINCLUDED");
  const stored = await reader.repository.getTransaction(id);
  assert.equal(stored.winningAttempt.attemptId,child.attempt.attemptId); assert.equal(stored.attempts.length,2);
  assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
});
function sameSignedAttempt(before,after) {
  for (const field of immutableAttemptFields) assert.equal(after[field],before[field]);
}
async function replacementWithPendingParent() {
  const id = jobs[0].deliveryJobId;
  const parent = await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  const replacement = await reader.prepareReplacement(id);
  assert.equal(replacement.created,true); assert.equal(replacement.attempt.status,"SIGNED");
  assert.equal(replacement.attempt.broadcastAttemptCount,"0");
  assert.equal((await destination.rpc.transaction(parent.attempt.transactionHash)).blockNumber,null);
  assert.equal(destination.receipts.has(parent.attempt.transactionHash),false);
  return { id,parent,replacement,account: await reader.repository.getAccount() };
}

test("a fresh client broadcasts the exact persisted replacement through failover while its parent remains pending", async () => {
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  assert.ok(Date.parse(replacement.intent.nextActionAt) > h.clock.now());
  assert.equal((await reader.repository.getBroadcastEvents(id)).filter(event => event.attemptId === replacement.attempt.attemptId).length,0);
  const fresh = createDatabasePool(config); destination.nodes[0].available = false;
  try {
    const rpc = { ...destination.restart().rpc,
      async estimateGas() { assert.fail("durable replacement recovery must not estimate gas"); },
      async fees() { assert.fail("durable replacement recovery must not resolve fees"); } };
    const recovered = manager({ db: fresh,rpc,account: { address: config.relayerAddress,
      async signTransaction() { assert.fail("durable replacement recovery must not re-sign"); } } });
    const persisted = await recovered.repository.getTransaction(id);
    sameSignedAttempt(replacement.attempt,persisted.attempt);
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.rebroadcast,1); assert.equal(result.results[0].acceptedEndpointLabel,"rpc-1");
    const stored = await recovered.repository.getTransaction(id);
    assert.equal(stored.attempt.status,"BROADCAST");
    assert.deepEqual(stored.attempts.map(attempt => attempt.attemptNumber),[0,1]);
    sameSignedAttempt(replacement.attempt,stored.attempt); sameSignedAttempt(parent.attempt,stored.attempts[0]);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.deepEqual(destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction]);
    assert.deepEqual(destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,0);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
    await mine(id,replacement.attempt.attemptId);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    const final = await recovered.repository.getTransaction(id);
    assert.equal(final.intent.winningAttemptId,replacement.attempt.attemptId);
    assert.equal(final.intent.status,"CONFIRMED"); assert.equal(final.attempts.length,2);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("a replacement's pre-send marker recovers without confusing the visible pending parent", async () => {
  const { id,replacement,account } = await replacementWithPendingParent();
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } });
  await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  const marker = (await reader.repository.getBroadcastEvents(id)).find(event => event.attemptId === replacement.attempt.attemptId);
  assert.equal(marker.completedAt,null); assert.equal(destination.transactions.has(replacement.attempt.transactionHash),false);
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,1);
    sameSignedAttempt(replacement.attempt,(await recovered.repository.getTransaction(id)).attempt);
    assert.equal((await recovered.repository.getBroadcastEvents(id)).find(event => event.eventId === marker.eventId).resultClass,"RECONCILED");
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  } finally { await fresh.end(); }
});

test("historical journal reconciliation advances the version before sending a persisted replacement", async () => {
  const id = jobs[0].deliveryJobId; await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  await assert.rejects(manager({ hooks: { afterBroadcastStart: crashOnce() } }).rebroadcastTransaction(id),{ code: "TEST_CHECKPOINT" });
  h.advance(config.rebroadcastIntervalMs); const replacement = await reader.prepareReplacement(id);
  const before = await reader.repository.getRecoverySnapshot(id); const account = await reader.repository.getAccount();
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).rebroadcast,1);
    const after = await recovered.repository.getRecoverySnapshot(id);
    assert.ok(BigInt(after.version) > BigInt(before.version));
    assert.ok(after.broadcastEvents.filter(event => event.attemptId === replacement.attempts[0].attemptId).every(event => event.completedAt !== null));
    sameSignedAttempt(replacement.attempt,after.attempt); assert.equal(after.attempts.length,2);
    assert.deepEqual(await recovered.repository.getAccount(),account);
  } finally { await fresh.end(); }
});

for (const confirmed of [false,true]) {
  test(`a fresh client suppresses the replacement for an old ${confirmed ? "confirmed" : "unconfirmed"} canonical receipt`, async () => {
    const { id,parent,replacement,account } = await replacementWithPendingParent();
    await mine(id,parent.attempt.attemptId); destination.nodes.forEach(node => { node.head = confirmed ? 102n : 100n; });
    const fresh = createDatabasePool(config);
    try {
      const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
      const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
      assert.equal(result.results[0].action,confirmed ? "FINALIZED" : "RECEIPT_UNCONFIRMED");
      const stored = await recovered.repository.getTransaction(id);
      assert.equal(stored.intent.status,confirmed ? "CONFIRMED" : "PENDING");
      if (confirmed) { assert.equal(stored.intent.winningAttemptId,parent.attempt.attemptId); assert.equal(stored.winningAttempt.receiptBlockNumber,"100"); }
      assert.deepEqual(JSON.parse(deliveryJson(formatRelayerSummary(stored))),{
        deliveryJobId: id,transactionHash: confirmed ? parent.attempt.transactionHash : replacement.attempt.transactionHash,
        nonce: parent.attempt.nonce,intentStatus: confirmed ? "CONFIRMED" : "PENDING",
        latestAttempt: { transactionHash: replacement.attempt.transactionHash,status: confirmed ? "REPLACED" : "SIGNED",attemptNumber: 1 },
        status: confirmed ? "CONFIRMED" : "PENDING",
      },"summary must show the repository's historical winner while retaining the latest candidate diagnostic");
      sameSignedAttempt(replacement.attempt,stored.attempt); assert.equal(stored.attempt.broadcastAttemptCount,"0");
      assert.equal((await recovered.repository.getBroadcastEvents(id)).some(event => event.attemptId === replacement.attempt.attemptId),false);
      assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
      assert.deepEqual(await recovered.repository.getAccount(),account);
    } finally { await fresh.end(); }
  });
}

test("a parent mined during visibility reads is reconciled before nonce consumption can stop replacement recovery", async () => {
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  const fresh = createDatabasePool(config); const rpc = destination.restart().rpc;
  let advanced = false;
  try {
    const recoveringRpc = { ...rpc,async transaction(hash) {
      const transaction = await rpc.transaction(hash);
      if (!advanced && hash === parent.attempt.transactionHash) {
        advanced = true; await mine(id,parent.attempt.attemptId);
      }
      return transaction;
    } };
    const recovered = manager({ db: fresh,rpc: recoveringRpc });
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.results[0].action,"RECEIPT_UNCONFIRMED","receipt recheck must use the original confirmation head");
    const observed = await recovered.repository.getTransaction(id);
    assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.retryStoppedAt,null);
    sameSignedAttempt(replacement.attempt,observed.attempt);
    assert.equal((await recovered.repository.getBroadcastEvents(id)).some(event => event.attemptId === replacement.attempt.attemptId),false);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    assert.equal((await recovered.repository.getTransaction(id)).intent.winningAttemptId,parent.attempt.attemptId);
    assert.deepEqual(await recovered.repository.getAccount(),account);
  } finally { await fresh.end(); }
});

test("a fresh client's replacement response-loss recovery keeps its fixed head and defers finalization", async () => {
  const sourceBefore = await sourceState(pool,config.databaseSchema);
  const { id,parent,replacement,account } = await replacementWithPendingParent();
  const fresh = createDatabasePool(config); const rpc = destination.restart().rpc; const heads = [];
  destination.nodes[0].faults.set("eth_sendRawTransaction",async ({ forward }) => {
    await forward(); await mine(id,replacement.attempt.attemptId); throw rpcTimeout();
  });
  destination.nodes[1].alreadyKnown = true;
  const readView = rpc.readView; let viewReads = 0;
  rpc.readView = async () => { viewReads++; return readView(); };
  rpc.estimateGas = async () => assert.fail("response-loss recovery must not estimate gas");
  rpc.fees = async () => assert.fail("response-loss recovery must not resolve fees");
  try {
    const recovered = manager({ db: fresh,rpc,hooks: { afterReceiptObserved: ({ head }) => { heads.push(head); } },
      account: { address: config.relayerAddress,async signTransaction() { assert.fail("response-loss recovery must not re-sign"); } } });
    const result = await recovered.recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(result.rebroadcast,1); assert.equal(result.finalized,0);
    assert.equal(viewReads,1); assert.deepEqual(heads,[100n]);
    const observed = await recovered.repository.getTransaction(id);
    assert.equal(observed.intent.status,"PENDING"); assert.equal(observed.intent.winningAttemptId,null);
    assert.equal(observed.attempt.status,"BROADCAST"); assert.equal(observed.attempt.receiptBlockNumber,null);
    assert.equal(observed.attempts.length,2); sameSignedAttempt(replacement.attempt,observed.attempt);
    sameSignedAttempt(parent.attempt,observed.attempts[0]);
    assert.deepEqual(destination.nodes[0].broadcasts,[parent.attempt.rawSignedTransaction,replacement.attempt.rawSignedTransaction]);
    assert.deepEqual(destination.nodes[1].broadcasts,[replacement.attempt.rawSignedTransaction]);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.equal((await recovered.recoverTransactionsOnce({ deliveryJobId: id })).finalized,1);
    assert.equal(viewReads,2); assert.deepEqual(heads,[100n,102n]);
    const final = await recovered.repository.getTransaction(id);
    assert.equal(final.intent.status,"CONFIRMED"); assert.equal(final.intent.winningAttemptId,replacement.attempt.attemptId);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,3);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),sourceBefore);
    assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("independent clients serialize recovery of a pending-parent replacement without branching", async () => {
  const { id,replacement,account } = await replacementWithPendingParent(); const fresh = createDatabasePool(config);
  const reached = Promise.withResolvers(); const resume = Promise.withResolvers();
  const stopped = manager({ hooks: { afterBroadcastStart: async () => { reached.resolve(); await resume.promise; } } });
  const active = stopped.recoverTransactionsOnce({ deliveryJobId: id });
  try {
    await Promise.race([reached.promise,active.then(() => assert.fail("recovery did not reach its committed marker barrier"))]);
    const other = await manager({ db: fresh,rpc: destination.restart().rpc }).recoverTransactionsOnce({ deliveryJobId: id });
    assert.equal(other.results[0].reason,"TRANSACTION_RECOVERY_BUSY");
    resume.resolve(); assert.equal((await active).rebroadcast,1);
    const stored = await reader.repository.getTransaction(id); sameSignedAttempt(replacement.attempt,stored.attempt);
    assert.deepEqual(stored.attempts.map(attempt => attempt.attemptNumber),[0,1]);
    assert.deepEqual(await reader.repository.getAccount(),account); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,2);
  } finally { resume.resolve(); await active.catch(() => {}); await fresh.end(); }
});

test("journal markers survive restart, sequence is unique, history is immutable and migration preserves artifacts", async () => {
  const id = jobs[0].deliveryJobId; const before = await sourceState(pool,config.databaseSchema);
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } }); const signed = await stopped.prepareDeliveryTransaction(id);
  const account = await stopped.repository.getAccount(); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  const unresolved = await stopped.repository.getBroadcastEvents(id); assert.equal(unresolved.length,1); assert.equal(unresolved[0].completedAt,null);
  const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh }); assert.deepEqual(await recovered.repository.getBroadcastEvents(id),unresolved);
    assert.equal((await recovered.recoverTransactionsOnce()).rebroadcast,1);
    const stored = await recovered.repository.getTransaction(id);
    assert.equal(stored.attempt.rawSignedTransaction,signed.attempt.rawSignedTransaction); assert.equal(stored.attempt.transactionHash,signed.attempt.transactionHash);
    assert.deepEqual(await recovered.repository.getAccount(),account);
    const events = await recovered.repository.getBroadcastEvents(id);
    assert.deepEqual(events.map(e => e.broadcastSequence),["1","2","3"]); assert.equal(events[0].resultClass,"RECONCILED");
    await assert.rejects(pool.query(`UPDATE ${eventTable} SET endpoint_label = 'rpc-9' WHERE event_id = $1`,[events[2].eventId]),/immutable/);
    await assert.rejects(pool.query(`DELETE FROM ${eventTable} WHERE event_id = $1`,[events[0].eventId]),/history/);
    await applyMigrations(pool,config.databaseSchema); assert.deepEqual(await recovered.repository.getBroadcastEvents(id),events);
    assert.deepEqual(await sourceState(pool,config.databaseSchema),before); assert.deepEqual(await queue.listReadyDeliveryJobs(),jobs);
  } finally { await fresh.end(); }
});

test("accepted transaction with missing endpoint result is reconciled by a fresh client without rebroadcast", async () => {
  const id = jobs[0].deliveryJobId; const stopped = manager({ hooks: { afterEndpointResult: crashOnce() } });
  const first = await stopped.prepareDeliveryTransaction(id); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal((await stopped.repository.getTransaction(id)).attempt.status,"SIGNED");
  const snapshot = await stopped.repository.getRecoverySnapshot(id); destination.nodes.forEach(node => { node.available = false; });
  assert.equal((await reader.recoverTransactionsOnce()).results[0].reason,"RPC_UNAVAILABLE");
  assert.deepEqual(await reader.repository.getRecoverySnapshot(id),snapshot);
  destination.nodes[1].available = true; const fresh = createDatabasePool(config);
  try {
    const recovered = manager({ db: fresh,rpc: destination.restart().rpc });
    assert.equal((await recovered.recoverTransactionsOnce()).reconciled,1);
    const stored = await recovered.repository.getTransaction(id); assert.equal(stored.attempt.status,"BROADCAST");
    assert.equal(stored.attempt.rawSignedTransaction,first.attempt.rawSignedTransaction); assert.equal(stored.attempts.length,1);
    assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
  } finally { await fresh.end(); }
});

test("finalization interruption rolls back winner, receipt and intent atomically and a fresh process retries", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.submitDelivery(id); await mine(id,first.attempt.attemptId,0);
  const before = await reader.repository.getTransaction(id);
  const stopped = manager({ hooks: { beforeOutcomeCommit: crashOnce() } });
  await assert.rejects(stopped.recoverTransactionsOnce(),{ code: "TEST_CHECKPOINT" });
  assert.deepEqual(await reader.repository.getTransaction(id),before);
  assert.equal((await reader.recoverTransactionsOnce()).finalized,1);
  const final = await reader.repository.getTransaction(id); assert.equal(final.intent.status,"REVERTED"); assert.equal(final.intent.winningAttemptId,first.attempt.attemptId);
  assert.equal((await reader.recoverTransactionsOnce()).scanned,0); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
});

test("replacement ambiguity considers the old winner without branching or changing nonce", async () => {
  const id = jobs[0].deliveryJobId; const first = await reader.submitDelivery(id); h.advance(config.replacementAfterMs);
  const next = await reader.prepareReplacement(id); const account = await reader.repository.getAccount();
  const stopped = manager({ hooks: { afterBroadcastStart: crashOnce() } }); await assert.rejects(stopped.broadcastPreparedTransaction(id),{ code: "TEST_CHECKPOINT" });
  await mine(id,first.attempt.attemptId);
  assert.equal((await reader.recoverTransactionsOnce()).finalized,1);
  const final = await reader.repository.getTransaction(id); assert.equal(final.intent.winningAttemptId,first.attempt.attemptId);
  assert.equal(final.attempts.length,2); assert.equal(final.attempt.rawSignedTransaction,next.attempt.rawSignedTransaction);
  assert.deepEqual(await reader.repository.getAccount(),account);
});

test("concurrent recovery uses one send; post-read version changes reject stale writeback", async () => {
  const id = jobs[0].deliveryJobId; await reader.prepareDeliveryTransaction(id);
  const fresh = createDatabasePool(config);
  try {
    const other = manager({ db: fresh,rpc: destination.restart().rpc });
    const results = await Promise.all([reader.recoverTransactionsOnce(),other.recoverTransactionsOnce()]);
    assert.equal(results.reduce((sum,r) => sum + r.rebroadcast,0),1); assert.equal(destination.nodes.flatMap(node => node.broadcasts).length,1);
    const snapshot = await reader.repository.getRecoverySnapshot(id); await other.repository.scheduleRetry(id);
    await assert.rejects(reader.repository.applyRecoveryObservation(snapshot,{ knownAttempts: [snapshot.attempt.attemptId] }),{ code: "RECOVERY_STATE_CHANGED" });
  } finally { await fresh.end(); }
});

test("interruption after intent insert cannot commit a ghost nonce or partial attempt", async () => {
  const id = jobs[0].deliveryJobId;
  const stopped = manager({ hooks: { afterIntentInsert: crashOnce() } });
  await assert.rejects(stopped.prepareDeliveryTransaction(id),{ code: "TEST_CHECKPOINT" });
  assert.equal(await reader.repository.getTransaction(id),null); assert.equal(await reader.repository.getAccount(),null);
  assert.equal((await reader.prepareDeliveryTransaction(id)).attempt.nonce,"9");
});
