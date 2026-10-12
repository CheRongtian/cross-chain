import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tableName } from "../../src/db.mjs";

const ENTRY = fileURLToPath(new URL("./relayer-process.mjs",import.meta.url));
export function createRelayerProcesses({ environment,pidFile }) {
  assert.ok(pidFile,"verification must supply its owned Relayer PID registry");
  const children = []; let registry = Promise.resolve(); let closing;
  const save = () => {
    registry = registry.then(() => writeFile(pidFile,`${children.filter(r => !r.exited && r.child.pid).map(r => r.child.pid).join("\n")}\n`));
    return registry;
  };
  async function stop(record,signal = "SIGTERM") {
    if (!record || record.exited) return save();
    record.child.kill(signal);
    const timer = setTimeout(() => { if (!record.exited) record.child.kill("SIGKILL"); },5000);
    try { await record.closed; } finally { clearTimeout(timer); await save(); }
  }
  function start(workerId,request) {
    const child = spawn(process.execPath,[ENTRY],{ env: { ...environment,RELAYER_WORKER_ID: workerId },stdio: ["ignore","pipe","pipe","ipc"] });
    const record = { child,exited: false,stdout: "",stderr: "",messages: [],listeners: new Set() };
    record.closed = new Promise(resolve => {
      child.once("error",error => { record.exited = true; resolve({ code: null,error }); });
      child.once("close",(code,signal) => { record.exited = true; resolve({ code,signal }); });
    });
    child.on("message",message => { record.messages.push(message); for (const listener of record.listeners) listener(); });
    child.stdout.on("data",chunk => { record.stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data",chunk => { record.stderr += chunk.toString(); process.stderr.write(chunk); });
    record.wait = async type => {
      let timer; let listener;
      const next = new Promise(resolve => {
        listener = () => { const message = record.messages.find(message => message.type === type); if (message) resolve(message); };
        record.listeners.add(listener); listener();
      });
      try {
        return await Promise.race([next,record.closed.then(result => { throw result.error ?? new Error(`Relayer ${workerId} exited before ${type} (${result.code}): ${record.stderr}`); }),
          new Promise((_,reject) => { timer = setTimeout(() => reject(new Error(`Relayer ${workerId} timed out waiting for ${type}`)),30000); })]);
      } finally { clearTimeout(timer); record.listeners.delete(listener); }
    };
    record.send = message => new Promise((resolve,reject) => child.send(message,error => error ? reject(error) : resolve()));
    record.finish = async ({ expectedError } = {}) => {
      let timer;
      try {
        const result = await Promise.race([record.closed,new Promise((_,reject) => { timer = setTimeout(() => reject(new Error(`Relayer ${workerId} did not exit`)),30000); })]);
        if (result.error) throw result.error;
        assert.equal(result.code,expectedError ? 1 : 0,record.stderr);
        if (expectedError) {
          assert.ok(record.stderr.includes(expectedError));
          console.log(`EXPECTED FAILURE VERIFIED: ${expectedError}`);
        }
        for (const secret of [environment.RELAYER_A_PRIVATE_KEY,environment.DATABASE_URL]) if (secret) {
          assert.ok(!record.stdout.includes(secret) && !record.stderr.includes(secret),"worker output must redact secrets");
        }
        return record.messages.find(message => message.type === "result");
      } finally { clearTimeout(timer); await save(); }
    };
    children.push(record); void save().catch(error => { console.error(`Relayer PID registry failed: ${error.message}`); });
    // Module imports may still be loading when spawn returns. Wait for the
    // child's installed IPC handler before sending its first request.
    record.started = record.wait("ready").then(() => record.send(request));
    return record;
  }
  const onSignal = () => { void Promise.all(children.map(record => stop(record))).catch(error => console.error(error.message)); };
  process.once("SIGINT",onSignal); process.once("SIGTERM",onSignal);
  function close() {
    if (!closing) closing = (async () => {
      try { await Promise.all(children.map(record => stop(record))); await registry; }
      finally { process.removeListener("SIGINT",onSignal); process.removeListener("SIGTERM",onSignal); }
    })();
    return closing;
  }
  return { start,stop,close };
}

async function expire(pool,config,id) {
  await pool.query(`UPDATE ${tableName(config.databaseSchema,"relayer_job_leases")}
    SET lease_expires_at = clock_timestamp() - interval '1 millisecond' WHERE delivery_job_id = $1`,[id]);
}
async function emptyIntent(pool,config,id) {
  assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(config.databaseSchema,"transaction_intents")} WHERE delivery_job_id = $1`,[id])).rows[0].count,0);
}

export async function verifyLeaseTakeover({ processes,pool,config,id }) {
  const a = processes.start("relayer-a",{ id,mode: "job",pause: "lease" }); await a.started;
  const owned = await a.wait("lease"); assert.equal(owned.fence.ownerId,"relayer-a");
  await emptyIntent(pool,config,id);
  const b = processes.start("relayer-b",{ id,mode: "job" }); await b.started;
  const busy = await b.wait("result"); await b.finish();
  assert.equal(busy.result.action,"BUSY"); assert.notEqual(a.child.pid,b.child.pid);
  await emptyIntent(pool,config,id);
  console.log("EXPECTED FAILURE: a second live process with worker ID relayer-a must be rejected");
  const duplicate = processes.start("relayer-a",{ id,mode: "job" }); await duplicate.started;
  await duplicate.finish({ expectedError: "RELAYER_WORKER_ALREADY_RUNNING" });
  await processes.stop(a,"SIGKILL");
  // An unavailable process does not immediately relinquish its durable lease.
  const early = processes.start("relayer-b",{ id,mode: "job" }); await early.started;
  assert.equal((await early.wait("result")).result.action,"BUSY"); await early.finish();
  await expire(pool,config,id);
  const takeover = processes.start("relayer-b",{ id,mode: "lease-only",pause: "lease" }); await takeover.started;
  const current = await takeover.wait("lease"); assert.ok(BigInt(current.fence.fencingToken) > BigInt(owned.fence.fencingToken));
  const stale = processes.start("relayer-a",{ id,mode: "stale",fence: owned.fence }); await stale.started;
  assert.equal((await stale.wait("result")).action,"STALE_FENCE"); await stale.finish();
  await emptyIntent(pool,config,id);
  const restored = processes.start("relayer-a",{ id,mode: "job" }); await restored.started;
  assert.equal((await restored.wait("result")).result.action,"BUSY"); await restored.finish();
  await takeover.send({ type: "continue" }); await takeover.wait("result"); await takeover.finish();
  const competitors = ["relayer-a","relayer-b"].map(workerId => processes.start(workerId,{ id,mode: "race",pause: "lease" }));
  await Promise.all(competitors.map(record => record.started));
  await Promise.all(competitors.map(record => record.wait("claim-ready")));
  await Promise.all(competitors.map(record => record.send({ type: "continue" })));
  const race = await Promise.all(competitors.map(record => record.wait("ownership")));
  assert.equal(race.filter(result => result.fence).length,1,"concurrent OS processes must have exactly one claim winner");
  const winningProcess = competitors[race.findIndex(result => result.fence)];
  await winningProcess.send({ type: "continue" });
  await Promise.all(competitors.map(record => record.wait("result"))); await Promise.all(competitors.map(record => record.finish()));
  await emptyIntent(pool,config,id);
  console.log("VALID: two independent Relayer processes contended for one job; A disappearance required expiry, B obtained a higher token, duplicate/stale/restored A could not steal B's ownership");
  return current.fence;
}

export async function verifySignedTakeover({ processes,pool,config,manager,id }) {
  const a = processes.start("relayer-a",{ id,mode: "job",pause: "signed" }); await a.started;
  const prepared = await a.wait("signed"); const signed = await manager.repository.getTransaction(id);
  assert.equal(signed.attempt.status,"SIGNED"); assert.equal(signed.attempt.broadcastAttemptCount,"0");
  assert.deepEqual(prepared.stored.attempt,signed.attempt);
  const account = await manager.repository.getAccount();
  const b = processes.start("relayer-b",{ id,mode: "job" }); await b.started;
  assert.equal((await b.wait("result")).result.action,"BUSY"); await b.finish();
  await processes.stop(a,"SIGKILL"); await expire(pool,config,id);
  const resumed = processes.start("relayer-b",{ id,mode: "job" }); await resumed.started;
  const result = (await resumed.wait("result")).result; await resumed.finish();
  assert.equal(result.attempt.status,"BROADCAST"); assert.equal(result.attempts.length,1);
  for (const field of ["nonce","rawSignedTransaction","transactionHash","gasLimit","maxFeePerGas","maxPriorityFeePerGas"]) assert.equal(result.attempt[field],signed.attempt[field]);
  assert.deepEqual(result.intent.packageDigest,signed.intent.packageDigest); assert.equal(result.intent.intentId,signed.intent.intentId);
  assert.equal(result.intent.senderAddress,signed.intent.senderAddress);
  assert.deepEqual(await manager.repository.getAccount(),account);
  assert.ok(BigInt(result.fencingToken) > BigInt(prepared.fence.fencingToken));
  assert.notEqual(a.child.pid,resumed.child.pid);
  console.log("VALID: A stopped after committed SIGNED and before broadcast; a real B process continued identical intent/nonce/raw bytes/hash without another reservation or signature");
  return result;
}

export async function verifyConcurrentRelayers({ processes,pool,config,manager,jobs }) {
  const active = jobs.slice(0,2).map((job,index) => processes.start(index ? "relayer-b" : "relayer-a",{ id: job.deliveryJobId,mode: "job",pause: "lease" }));
  await Promise.all(active.map(record => record.started));
  const owned = await Promise.all(active.map(record => record.wait("lease")));
  assert.equal(new Set(owned.map(record => record.pid)).size,active.length);
  assert.equal(new Set(owned.map(record => record.fence.deliveryJobId)).size,active.length);
  assert.equal(new Set(owned.map(record => record.workerId)).size,active.length);
  const rows = (await pool.query(`SELECT delivery_job_id,owner_id,fencing_token FROM ${tableName(config.databaseSchema,"relayer_job_leases")}
    WHERE delivery_job_id = ANY($1::text[]) AND lease_expires_at > clock_timestamp()`,[owned.map(record => record.fence.deliveryJobId)])).rows;
  assert.equal(rows.length,active.length);
  // Both OS processes hold different leases concurrently. Complete their
  // transaction requests in reservation order to retain the observer's exact
  // per-intent gas/fee counts; database tests also race preparation mutations.
  for (const record of active) {
    await record.send({ type: "continue" }); await record.wait("result"); await record.finish();
  }
  // The shared nonce guard may defer one worker while the other still has an
  // unbroadcast reservation. A subsequent bounded pass uses the same state.
  for (const [index,job] of jobs.entries()) {
    let stored = await manager.repository.getTransaction(job.deliveryJobId);
    if (!stored || stored.attempt.status === "SIGNED") {
      const worker = processes.start(index % 2 ? "relayer-b" : "relayer-a",{ id: job.deliveryJobId,mode: "job" }); await worker.started;
      await worker.wait("result"); await worker.finish(); stored = await manager.repository.getTransaction(job.deliveryJobId);
    }
    assert.equal(stored.attempt.status,"BROADCAST"); assert.equal(stored.attempts.length,1);
    assert.equal((await pool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(config.databaseSchema,"transaction_intents")} WHERE delivery_job_id = $1`,[job.deliveryJobId])).rows[0].count,1);
  }
  console.log(active.length === 2 ?
    "VALID: independent A/B processes owned distinct READY jobs concurrently; shared nonce serialization preserved one logical intent per job without changing delivery evidence" :
    "VALID: the remaining READY job retained one intent; multi-job distribution is exercised by the rotation fixture's additional jobs");
}
