// CLI and lifecycle orchestration stay outside the protocol source tree.
import assert from "node:assert/strict";
import { mkdir,open,readFile,rm } from "node:fs/promises";
import { join,resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { localConfiguration } from "./config.mjs";
import { ROOT,freePorts,httpJson,jsonText,processIdentity,readJson,safeError,stopRecordedProcess,waitFor,writeJson } from "./tools.mjs";

const activePath = join(ROOT,".run/local/active.json");
export function assertLocalOwnership(record) {
  assert.match(record.runId,/^[0-9a-f-]{36}$/);
  assert.ok([join(ROOT,".run/local"),join(ROOT,".run/verification")].includes(resolve(record.parent)),"unknown local runtime parent");
  assert.equal(resolve(record.directory),join(resolve(record.parent),record.runId),"runtime directory is outside its owned parent");
  assert.equal(new URL(record.control).hostname,"127.0.0.1");
  return record;
}
async function optionalJson(path) {
  try { return await readJson(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
}
export async function stopLocalStack(record) {
  assertLocalOwnership(record);
  const sameSupervisor = record.supervisor?.identity && await processIdentity(record.supervisor.pid) === record.supervisor.identity;
  if (sameSupervisor) {
    try {
      const response = await fetch(record.control + "/stop",{ method: "POST",headers: { "x-local-run": record.runId },signal: AbortSignal.timeout(3000) });
      if (!response.ok) throw new Error("Local stop request rejected");
    } catch { /* startup/stale control: signal the identity-checked supervisor */ }
    // Allow bounded initdb/pg_ctl work and child cleanup to settle before the
    // identity-checked fallback. A normal ready-stack shutdown returns quickly.
    await stopRecordedProcess(record.supervisor,{ graceMs: 90000 });
  }
  // SIGKILL or an interrupted startup can leave children. Only this run's exact
  // OS identities are eligible; a recycled PID is never terminated.
  const children = await optionalJson(join(record.directory,"processes.json")) ?? [];
  for (const child of [...children].reverse()) await stopRecordedProcess(child);
  const { disposeOwnedPostgres } = await import("../../../scripts/lib/owned-postgres.mjs");
  await disposeOwnedPostgres(join(record.directory,"postgres.json"));
}

export async function startLocalStack(config = undefined) {
  const interactive = config === undefined;
  if (interactive) {
    const existing = await optionalJson(activePath);
    if (existing) {
      assertLocalOwnership(existing);
      if (existing.supervisor?.identity && await processIdentity(existing.supervisor.pid) === existing.supervisor.identity) {
        const status = await waitFor("existing local stack",async () => {
          const value = await httpJson(existing.control + "/status");
          if (value.runId !== existing.runId) throw new Error("Local control belongs to another run");
          if (value.failure || value.degraded?.length) throw Object.assign(new Error(value.failure ?? `Observation surfaces unavailable: ${value.degraded.join(", ")}; use stop.sh/start.sh`),{ fatal: true });
          return value.ready ? value : false;
        },{ timeout: 180000 });
        if (status.ready) {
          const stack = { record: existing,manifest: await readJson(join(existing.directory,"manifest.json")) };
          return { ...stack,message: await ensureLocalExplorerMessage(stack) };
        }
      }
      await stopLocalStack(existing);
    }
  }
  config ??= await localConfiguration();
  await mkdir(config.parent,{ recursive: true,mode: 0o700 });
  const lockPath = join(config.parent,"start.lock");
  let lock;
  try { lock = await open(lockPath,"wx",0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    const owner = await readJson(lockPath);
    if (await processIdentity(owner.pid) === owner.identity) throw new Error("A local startup is already in progress; wait for it to finish");
    await rm(lockPath); lock = await open(lockPath,"wx",0o600);
  }
  let record;
  let interrupted = false;
  const startup = new AbortController();
  const interrupt = () => { interrupted = true; startup.abort(); };
  process.once("SIGINT",interrupt); process.once("SIGTERM",interrupt);
  try {
    await lock.writeFile(jsonText({ pid: process.pid,identity: await processIdentity(process.pid) }));
    await mkdir(config.directory,{ mode: 0o700 });
    await writeJson(join(config.directory,"config.json"),config);
    const output = await open(join(config.directory,"supervisor.log"),"a",0o600);
    // The supervisor persists after this CLI finishes both readiness and its
    // initial confirmed message. Verification controls its own messages.
    const { spawn } = await import("node:child_process");
    const child = spawn(process.execPath,[fileURLToPath(import.meta.url),"supervise",join(config.directory,"config.json")],{
      cwd: ROOT,env: process.env,detached: true,stdio: ["ignore",output.fd,output.fd],
    });
    const spawned = new Promise((accept,reject) => { child.once("spawn",accept); child.once("error",reject); });
    try { await spawned; } finally { await output.close(); }
    child.unref();
    record = { ...config,supervisor: { pid: child.pid,identity: await processIdentity(child.pid) } };
    await writeJson(join(config.directory,"owner.json"),record);
    if (config.isolated && process.env.LOCAL_VERIFICATION_OWNER_FILE) await writeJson(process.env.LOCAL_VERIFICATION_OWNER_FILE,record);
    if (interactive) await writeJson(activePath,record);
    let lastPhase;
    await waitFor("complete local stack",async () => {
      const status = await httpJson(config.control + "/status");
      assert.equal(status.runId,config.runId);
      if (status.phase !== lastPhase) { console.log("Local startup: " + status.phase); lastPhase = status.phase; }
      if (status.failure) throw Object.assign(new Error(status.failure),{ fatal: true });
      return status.ready;
    },{ timeout: 180000,alive() {
      if (interrupted) throw new Error("Local startup interrupted; cleaning up this owned run");
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Local supervisor exited; see ${join(config.directory,"supervisor.log")}`);
    } });
    const stack = { record,manifest: await readJson(join(config.directory,"manifest.json")) };
    if (interactive) stack.message = await ensureLocalExplorerMessage(stack,console.log,{ signal: startup.signal });
    if (interrupted) throw new Error("Local startup interrupted; cleaning up this owned run");
    return stack;
  } catch (error) {
    try { console.error(safeError({ message: await readFile(join(config.directory,"supervisor.log"),"utf8") })); } catch { /* startup may have failed before log creation */ }
    if (record) await stopLocalStack(record);
    throw error;
  } finally {
    process.removeListener("SIGINT",interrupt); process.removeListener("SIGTERM",interrupt);
    await lock.close(); await rm(lockPath,{ force: true });
  }
}

export async function demonstrateLocalStack(record,onMessage = console.log,scenario = "happy-path",signal) {
  assertLocalOwnership(record);
  if (!["happy-path","byzantine-validator","validator-crash","relayer-failover","source-reorg","replay-attack","recovery"].includes(scenario)) throw new Error("Unknown local demonstration scenario");
  const path = scenario === "happy-path" ? "/demo" : "/demo/" + scenario;
  const deadline = AbortSignal.timeout(600000);
  const response = await fetch(record.control + path,{ method: "POST",headers: { "x-local-run": record.runId },
    signal: signal ? AbortSignal.any([deadline,signal]) : deadline });
  if (!response.ok) throw new Error((await response.json()).error ?? "Local demonstration request failed");
  const decoder = new TextDecoder(); let buffer = ""; let result;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk,{ stream: true });
    const lines = buffer.split("\n"); buffer = lines.pop();
    for (const line of lines.filter(Boolean)) {
      const item = JSON.parse(line);
      if (item.error) throw new Error(item.error);
      if (item.progress) onMessage(item.progress);
      if (item.result) result = item.result;
    }
  }
  if (!result || buffer.trim()) throw new Error("Local demo ended without a complete result");
  return result;
}

// Both the product launcher and clean-stack verification use this exact path.
// The persisted result locates a message; the live API must still confirm its
// canonical execution before startup can report an Explorer-ready message.
export async function ensureLocalExplorerMessage({ record,manifest },onMessage = console.log,{
  signal,readResult = optionalJson,readMessage = httpJson,demonstrate = demonstrateLocalStack,
} = {}) {
  assertLocalOwnership(record);
  signal?.throwIfAborted();
  const existing = await readResult(join(record.directory,"demo-result.json"));
  let result = existing;
  if (!result) {
    onMessage("Preparing the initial confirmed message for the Explorer; no separate demonstration command is required");
    result = await demonstrate(record,onMessage,"happy-path",signal);
  }
  assert.match(result.messageId,/^0x[0-9a-f]{64}$/);
  assert.equal(result.privacy,"PASSED","initial message privacy verification must pass");
  assert.equal(result.messageExecuted,true); assert.equal(result.supplierVerified,true);
  signal?.throwIfAborted();
  const observed = await readMessage(manifest.api + "/api/v1/messages/" + result.messageId);
  assert.equal(observed.execution?.status,"CONFIRMED","initial Explorer message must remain confirmed");
  assert.equal(observed.destinationTransaction?.transactionHash,result.destinationTransaction);
  assert.equal(observed.batch?.batchId,result.batchId); assert.equal(observed.qc?.qcDigest,result.qcDigest);
  signal?.throwIfAborted();
  onMessage(`${existing ? "Reusing" : "Prepared"} confirmed Explorer message ${result.messageId}`);
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  try {
    if (command === "ports") console.log((await freePorts(2)).join(" "));
    else if (command === "prerequisites") {
      const { observabilityTools } = await import("./observability.mjs");
      const tools = await observabilityTools();
      console.log(`Existing native Prometheus: ${tools.prometheus}\nExisting native Grafana: ${tools.grafana}\nGrafana home: ${tools.home}`);
    }
    else if (command === "dispose") await stopLocalStack(await readJson(process.argv[3]));
    else if (command === "supervise") {
      const { supervise } = await import("./supervisor.mjs");
      await supervise(assertLocalOwnership(await readJson(process.argv[3])));
    } else {
      try { process.loadEnvFile(join(ROOT,".env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (command === "start") {
        const { manifest,message } = await startLocalStack();
        console.log(`\nExplorer: ${manifest.api}/\nConfirmed message: ${manifest.api}/?messageId=${message.messageId}\nPrometheus: ${manifest.prometheus}/\nGrafana: ${manifest.grafana}/d/cross-chain-protocol\nRuntime/logs: ${manifest.directory}\nFull verification: ./scripts/verify.sh\nStop this owned stack: ./scripts/stop.sh`);
      } else if (command === "stop") {
        const record = await optionalJson(activePath);
        if (record) { await stopLocalStack(record); await rm(activePath,{ force: true }); }
        console.log("Owned local stack stopped; runtime logs retained. Existing external PostgreSQL was left running.");
      } else throw new Error("usage: local/main.mjs start | stop");
    }
  } catch (error) { console.error(safeError(error)); process.exitCode = 1; }
}
