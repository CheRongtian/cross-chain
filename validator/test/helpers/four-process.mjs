import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createServer as createTcpServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
import { fileURLToPath } from "node:url";
import { applyValidatorMigrations, createValidatorPool, createValidatorStore } from "../../src/db.mjs";
import { loadValidatorConfig } from "../../src/config.mjs";
import { validatorAccount } from "../../src/identity.mjs";
import { verifyHandshakeResponse } from "../../src/handshake.mjs";
import { tableName } from "../../../indexer/src/db.mjs";
import { developmentKeys } from "./fixtures.mjs";

const MAIN = fileURLToPath(new URL("../../src/main.mjs", import.meta.url));
const SOURCE_TABLES = ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batches", "message_batch_members"];
const ORDER = { source_messages: "id", indexer_cursors: "chain_domain, source_gateway",
  indexed_source_blocks: "source_domain, source_gateway, block_number", message_batches: "batch_record_id",
  message_batch_members: "batch_record_id, source_message_id" };

async function reservePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { port: server.address().port, async release() {
    if (server.listening) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  } };
}

async function rpcObserver(upstream) {
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

async function sourceState(pool, schema) {
  const result = {};
  for (const table of SOURCE_TABLES) {
    result[table] = (await pool.query(`SELECT * FROM ${tableName(schema, table)} ORDER BY ${ORDER[table]}`)).rows;
  }
  return result;
}

async function cloneCandidateFixture(pool, sourceSchema, fixtureSchema) {
  // Only isolated test tables are mutable. Original source tables and triggers are untouched.
  await pool.query(`CREATE SCHEMA IF NOT EXISTS "${fixtureSchema}"`);
  for (const table of SOURCE_TABLES) {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${tableName(fixtureSchema, table)}
      (LIKE ${tableName(sourceSchema, table)} INCLUDING ALL)`);
  }
  await pool.query(`TRUNCATE TABLE ${SOURCE_TABLES.map((table) => tableName(fixtureSchema, table)).join(", ")}`);
  for (const table of SOURCE_TABLES) {
    const override = ["source_messages", "message_batches"].includes(table) ? "OVERRIDING SYSTEM VALUE" : "";
    await pool.query(`INSERT INTO ${tableName(fixtureSchema, table)} ${override} SELECT * FROM ${tableName(sourceSchema, table)}`);
  }
}

export async function verifyFourIndependentValidators({ sourceConfig, sourcePool, snapshot, pidFile }) {
  assert.ok(pidFile, "verification must supply its owned validator PID registry");
  assert.equal(snapshot.record.status, "CONSENSUS_PENDING");
  const prefix = "cross_chain_validator_verification";
  const localUrl = process.env.VALIDATOR_VERIFICATION_DATABASE_URL || sourceConfig.databaseUrl;
  const keys = developmentKeys();
  const reservations = [];
  const proxies = [];
  const records = [];
  const pools = [];
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
  async function initializeState(environment) {
    const config = loadValidatorConfig(environment);
    const pool = createValidatorPool(config); pools.push(pool);
    await applyValidatorMigrations(pool, config.databaseSchema);
    await pool.query(`TRUNCATE TABLE ${tableName(config.databaseSchema, "validation_observations")},
      ${tableName(config.databaseSchema, "validated_batch_bindings")}, ${tableName(config.databaseSchema, "validator_metadata")}`);
    return { config, pool, store: createValidatorStore({ pool, config }) };
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

  try {
    const originalSourceState = await sourceState(sourcePool, sourceConfig.databaseSchema);
    for (let index = 0; index < 4; index++) { reservations.push(await reservePort()); proxies.push(await rpcObserver(sourceConfig.chainRpcUrl)); }
    const peers = keys.map((key, index) => ({ address: validatorAccount(key).address.toLowerCase(), url: `http://127.0.0.1:${reservations[index].port}` }));
    const environments = peers.map((peer, index) => ({
      VALIDATOR_PRIVATE_KEY: keys[index], VALIDATOR_LISTEN_HOST: "127.0.0.1", VALIDATOR_LISTEN_PORT: String(reservations[index].port),
      VALIDATOR_PEERS: JSON.stringify(peers), VALIDATOR_DATABASE_URL: localUrl, VALIDATOR_DB_SCHEMA: `${prefix}_v${index + 1}`,
      SOURCE_DATABASE_URL: sourceConfig.databaseUrl, SOURCE_DB_SCHEMA: sourceConfig.databaseSchema,
      CHAIN_A_DOMAIN: sourceConfig.chainDomain.toString(), SOURCE_GATEWAY_ADDRESS: sourceConfig.sourceGateway,
      CHAIN_A_RPC_URL: proxies[index].url, FINALITY_BLOCK_DEPTH: sourceConfig.finalityBlockDepth.toString(),
    }));
    const states = [];
    const validators = [];
    for (let index = 0; index < 4; index++) {
      states.push(await initializeState(environments[index]));
      await reservations[index].release();
      validators.push(await start(environments[index]));
      const health = await request(peers[index].url, "/health");
      assert.equal(health.status, 200); assert.equal(health.body.ready, true);
      assert.equal(health.body.pid, validators[index].child.pid);
      const identity = await request(peers[index].url, "/identity");
      assert.equal(identity.body.validatorAddress, peers[index].address);
      assert.ok(!JSON.stringify(identity.body).includes(keys[index]));
    }
    assert.equal(new Set(validators.map((record) => record.child.pid)).size, 4);
    assert.equal(new Set(peers.map((peer) => peer.address)).size, 4);
    console.log("VALID: four independent validator PIDs, keys, endpoints, and persistent namespaces");

    for (let requester = 0; requester < 4; requester++) {
      for (let responder = 0; responder < 4; responder++) {
        if (requester === responder) continue;
        const result = await request(peers[requester].url, "/connect-peer", { peerAddress: peers[responder].address });
        assert.equal(result.status, 200); assert.equal(result.body.authenticated, true);
        assert.equal(result.body.peerAddress, peers[responder].address);
      }
    }
    const challenge = `0x${"a7".repeat(32)}`;
    const signed = await request(peers[1].url, "/handshake", { requesterAddress: peers[0].address, challenge });
    assert.equal(await verifyHandshakeResponse(states[0].config, peers[1].address, challenge, signed.body), true);
    assert.equal(await verifyHandshakeResponse(states[0].config, peers[1].address, challenge, { ...signed.body, validatorAddress: peers[2].address }), false);
    assert.equal(await verifyHandshakeResponse(states[0].config, peers[1].address, `0x${"b8".repeat(32)}`, signed.body), false);
    console.log("VALID: all directed validator peer handshakes authenticated; tampered identity/challenge rejected");

    const observations = [];
    for (let index = 0; index < 4; index++) {
      const beforeCalls = proxies[index].calls.length;
      const result = await request(peers[index].url, "/validate-batch", { batchId: snapshot.record.batchId });
      assert.equal(result.status, 200); assert.equal(result.body.result, "VALID");
      assert.equal(result.body.validatorAddress, peers[index].address);
      assert.equal(result.body.messageRoot, snapshot.record.messageRoot);
      const calls = proxies[index].calls.slice(beforeCalls);
      assert.equal(calls.filter((call) => call.method === "eth_getBlockByNumber" && call.params[0] === "latest").length, 1);
      assert.equal(calls.filter((call) => call.method === "eth_getTransactionReceipt").length,
        new Set(snapshot.batch.messages.map((member) => member.sourceTransactionHash)).size);
      assert.ok(calls.some((call) => call.method === "eth_chainId"));
      assert.ok(calls.some((call) => call.method === "eth_getCode"));
      observations.push(await states[index].store.readObservations());
      assert.equal(observations[index].length, 1);
      if (index === 0) {
        for (let other = 1; other < 4; other++) assert.deepEqual(await states[other].store.readObservations(), []);
      }
      const again = await request(peers[index].url, "/validate-batch", { batchId: snapshot.record.batchId });
      assert.equal(again.status, 200);
      assert.deepEqual(await states[index].store.readObservations(), observations[index]);
      console.log(`VALID: V${index + 1} independently queried Chain A, reconstructed the pending batch, and persisted a local VALID observation`);
    }
    const wrongId = await request(peers[0].url, "/validate-batch", { batchId: `0x${"ff".repeat(32)}` });
    assert.equal(wrongId.status, 422);
    assert.equal(wrongId.body.result, "INVALID");
    await stop(validators[3]);
    for (let index = 0; index < 3; index++) {
      assert.equal((await request(peers[index].url, "/health")).status, 200);
      assert.deepEqual(await states[index].store.readObservations(), observations[index]);
    }
    console.log("VALID: stopping V4 preserved V1/V2/V3 processes and isolated observations");

    // Negative profiles reuse the V4 identity with separate local/source test namespaces.
    const fixtureSchema = `${prefix}_source_fixture`;
    for (const mutation of ["root", "block", "reorged"]) {
      await cloneCandidateFixture(sourcePool, sourceConfig.databaseSchema, fixtureSchema);
      if (mutation === "root") {
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "message_batches")} SET message_root = $2 WHERE batch_id = $1`,
          [snapshot.record.batchId, `0x${"ee".repeat(32)}`]);
      } else if (mutation === "block") {
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "source_messages")} SET source_block_hash = $2 WHERE id = $1`,
          [snapshot.members[0].sourceMessageId, `0x${"ee".repeat(32)}`]);
      } else {
        const orphan = originalSourceState.source_messages.find((row) => row.status === "REORGED");
        assert.ok(orphan);
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "message_batch_members")}
          SET source_message_id = $2, message_id = $3 WHERE batch_record_id = $1 AND canonical_position = 2`,
        [snapshot.record.batchRecordId, orphan.id, orphan.message_id]);
      }
      const env = { ...environments[3], SOURCE_DB_SCHEMA: fixtureSchema, VALIDATOR_DB_SCHEMA: `${prefix}_negative_${mutation}` };
      await initializeState(env);
      const child = await start(env);
      const result = await request(peers[3].url, "/validate-batch", { batchId: snapshot.record.batchId });
      assert.equal(result.status, 422); assert.equal(result.body.result, "INVALID");
      await stop(child);
    }
    const tooDeep = { ...environments[3], VALIDATOR_DB_SCHEMA: `${prefix}_negative_depth`,
      FINALITY_BLOCK_DEPTH: (BigInt(observations[3][0].source_head_number) + 1n).toString() };
    await initializeState(tooDeep);
    const shallow = await start(tooDeep);
    const depthResult = await request(peers[3].url, "/validate-batch", { batchId: snapshot.record.batchId });
    assert.equal(depthResult.status, 422); assert.equal(depthResult.body.reason, "INSUFFICIENT_DEPTH");
    await stop(shallow);
    const wrongChain = await start({ ...environments[3], CHAIN_A_RPC_URL: "http://127.0.0.1:9545" }, { expectFailure: true });
    assert.match(wrongChain.stderr, /Chain A domain mismatch/);
    const wrongGateway = { ...environments[3], VALIDATOR_DB_SCHEMA: `${prefix}_negative_gateway`,
      SOURCE_GATEWAY_ADDRESS: "0x0000000000000000000000000000000000009999" };
    await initializeState(wrongGateway);
    const gatewayFailure = await start(wrongGateway, { expectFailure: true });
    assert.match(gatewayFailure.stderr, /no contract bytecode/);
    console.log("VALID: real wrong reference/root/block, injected REORGED member, insufficient RPC depth, wrong chain, and wrong Gateway rejected");

    const wrongKey = `0x${99n.toString(16).padStart(64, "0")}`;
    const wrongPeers = peers.map((peer, index) => index === 3 ? { ...peer, address: validatorAccount(wrongKey).address.toLowerCase() } : peer);
    const wrongIdentity = await start({ ...environments[3], VALIDATOR_PRIVATE_KEY: wrongKey, VALIDATOR_PEERS: JSON.stringify(wrongPeers) }, { expectFailure: true });
    assert.match(wrongIdentity.stderr, /identity or source context mismatch/);
    assert.deepEqual(await states[3].store.readObservations(), observations[3]);
    const previousPid = validators[3].child.pid;
    validators[3] = await start(environments[3]);
    assert.notEqual(validators[3].child.pid, previousPid);
    const restored = await request(peers[3].url, "/observations");
    assert.equal(restored.body.observations.length, 1);
    assert.equal(restored.body.observations[0].batch_id, snapshot.record.batchId);
    assert.equal((await request(peers[3].url, "/validate-batch", { batchId: snapshot.record.batchId })).status, 200);
    for (let index = 0; index < 4; index++) assert.deepEqual(await states[index].store.readObservations(), observations[index]);
    assert.deepEqual(await sourceState(sourcePool, sourceConfig.databaseSchema), originalSourceState);
    console.log("VALID: fresh V4 process recovered its own identity and observation; wrong-key recovery rejected");
    console.log("VALID: validator operations preserved source rows, cursor, blocks, membership, roots, and CONSENSUS_PENDING");
  } finally {
    controller.abort();
    const cleanup = await Promise.allSettled([
      stopAll(), ...reservations.map((reservation) => reservation.release()),
      ...proxies.map((proxy) => proxy.close()), ...pools.map((pool) => pool.end()),
    ]);
    const registry = await Promise.allSettled([updateRegistry()]);
    process.removeListener("SIGINT", onSignal); process.removeListener("SIGTERM", onSignal);
    const failure = [...cleanup, ...registry].find((result) => result.status === "rejected");
    if (failure) throw new Error(`validator verification cleanup failed: ${failure.reason.message}`);
  }
}
