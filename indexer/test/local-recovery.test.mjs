import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createWorkerControl } from "../scripts/local/worker-control.mjs";
import { assertHigherFence,assertTransactionIdentity,metricTotal,RECOVERY_SCENARIOS } from "../scripts/local/recovery-demos.mjs";
import { assertVerificationStopped } from "../scripts/local/verification.mjs";
import { renderExplorerText } from "../scripts/local/privacy.mjs";
import { createRelayerCheckpoint as sharedCheckpoint } from "../scripts/lib/relayer-polling.mjs";
import { createRelayerCheckpoint as retainedCheckpoint } from "./helpers/relayer-polling.mjs";
import { destinationAccessPath as sharedPath } from "../scripts/lib/destination-access-path.mjs";
import { destinationAccessPath as retainedPath } from "./helpers/rpc-failover-integration.mjs";

const identity = { workerId: "relayer-a",schema: "owned_schema" };
const control = (isolated = true) => createWorkerControl({ isolated,identity });

test("normal workers are unarmed and cannot enable verification fault controls",async () => {
  const worker = control(false);
  let passes = 0;
  await worker.run(async () => { passes++; await worker.checkpoint("signed-persisted",{ id: "target" }); });
  assert.equal(passes,1); assert.equal(worker.handlers.status().blocked,undefined);
  for (const operation of ["pause","arm","resume","clear"]) await assert.rejects(worker.handlers[operation]({ id: "target" }),/verification ownership/);
  assert.equal(worker.handlers.status().paused,false);
});

test("pause acknowledges the running production pass before arming a target",async () => {
  const worker = control(); let finish; let acknowledged = false; let calls = 0;
  const pass = worker.run(() => new Promise(resolve => { calls++; finish = resolve; }));
  const pause = worker.handlers.pause().then(() => { acknowledged = true; });
  await worker.run(async () => { calls++; });
  assert.equal(calls,1); assert.equal(acknowledged,false);
  await assert.rejects(worker.handlers.arm({ id: "target" }));
  finish(); await pass; await pause;
  assert.equal(acknowledged,true); await worker.handlers.arm({ id: "target" });
  await worker.handlers.clear(); assert.equal(worker.handlers.status().paused,false);
});

test("SIGNED barrier blocks exactly its armed target once and exposes only selected evidence",async () => {
  const worker = control(); let sent = false;
  await assert.rejects(worker.handlers.arm({ id: "target" }));
  await worker.handlers.pause(); await worker.handlers.arm({ id: "target" }); await worker.handlers.resume();
  await worker.checkpoint("signed-persisted",{ id: "other" });
  await worker.checkpoint("before-signing",{ id: "target" });
  const fence = { deliveryJobId: "target",ownerId: "relayer-a",ownerSessionId: "session-a",fencingToken: "9" };
  const pass = worker.run(async () => {
    await worker.checkpoint("signed-persisted",{ id: "target",fence,created: true,transactionHash: "public-hash",nonce: "7" });
    sent = true;
  });
  const status = worker.handlers.status();
  assert.equal(sent,false); assert.equal(status.pid,process.pid); assert.equal(status.workerId,identity.workerId);
  assert.deepEqual(status.blocked,{ name: "signed-persisted",id: "target",fence,created: true,transactionHash: "public-hash",nonce: "7" });
  await worker.handlers.resume(); await pass;
  assert.equal(sent,true); assert.equal(worker.handlers.status().blocked,undefined);
  await worker.checkpoint("signed-persisted",{ id: "target" });
});

test("worker shutdown cancels a held pre-send barrier without allowing the send",async () => {
  const worker = control(); let sent = false;
  await worker.handlers.pause(); await worker.handlers.arm({ id: "target" }); await worker.handlers.resume();
  const pass = worker.run(async () => { await worker.checkpoint("signed-persisted",{ id: "target" }); sent = true; });
  const rejected = assert.rejects(pass,/control stopped/);
  worker.close(); await rejected;
  assert.equal(sent,false); assert.equal(worker.handlers.status().blocked,undefined);
});

test("only structured RPC unavailability is retained for ordinary polling recovery",() => {
  const worker = control();
  const unexpected = Object.assign(new Error("not transient"),{ code: "STALE_FENCE" });
  assert.throws(() => worker.recordError(unexpected),error => error === unexpected);
  for (let i = 0; i < 70; i++) worker.recordError({ code: "RPC_UNAVAILABLE",message: "do-not-retain-provider-message",
    observations: [{ endpointLabel: "rpc-1",outcome: "UNAVAILABLE",errorClass: "TRANSIENT_RPC_ERROR",raw: "do-not-retain-raw" }] });
  const status = worker.handlers.status(); assert.equal(status.errors.length,64);
  assert.deepEqual(status.errors[0],{ code: "RPC_UNAVAILABLE",observations: [{ endpointLabel: "rpc-1",outcome: "UNAVAILABLE",errorClass: "TRANSIENT_RPC_ERROR" }] });
  assert.doesNotMatch(JSON.stringify(status),/do-not-retain/);
  status.counts.signatures = 99; assert.equal(worker.handlers.status().counts.signatures,0);
});

test("takeover requires the same job, a different owner/session and strictly higher fencing",() => {
  const before = { deliveryJobId: "job",ownerId: "relayer-a",ownerSessionId: "a",fencingToken: "9" };
  const after = { ...before,ownerId: "relayer-b",ownerSessionId: "b",fencingToken: "10" };
  assert.doesNotThrow(() => assertHigherFence(before,after));
  for (const change of [{ deliveryJobId: "other" },{ ownerId: before.ownerId },{ ownerSessionId: before.ownerSessionId },
    { fencingToken: "9" },{ fencingToken: "8" }]) assert.throws(() => assertHigherFence(before,{ ...after,...change }));
});

function signedIdentity() {
  return { intents: [{ delivery_job_id: "job",package_digest: "digest",chain_id: "2001",sender_address: "sender",destination_gateway: "gateway",
    value: "0",calldata: "calldata",nonce: "7",created_at: "created",status: "PENDING" }],
  attempts: [{ attempt_id: "1",delivery_job_id: "job",attempt_number: 0,replacement_of_attempt_id: null,chain_id: "2001",sender_address: "sender",
    nonce: "7",gas_limit: "100000",max_fee_per_gas: "30",max_priority_fee_per_gas: "1",transaction_type: 2,
    raw_signed_transaction: "private-signed-sentinel",transaction_hash: "hash",created_at: "created",status: "SIGNED" }],
  accounts: [{ chain_id: "2001",sender_address: "sender",next_nonce: "8" }] };
}

test("recovery preserves intent, account nonce and exact signed artifact while allowing confirmation",() => {
  const original = signedIdentity(); const confirmed = structuredClone(original);
  confirmed.intents[0].status = "CONFIRMED"; confirmed.attempts[0].status = "CONFIRMED";
  assert.doesNotThrow(() => assertTransactionIdentity(confirmed,original));
  for (const collection of ["intents","attempts","accounts"]) {
    const doubled = structuredClone(original); doubled[collection].push({ ...doubled[collection][0] });
    assert.throws(() => assertTransactionIdentity(doubled,original));
    for (const field of Object.keys(original[collection][0]).filter(field => field !== "status")) {
      const changed = structuredClone(original); changed[collection][0][field] = "changed";
      assert.throws(() => assertTransactionIdentity(changed,original));
    }
  }
  const changed = structuredClone(original); changed.attempts[0].raw_signed_transaction = "other-private-sentinel";
  assert.throws(() => assertTransactionIdentity(changed,original),error => {
    assert.doesNotMatch(String(error),/private-signed-sentinel|other-private-sentinel/); return true;
  });
});

test("metric cross-observation sums only the exact existing family",() => {
  const text = '# HELP counter docs\ncounter{kind="a"} 2\ncounter{kind="b"} 3\ncounter_extra 100\nother 7\n';
  assert.equal(metricTotal(text,"counter"),5); assert.equal(metricTotal("counter 4\n","counter"),4);
  assert.equal(metricTotal(text,"absent"),0);
});

test("orphan Explorer rendering keeps REORGED distinct from successful confirmation",() => {
  const messageId = "0x" + "12".repeat(32);
  const text = renderExplorerText({ messageId,status: "REORGED",summary: [],timeline: [],sections: [] });
  assert.match(text,/REORGED/); assert.doesNotMatch(text,/CONFIRMED/);
});

test("cleanup success requires a stopped supervisor with no suppressed cleanup or runtime failure",() => {
  const stopped = { ready: false,stoppedAt: "2026-10-21T00:00:00Z",cleanupErrors: [] };
  assert.doesNotThrow(() => assertVerificationStopped(stopped));
  for (const change of [{ ready: true },{ stoppedAt: undefined },{ cleanupErrors: ["child remained"] },{ failure: "worker failed" }]) {
    assert.throws(() => assertVerificationStopped({ ...stopped,...change }));
  }
});

test("existing fault integrations reuse shared transport and checkpoint primitives",() => {
  assert.equal(retainedCheckpoint,sharedCheckpoint); assert.equal(retainedPath,sharedPath);
  assert.deepEqual(RECOVERY_SCENARIOS,["relayer-failover","source-reorg","replay-attack","recovery"]);
});

test("verification preserves handoff, cleanup and final expiry ordering without another user entry",async () => {
  const root = await readFile(new URL("../../scripts/verify.sh",import.meta.url),"utf8");
  const pbft = await readFile(new URL("../scripts/verify-pbft-faults.mjs",import.meta.url),"utf8");
  const recovery = await readFile(new URL("../scripts/verify-recovery-demos.mjs",import.meta.url),"utf8");
  const worker = await readFile(new URL("../scripts/local/worker.mjs",import.meta.url),"utf8");
  const startup = await readFile(new URL("../../scripts/start.sh",import.meta.url),"utf8");
  assert.ok(root.indexOf('node "$INDEXER_DIR/scripts/verify-pbft-faults.mjs"') < root.indexOf('node "$INDEXER_DIR/scripts/verify-recovery-demos.mjs"'));
  assert.ok(root.indexOf('node "$INDEXER_DIR/scripts/verify-recovery-demos.mjs"') < root.lastIndexOf('zk-security-invariants.mjs" expiry'));
  assert.match(pbft,/if \(record && process\.exitCode\)/);
  assert.ok(recovery.indexOf("await stopVerificationStack(record)") < recovery.indexOf("RELAYER / REORG / REPLAY / RECOVERY DEMONSTRATIONS PASSED"));
  assert.match(worker,/manager\.continueDeliveryTransactionOnce\(id,\{ fence \}\)/);
  assert.doesNotMatch(worker,/broadcastPreparedTransaction\(id,\{ fence/);
  assert.doesNotMatch(startup,/relayer-failover|source-reorg|replay-attack|demo\.sh/);
});
