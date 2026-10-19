import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { tableName } from "../../src/db.mjs";
import { createRelayerLeaseRepository } from "../../src/relayer/leases.mjs";
import { encodeGatewaySubmission } from "../../src/relayer/encoding.mjs";
import { verifyRpcTransaction } from "../../src/transaction-manager/receipts.mjs";
import { verifySignedTransaction } from "../../src/transaction-manager/transaction.mjs";
import { withAutomineDisabled } from "./transaction-retry-integration.mjs";

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
  function start(workerId,request,{ privateKey = environment.RELAYER_A_PRIVATE_KEY } = {}) {
    const workerEnvironment = { ...environment,RELAYER_WORKER_ID: workerId,RELAYER_A_PRIVATE_KEY: privateKey };
    const child = spawn(process.execPath,[ENTRY],{ env: workerEnvironment,stdio: ["ignore","pipe","pipe","ipc"] });
    const record = { child,exited: false,stdout: "",stderr: "",messages: [],listeners: new Set() };
    record.closed = new Promise(resolve => {
      child.once("error",error => { record.exited = true; resolve({ code: null,error }); });
      child.once("close",(code,signal) => { record.exited = true; resolve({ code,signal }); });
    });
    child.on("message",message => { record.messages.push(message); for (const listener of record.listeners) listener(); });
    child.stdout.on("data",chunk => { record.stdout += chunk.toString(); process.stdout.write(chunk); });
    child.stderr.on("data",chunk => { record.stderr += chunk.toString(); process.stderr.write(chunk); });
    record.wait = async (type,predicate = () => true) => {
      let timer; let listener;
      const next = new Promise(resolve => {
        listener = () => { const message = record.messages.find(message => message.type === type && predicate(message)); if (message) resolve(message); };
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
        for (const secret of [privateKey,environment.RELAYER_A_PRIVATE_KEY,environment.DATABASE_URL]) if (secret) {
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

// Full-system signed takeover uses natural expiry; the older component cases
// above deliberately retain their separate forced-expiry coverage.
export async function verifySignedTakeoverAfterExpiry({ processes,pool,config,manager,queue,client,observer,id }) {
  const leases = createRelayerLeaseRepository({ config,pool,queue });
  const leasesTable = tableName(config.databaseSchema,"relayer_job_leases");
  const journals = tableName(config.databaseSchema,"transaction_broadcast_events");
  const attempts = tableName(config.databaseSchema,"transaction_attempts");
  const job = await queue.getDeliveryJob(id);
  const accountBefore = await manager.repository.getAccount();
  assert.ok(accountBefore,"the existing system manager must already own durable nonce state");
  assert.equal(await manager.repository.getTransaction(id),null);
  assert.equal(await leases.getLease(id),null);
  const calls = method => observer.calls.filter(call => call.method === method).length;
  const preparationCalls = () => ["eth_estimateGas","eth_maxPriorityFeePerGas","eth_gasPrice","eth_feeHistory"].map(calls);
  async function journal() {
    return (await pool.query(`SELECT e.* FROM ${journals} e JOIN ${attempts} a USING (attempt_id)
      WHERE a.delivery_job_id = $1 ORDER BY e.event_id`,[id])).rows;
  }
  async function leaseState() {
    const row = (await pool.query(`SELECT owner_id,owner_session_id,fencing_token,released_at,
      lease_expires_at > clock_timestamp() AS active,clock_timestamp() AS observed_at,
      lease_expires_at FROM ${leasesTable} WHERE delivery_job_id = $1`,[id])).rows[0];
    assert.ok(row,"the durable lease row must survive process loss");
    return row;
  }
  const a = processes.start("relayer-a",{ id,mode: "job",checkpoint: "signed-persisted" });
  await a.started;
  const prepared = await a.wait("checkpoint",message => message.name === "signed-persisted");
  assert.equal(prepared.pid,a.child.pid); assert.equal(prepared.workerId,"relayer-a");
  assert.equal(a.exited,false); assert.equal(prepared.fence.deliveryJobId,id);
  assert.equal(prepared.fence.ownerId,"relayer-a"); assert.equal(prepared.stored.created,true);
  const signed = await manager.repository.getTransaction(id);
  assert.ok(isDeepStrictEqual(prepared.stored.intent,signed.intent),"A's IPC intent must match committed PostgreSQL state");
  assert.ok(isDeepStrictEqual(prepared.stored.attempts,signed.attempts),"A's signed attempt must be durably committed");
  assert.equal(signed.intent.status,"PENDING"); assert.equal(signed.intent.intentId,id);
  assert.equal(signed.intent.senderAddress,config.relayerAddress);
  assert.equal(signed.attempts.length,1); assert.equal(signed.attempt.attemptNumber,0);
  assert.equal(signed.attempt.replacementOfAttemptId,null); assert.equal(signed.attempt.transactionType,2);
  assert.equal(signed.attempt.status,"SIGNED"); assert.equal(signed.attempt.broadcastAttemptCount,"0");
  assert.equal(signed.attempt.broadcastAt,null); assert.equal(signed.attempt.receiptBlockHash,null);
  assert.equal(calls("eth_sendRawTransaction"),0); assert.equal((await journal()).length,0);
  assert.deepEqual(preparationCalls(),[1,1,0,0],"only A must estimate gas and fetch fees once");
  const accountSigned = await manager.repository.getAccount();
  assert.equal(accountSigned.nextNonce,(BigInt(signed.intent.nonce) + 1n).toString());
  assert.equal(accountSigned.highestReservedNonce,signed.intent.nonce);
  assert.ok(BigInt(accountSigned.nextNonce) > BigInt(accountBefore.nextNonce));
  async function assertOwnedByA(active) {
    const row = await leaseState();
    assert.equal(row.owner_id,prepared.fence.ownerId); assert.equal(row.owner_session_id,prepared.fence.ownerSessionId);
    assert.equal(row.fencing_token,prepared.fence.fencingToken); assert.equal(row.released_at,null);
    if (active !== undefined) assert.equal(row.active,active);
    return row;
  }
  async function assertUnsent() {
    assert.deepEqual(await queue.getDeliveryJob(id),job);
    assert.ok(isDeepStrictEqual(await manager.repository.getTransaction(id),signed),"job intent, nonce and signed bytes must remain unchanged before send");
    assert.deepEqual(await manager.repository.getAccount(),accountSigned);
    assert.equal(calls("eth_sendRawTransaction"),0); assert.equal((await journal()).length,0);
    assert.equal(await client.request({ method: "eth_getTransactionByHash",params: [signed.attempt.transactionHash] }),null);
    assert.equal(await client.request({ method: "eth_getTransactionReceipt",params: [signed.attempt.transactionHash] }),null);
    assert.equal(observer.errors.length,0,"healthy RPC observation must not inject a transport failure");
  }
  await assertOwnedByA(true); await assertUnsent();
  console.log(`VALID: Relayer A acquired ${id} with fencing token ${prepared.fence.fencingToken}; worker relayer-a, PID ${a.child.pid}`);
  console.log(`VALID: Relayer A durably persisted one canonical intent, nonce ${signed.intent.nonce} and exact SIGNED transaction ${signed.attempt.transactionHash} before external send`);
  const b = processes.start("relayer-b",{ id,mode: "takeover",pause: "signed" });
  await b.started;
  const bPid = b.child.pid;
  assert.notEqual(a.child.pid,bPid);
  async function assertBusy(attempt) {
    const message = await b.wait("busy",message => message.attempt === attempt);
    assert.equal(message.result.action,"BUSY"); assert.equal(message.result.submitted,false);
    assert.equal(message.result.deliveryJobId,id); assert.equal(message.pid,bPid);
    assert.equal(message.workerId,"relayer-b"); assert.equal(b.exited,false);
    assert.equal(b.messages.some(message => message.type === "lease"),false);
    await assertOwnedByA(true); await assertUnsent();
  }
  await assertBusy(1);
  await processes.stop(a,"SIGKILL");
  assert.equal((await a.closed).signal,"SIGKILL"); assert.equal(a.exited,true);
  assert.equal(a.messages.some(message => message.type === "result"),false);
  await assertOwnedByA(true); await assertUnsent();
  console.log("VALID: Relayer A OS process stopped at the deterministic post-SIGNED pre-send boundary; no graceful lease release");
  await b.send({ type: "continue" }); await assertBusy(2);
  console.log("VALID: READY job, intent, nonce and signed attempt survived Relayer A process loss unchanged; the same B PID remained BUSY before expiry");
  console.log(`Waiting for the persisted lease to expire naturally; configured duration ${config.leaseMs} ms; PostgreSQL clock controls takeover eligibility`);
  // Database time is the only authority for expiry. This timeout is a watchdog,
  // and the short pause merely spaces read-only polls; no lease row is edited.
  const deadline = Date.now() + config.leaseMs + 30000;
  let expired;
  for (;;) {
    assert.equal(a.exited,true); assert.equal(b.exited,false); assert.equal(b.child.pid,bPid);
    expired = await assertOwnedByA();
    if (!expired.active) break;
    assert.ok(Date.now() < deadline,"the dead owner's database-time lease did not expire within its configured duration plus watchdog");
    await pause(25);
  }
  assert.ok(expired.observed_at >= expired.lease_expires_at);
  console.log(`VALID: PostgreSQL observed ${expired.observed_at.toISOString()} at or after durable A lease expiry ${expired.lease_expires_at.toISOString()}; no forced expiry`);
  await assertUnsent();
  await b.send({ type: "continue" });
  const acquired = await b.wait("lease");
  const reused = await b.wait("signed");
  assert.equal(acquired.pid,bPid); assert.equal(reused.pid,bPid); assert.equal(b.exited,false);
  assert.equal(acquired.workerId,"relayer-b"); assert.equal(reused.workerId,"relayer-b");
  assert.equal(acquired.fence.deliveryJobId,id); assert.equal(acquired.fence.ownerId,"relayer-b");
  assert.notEqual(acquired.fence.ownerSessionId,prepared.fence.ownerSessionId);
  assert.ok(BigInt(acquired.fence.fencingToken) > BigInt(prepared.fence.fencingToken));
  assert.deepEqual(reused.fence,acquired.fence); assert.equal(reused.stored.created,false);
  assert.ok(isDeepStrictEqual(reused.stored.intent,signed.intent),"B must reuse A's canonical intent, sender, target, calldata and nonce");
  assert.ok(isDeepStrictEqual(reused.stored.attempts,signed.attempts),"B must reuse the exact existing signed bytes, hash, gas and fees without a signature or replacement");
  const current = await leaseState();
  assert.equal(current.owner_id,"relayer-b"); assert.equal(current.owner_session_id,acquired.fence.ownerSessionId);
  assert.equal(current.fencing_token,acquired.fence.fencingToken); assert.equal(current.released_at,null); assert.equal(current.active,true);
  await assertUnsent(); assert.deepEqual(preparationCalls(),[1,1,0,0]);
  console.log(`VALID: Relayer B acquired the same READY job after database-time lease expiry with a strictly higher fencing token ${acquired.fence.fencingToken}; unchanged PID ${bPid}`);
  console.log("VALID: Relayer B reused the same intent, sender, nonce, target, calldata, signed bytes and transaction hash; zero re-estimation, repricing, signature or replacement");
  // A stays dead. Exercise a representative production mutation with its old
  // captured fence, while the actual B worker holds the new durable lease.
  await assert.rejects(() => leases.renewLease(prepared.fence),error => error.code === "STALE_FENCE");
  assert.equal((await leaseState()).fencing_token,acquired.fence.fencingToken);
  await assertUnsent();
  console.log("EXPECTED FAILURE: Relayer A's stale fencing token could not mutate the delivery after Relayer B takeover");
  await b.send({ type: "continue" });
  const completed = await b.wait("result"); await b.finish();
  assert.equal(completed.pid,bPid); assert.equal(completed.workerId,"relayer-b");
  assert.equal(completed.result.workerId,"relayer-b"); assert.equal(completed.result.fencingToken,acquired.fence.fencingToken);
  assert.equal(completed.result.submitted,true); assert.equal(completed.result.attempt.status,"BROADCAST");
  assert.equal(completed.result.attempts.length,1);
  for (const field of ["attemptId","nonce","gasLimit","maxFeePerGas","maxPriorityFeePerGas","transactionHash","rawSignedTransaction"]) {
    assert.ok(completed.result.attempt[field] === signed.attempt[field],`B must preserve signed ${field}`);
  }
  assert.equal(calls("eth_sendRawTransaction"),1);
  assert.ok(observer.calls.find(call => call.method === "eth_sendRawTransaction").params[0] === signed.attempt.rawSignedTransaction,
    "B must broadcast only A's persisted raw transaction");
  assert.equal(observer.errors.length,0); assert.deepEqual(preparationCalls(),[1,1,0,0]);
  assert.deepEqual(await manager.repository.getAccount(),accountSigned);
  assert.equal(a.exited,true); assert.equal((await a.closed).signal,"SIGKILL");
  const released = await leases.getLease(id);
  assert.equal(released.ownerId,"relayer-b"); assert.equal(released.fencingToken,acquired.fence.fencingToken);
  assert.notEqual(released.releasedAt,null);
  return { signed,accountSigned,a,b,fenceA: prepared.fence,fenceB: acquired.fence };
}

export async function verifyDuplicateTransportRace({ processes,pool,config,manager,queue,client,observer,id,duplicatePrivateKey }) {
  const pack = await queue.getDeliveryPackage(id);
  const encoded = await encodeGatewaySubmission(pack,{ validatorSets: config.validatorSets,
    sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway });
  const job = await queue.getDeliveryJob(id);
  assert.equal(job.status,"READY"); assert.equal(await manager.repository.getTransaction(id),null);
  const leases = createRelayerLeaseRepository({ config,pool,queue });
  assert.equal(await leases.getLease(id),null);
  let failure;
  return withAutomineDisabled(client,async () => {
    try {
      const a = processes.start("relayer-a",{ id,mode: "duplicate-canonical",pause: "signed" });
      const b = processes.start("relayer-b",{ id,mode: "duplicate-transport" },{ privateKey: duplicatePrivateKey });
      await Promise.all([a.started,b.started]);
      const [prepared,contender] = await Promise.all([a.wait("signed"),b.wait("transport-ready")]);
      assert.notEqual(a.child.pid,b.child.pid);
      assert.equal(prepared.pid,a.child.pid); assert.equal(contender.pid,b.child.pid);
      assert.equal(prepared.workerId,"relayer-a"); assert.equal(contender.workerId,"relayer-b");
      const canonical = await manager.repository.getTransaction(id);
      assert.equal(prepared.stored.created,true);
      assert.ok(isDeepStrictEqual(prepared.stored.intent,canonical.intent),"canonical A intent must be committed before release");
      assert.ok(isDeepStrictEqual(prepared.stored.attempts,canonical.attempts),"canonical A signed identity must be committed before release");
      assert.equal(canonical.attempt.status,"SIGNED"); assert.equal(canonical.attempt.broadcastAttemptCount,"0");
      assert.equal(canonical.attempts.length,1); assert.equal(canonical.attempt.attemptNumber,0);
      assert.deepEqual(contender.package,pack);
      const identities = [
        { workerId: "relayer-a",pid: a.child.pid,intent: canonical.intent,attempt: canonical.attempt },
        { workerId: "relayer-b",pid: b.child.pid,intent: contender.intent,attempt: contender.attempt },
      ];
      assert.notEqual(identities[0].intent.senderAddress,identities[1].intent.senderAddress);
      assert.notEqual(identities[0].attempt.transactionHash,identities[1].attempt.transactionHash);
      for (const identity of identities) {
        assert.equal(identity.intent.deliveryJobId,id); assert.equal(identity.intent.chainId,config.destinationDomain.toString());
        assert.equal(identity.intent.destinationGateway,pack.message.destinationGateway); assert.equal(identity.intent.value,"0");
        assert.equal(identity.intent.packageDigest,encoded.packageDigest); assert.equal(identity.intent.calldata,encoded.calldata);
        await verifySignedTransaction(identity.intent,identity.attempt);
        assert.equal(await client.request({ method: "eth_getTransactionByHash",params: [identity.attempt.transactionHash] }),null);
        assert.equal(await client.request({ method: "eth_getTransactionReceipt",params: [identity.attempt.transactionHash] }),null);
        const balance = await client.request({ method: "eth_getBalance",params: [identity.intent.senderAddress,"latest"] });
        assert.ok(BigInt(balance) >= BigInt(identity.attempt.gasLimit) * BigInt(identity.attempt.maxFeePerGas),
          "each independent sender must have enough gas funds before the duplicate race");
      }
      const block = await client.request({ method: "eth_getBlockByNumber",params: ["latest",false] });
      assert.ok(identities.reduce((total,identity) => total + BigInt(identity.attempt.gasLimit),0n) <= BigInt(block.gasLimit),
        "both contender gas limits must fit the existing local Chain B block budget");
      async function assertAlive() { assert.equal(a.exited,false); assert.equal(b.exited,false); }
      await assertAlive();
      const lease = await leases.getLease(id);
      assert.equal(lease.ownerId,"relayer-a"); assert.equal(lease.fencingToken,prepared.fence.fencingToken);
      assert.equal(lease.releasedAt,null);
      assert.equal((await pool.query(`SELECT COUNT(*)::text AS count FROM ${tableName(config.databaseSchema,"transaction_intents")}
        WHERE delivery_job_id = $1`,[id])).rows[0].count,"1");
      assert.equal(observer.calls.filter(call => call.method === "eth_sendRawTransaction").length,0);
      assert.equal(observer.errors.length,0);
      console.log(`VALID: Relayer A and Relayer B loaded the same canonical message ${pack.message.messageId}, batch/root/QC and byte-identical Gateway calldata; package digest ${encoded.packageDigest}`);
      console.log(`VALID: duplicate-delivery contenders are independent Relayer A/B OS processes with distinct PIDs ${a.child.pid}/${b.child.pid}; senders ${identities.map(identity => identity.intent.senderAddress).join(" / ")}`);
      console.log("VALID: canonical operational Relayer A owns the sole lease/intent; Relayer B is an intentional test-only duplicate transport contender with no canonical intent or nonce reservation");
      console.log("VALID: both relayers reached the deterministic pre-broadcast barrier before either destination result was observed");
      // Both IPC sends are issued without awaiting either child's broadcast.
      // Automine stays off until BOTH actors report actual external acceptance.
      await Promise.all([a.send({ type: "continue" }),b.send({ type: "continue" })]);
      const broadcasts = await Promise.all([a.wait("transport-broadcast"),b.wait("transport-broadcast")]);
      await assertAlive();
      assert.equal(broadcasts[0].pid,a.child.pid); assert.equal(broadcasts[1].pid,b.child.pid);
      for (const [index,broadcast] of broadcasts.entries()) {
        assert.equal(broadcast.workerId,identities[index].workerId);
        assert.equal(broadcast.transactionHash,identities[index].attempt.transactionHash);
      }
      assert.equal(broadcasts[0].result.submitted,true); assert.equal(broadcasts[0].result.attempt.status,"BROADCAST");
      assert.equal(broadcasts[0].result.workerId,"relayer-a");
      assert.equal(broadcasts[0].result.fencingToken,prepared.fence.fencingToken);
      const sends = observer.calls.filter(call => call.method === "eth_sendRawTransaction");
      assert.equal(sends.length,2);
      for (const identity of identities) {
        assert.equal(sends.filter(call => call.params[0] === identity.attempt.rawSignedTransaction).length,1,
          "each contender must externally send its exact signed bytes once");
        const pending = await client.request({ method: "eth_getTransactionByHash",params: [identity.attempt.transactionHash] });
        verifyRpcTransaction(identity.intent,identity.attempt,pending);
        assert.equal(pending.blockNumber,null);
        assert.equal(await client.request({ method: "eth_getTransactionReceipt",params: [identity.attempt.transactionHash] }),null);
      }
      assert.equal(observer.errors.length,0);
      console.log("VALID: both relayers independently broadcast a destination transaction for the same message; both remain alive with accepted pending transactions before any receipt is used");
      console.log(`VALID: duplicate contenders produced two distinct Chain B transaction hashes ${identities.map(identity => identity.attempt.transactionHash).join(" / ")} with identical DestinationGateway calldata`);
      await Promise.all([a.send({ type: "continue" }),b.send({ type: "continue" })]);
      await Promise.all([a.wait("result"),b.wait("result")]);
      await Promise.all([a.finish(),b.finish()]);
      await client.request({ method: "anvil_mine",params: ["0x1"] });
      const receipts = [];
      for (const identity of identities) {
        const receipt = await client.request({ method: "eth_getTransactionReceipt",params: [identity.attempt.transactionHash] });
        assert.ok(receipt,"both accepted duplicate transactions must be mined by the controlled block");
        assert.equal(receipt.transactionHash,identity.attempt.transactionHash);
        const transaction = await client.request({ method: "eth_getTransactionByHash",params: [identity.attempt.transactionHash] });
        verifyRpcTransaction(identity.intent,identity.attempt,transaction,receipt);
        const block = await client.request({ method: "eth_getBlockByNumber",params: [receipt.blockNumber,false] });
        assert.equal(block.hash,receipt.blockHash); assert.equal(BigInt(block.number),BigInt(receipt.blockNumber));
        assert.ok(BigInt(block.timestamp) < BigInt(pack.message.deadline));
        receipts.push({ ...identity,receipt,transaction });
      }
      assert.equal(receipts[0].receipt.blockHash,receipts[1].receipt.blockHash,"both pending contenders must fit the same controlled block");
      assert.equal(receipts.filter(value => BigInt(value.receipt.status) === 1n).length,1);
      assert.equal(receipts.filter(value => BigInt(value.receipt.status) === 0n).length,1);
      const winner = receipts.find(value => BigInt(value.receipt.status) === 1n);
      const loser = receipts.find(value => BigInt(value.receipt.status) === 0n);
      assert.ok(BigInt(winner.receipt.transactionIndex) < BigInt(loser.receipt.transactionIndex));
      assert.equal(loser.receipt.logs.length,0);
      assert.ok(BigInt(loser.receipt.gasUsed) < BigInt(loser.transaction.gas),"the duplicate must not fail by exhausting its transaction gas");
      assert.deepEqual(await queue.getDeliveryJob(id),job);
      return { canonical,identities,winner,loser };
    } catch (error) { failure = error; throw error; }
    finally {
      // No child can send after the shared mining mode is restored, including
      // failure paths where only one actor reached a barrier.
      try { await processes.close(); }
      catch (error) {
        if (failure) throw new AggregateError([failure,error],"duplicate transport and worker cleanup failed");
        throw error;
      }
    }
  });
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
