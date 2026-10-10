import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { applyValidatorMigrations, createValidatorPool, createValidatorStore } from "../../src/db.mjs";
import { loadValidatorConfig } from "../../src/config.mjs";
import { tableName } from "../../../indexer/src/db.mjs";

const MAIN = fileURLToPath(new URL("../../src/main.mjs", import.meta.url));

export async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, async release() {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

export async function rpcObserver(upstream) {
  const calls = [];
  const server = createHttpServer(async (request, response) => {
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8");
      const parsed = JSON.parse(body);
      calls.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      const remote = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" },
        body, signal: AbortSignal.timeout(5000) });
      response.writeHead(remote.status, { "content-type": "application/json" });
      response.end(await remote.text());
    } catch { response.writeHead(502); response.end("RPC forwarding failed"); }
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { calls, url: `http://127.0.0.1:${server.address().port}`, async close() {
    const closed = new Promise((resolve) => server.close(resolve)); server.closeAllConnections(); await closed;
  } };
}

export async function closeScenarioResources({ processes, peerProxies, rpcProxies, reservations, pools }) {
  // RPC must remain available until the validators finish their pending ticks.
  const processCleanup = await Promise.allSettled([processes.close()]);
  const transportCleanup = await Promise.allSettled([...peerProxies.map((proxy) => proxy.close()),
    ...rpcProxies.map((proxy) => proxy.close()), ...reservations.map((reservation) => reservation.release())]);
  const poolCleanup = await Promise.allSettled(pools.map((pool) => pool.end()));
  const failed = [...processCleanup, ...transportCleanup, ...poolCleanup].find((result) => result.status === "rejected");
  if (failed) throw new Error(`fault scenario cleanup failed: ${failed.reason.message}`);
}


export async function initializeValidatorState(environment, registerPool) {
  const config = loadValidatorConfig(environment);
  const pool = createValidatorPool(config); registerPool(pool);
  await applyValidatorMigrations(pool, config.databaseSchema);
  await pool.query(`TRUNCATE TABLE ${tableName(config.databaseSchema, "validator_set_history")}, ${tableName(config.databaseSchema, "pbft_new_views")}, ${tableName(config.databaseSchema, "pbft_view_change_votes")}, ${tableName(config.databaseSchema, "pbft_epoch_views")}, ${tableName(config.databaseSchema, "commit_rejections")},
    ${tableName(config.databaseSchema, "pbft_commit_quorums")}, ${tableName(config.databaseSchema, "pbft_commit_votes")},
    ${tableName(config.databaseSchema, "prepare_rejections")},
    ${tableName(config.databaseSchema, "pbft_prepared_states")}, ${tableName(config.databaseSchema, "pbft_prepare_votes")},
    ${tableName(config.databaseSchema, "validation_observations")},
    ${tableName(config.databaseSchema, "validated_batch_bindings")}, ${tableName(config.databaseSchema, "validator_metadata")},
    ${tableName(config.databaseSchema, "validator_committee")}, ${tableName(config.databaseSchema, "pbft_pre_prepares")},
    ${tableName(config.databaseSchema, "pre_prepare_rejections")}`);
  return { config, pool, store: createValidatorStore({ pool, config }) };
}

export function createValidatorProcesses({ keys, pidFile }) {
  assert.ok(pidFile, "verification must supply its owned validator PID registry");
  const records = [];
  const controller = new AbortController();
  let registryWrite = Promise.resolve();
  function updateRegistry() {
    registryWrite = registryWrite.then(() => writeFile(pidFile,
      `${records.filter((record) => !record.exited && record.child.pid).map((record) => record.child.pid).join("\n")}\n`));
    return registryWrite;
  }
  async function stop(record) {
    if (!record || record.exited) { await updateRegistry(); return; }
    record.child.kill("SIGTERM");
    const timeout = setTimeout(() => { if (!record.exited) record.child.kill("SIGKILL"); }, 5000);
    try { await record.closed; } finally { clearTimeout(timeout); await updateRegistry(); }
  }
  async function stopAll() { await Promise.all(records.map(stop)); }
  function onSignal() { controller.abort(); void stopAll().catch(() => {}); }
  process.once("SIGINT", onSignal); process.once("SIGTERM", onSignal);

  async function request(url, route, body) {
    const response = await fetch(`${url}${route}`, { method: body === undefined ? "GET" : "POST",
      // Negative/restart profiles deliberately reuse the same test port with a fresh process.
      headers: body === undefined ? { connection: "close" } : { "content-type": "application/json", connection: "close" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
    return { status: response.status, body: await response.json() };
  }
  async function start(environment, { expectFailure = false } = {}) {
    controller.signal.throwIfAborted();
    const child = spawn(process.execPath, [MAIN], { env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"] });
    let readyResolve;
    const ready = new Promise((resolve) => { readyResolve = resolve; });
    const record = { child, exited: false, stdout: "", stderr: "" };
    record.closed = new Promise((resolve) => {
      child.once("error", (error) => { record.exited = true; resolve({ code: null, error }); });
      child.once("exit", (code, signal) => { record.exited = true; resolve({ code, signal }); });
    });
    child.stdout.on("data", (chunk) => {
      record.stdout += chunk.toString(); process.stdout.write(chunk);
      if (record.stdout.includes("Validator ready:")) readyResolve();
    });
    child.stderr.on("data", (chunk) => { record.stderr += chunk.toString(); process.stderr.write(chunk); });
    records.push(record); await updateRegistry();
    let timeout;
    try {
      const expired = new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("validator startup timed out")), 10000); });
      if (expectFailure) {
        const result = await Promise.race([record.closed, ready.then(() => { throw new Error("invalid validator unexpectedly became ready"); }), expired]);
        assert.notEqual(result.code, 0, "invalid validator startup must fail");
        if (result.error) throw result.error;
      } else {
        await Promise.race([ready, record.closed.then((result) => { throw new Error(`validator exited before ready (${result.code}): ${record.stderr}`); }), expired]);
      }
      for (const key of [...keys, environment.VALIDATOR_PRIVATE_KEY]) {
        assert.ok(!record.stdout.includes(key) && !record.stderr.includes(key), "validator output must never contain private keys");
      }
      return record;
    } finally { clearTimeout(timeout); await updateRegistry(); }
  }

  let closing;
  function close() {
    if (!closing) closing = (async () => {
      controller.abort();
      try { await stopAll(); }
      finally {
        await updateRegistry();
        process.removeListener("SIGINT", onSignal);
        process.removeListener("SIGTERM", onSignal);
      }
    })();
    return closing;
  }
  return { start, stop, request, close, signal: controller.signal };
}
