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
import { deterministicPrimary } from "../../src/committee.mjs";
import { prePrepareDigest } from "../../src/pre-prepare.mjs";
import { prepareDigest } from "../../src/prepare.mjs";
import { commitDigest } from "../../src/commit.mjs";
import { buildQuorumCertificate, expectedCommitStatement, qcDigest, verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";
import { createBatchLifecycle } from "../../../indexer/src/batch-lifecycle.mjs";

const MAIN = fileURLToPath(new URL("../../src/main.mjs", import.meta.url));
const SOURCE_TABLES = ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batches", "message_batch_members",
  "batch_quorum_certificates", "batch_quorum_certificate_signatures"];
const ORDER = { source_messages: "id", indexer_cursors: "chain_domain, source_gateway",
  indexed_source_blocks: "source_domain, source_gateway, block_number", message_batches: "batch_record_id",
  message_batch_members: "batch_record_id, source_message_id", batch_quorum_certificates: "batch_record_id",
  batch_quorum_certificate_signatures: "batch_record_id, voter_identity" };

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
    await pool.query(`TRUNCATE TABLE ${tableName(config.databaseSchema, "commit_rejections")},
      ${tableName(config.databaseSchema, "pbft_commit_quorums")}, ${tableName(config.databaseSchema, "pbft_commit_votes")},
      ${tableName(config.databaseSchema, "prepare_rejections")},
      ${tableName(config.databaseSchema, "pbft_prepared_states")}, ${tableName(config.databaseSchema, "pbft_prepare_votes")},
      ${tableName(config.databaseSchema, "validation_observations")},
      ${tableName(config.databaseSchema, "validated_batch_bindings")}, ${tableName(config.databaseSchema, "validator_metadata")},
      ${tableName(config.databaseSchema, "validator_committee")}, ${tableName(config.databaseSchema, "pbft_pre_prepares")},
      ${tableName(config.databaseSchema, "pre_prepare_rejections")}`);
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
      VALIDATOR_PEERS: JSON.stringify([...peers.slice(index), ...peers.slice(0, index)].reverse()),
      VALIDATOR_DATABASE_URL: localUrl, VALIDATOR_DB_SCHEMA: `${prefix}_v${index + 1}`,
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

    const epoch = snapshot.record.epoch.toString();
    const primaryAddress = deterministicPrimary(peers, epoch);
    const primaryIndex = peers.findIndex((peer) => peer.address === primaryAddress);
    const backups = peers.map((_, index) => index).filter((index) => index !== primaryIndex);
    for (let index = 0; index < 4; index++) {
      const selection = await request(peers[index].url, "/pbft/primary", { epoch });
      assert.equal(selection.status, 200);
      assert.equal(selection.body.primaryIdentity, primaryAddress);
      console.log(`VALID: V${index + 1} independently selected primary ${primaryAddress} for epoch ${epoch}`);
    }
    const proposal = { messageType: "PRE_PREPARE", protocolVersion: "1", sourceDomain: sourceConfig.chainDomain.toString(),
      sourceGateway: sourceConfig.sourceGateway, epoch, batchId: snapshot.record.batchId,
      messageRoot: snapshot.record.messageRoot, primaryIdentity: primaryAddress };
    async function signedProposal(fields, signerIndex = primaryIndex) {
      const proposalDigest = prePrepareDigest(fields);
      const signature = await validatorAccount(keys[signerIndex]).signMessage({ message: { raw: proposalDigest } });
      return { ...fields, proposalDigest, signature };
    }
    async function expectProposalRejection(index, envelope, reason) {
      const response = await request(peers[index].url, "/pbft/pre-prepare", envelope);
      assert.equal(response.status, 422); assert.equal(response.body.result, "REJECTED");
      assert.equal(response.body.reason, reason);
      console.log(`VALID: V${index + 1} rejected PRE-PREPARE (${reason})`);
    }
    const canonical = await signedProposal(proposal);
    const wrongRoot = await signedProposal({ ...proposal, messageRoot: `0x${"ee".repeat(32)}` });
    const nonPrimary = backups[0];
    const callsBeforeWrongRoot = proxies[nonPrimary].calls.length;
    await expectProposalRejection(nonPrimary, wrongRoot, "WRONG_ROOT");
    assert.ok(proxies[nonPrimary].calls.slice(callsBeforeWrongRoot).some((call) => call.method === "eth_getTransactionReceipt"),
      "a correctly signed wrong root must reach independent source reconstruction before rejection");
    const wrongPrimary = await signedProposal({ ...proposal, primaryIdentity: peers[nonPrimary].address }, nonPrimary);
    await expectProposalRejection(backups[1], wrongPrimary, "WRONG_PRIMARY");
    await expectProposalRejection(nonPrimary, { ...canonical, signature: `0x${"00".repeat(65)}` }, "INVALID_SIGNATURE");
    await expectProposalRejection(nonPrimary, await signedProposal({ ...proposal, batchId: `0x${"ff".repeat(32)}` }), "UNKNOWN_BATCH");
    const nextEpoch = (BigInt(epoch) + 1n).toString();
    const nextPrimary = deterministicPrimary(peers, nextEpoch);
    await expectProposalRejection(nonPrimary, await signedProposal({ ...proposal, epoch: nextEpoch, primaryIdentity: nextPrimary },
      peers.findIndex((peer) => peer.address === nextPrimary)), "WRONG_EPOCH");
    const refused = await request(peers[nonPrimary].url, "/pbft/propose", { batchId: proposal.batchId });
    assert.equal(refused.status, 422); assert.equal(refused.body.reason, "WRONG_PRIMARY");
    for (const state of states) assert.deepEqual(await state.store.readPrePrepares(), []);

    // Explicitly stop one backup before the first broadcast; connection refusal is deterministic.
    const offlineIndex = backups[2];
    await stop(validators[offlineIndex]);
    const rpcStarts = proxies.map((proxy) => proxy.calls.length);
    const issued = await request(peers[primaryIndex].url, "/pbft/propose", { batchId: proposal.batchId });
    assert.equal(issued.status, 200); assert.equal(issued.body.result, "ACCEPTED");
    assert.equal(issued.body.record.direction, "ISSUED");
    assert.deepEqual(issued.body.record.envelope, canonical);
    assert.equal(issued.body.deliveries.length, 3);
    assert.equal(issued.body.deliveries.find((entry) => entry.peerAddress === peers[offlineIndex].address).delivery, "FAILED");
    for (let index = 0; index < 4; index++) {
      const proposals = await states[index].store.readPrePrepares();
      assert.equal(proposals.length, index === offlineIndex ? 0 : 1);
      if (index === offlineIndex) continue;
      assert.equal(proposals[0].envelope.proposalDigest, canonical.proposalDigest);
      const calls = proxies[index].calls.slice(rpcStarts[index]);
      assert.equal(calls.filter((call) => call.method === "eth_getBlockByNumber" && call.params[0] === "latest").length, 1);
      assert.equal(calls.filter((call) => call.method === "eth_getTransactionReceipt").length,
        new Set(snapshot.batch.messages.map((member) => member.sourceTransactionHash)).size);
    }
    const savedPrimary = await states[primaryIndex].store.readPrePrepare(epoch);
    const savedBackup = await states[backups[0]].store.readPrePrepare(epoch);
    const primaryPid = validators[primaryIndex].child.pid;
    await stop(validators[primaryIndex]);
    validators[primaryIndex] = await start(environments[primaryIndex]);
    assert.notEqual(validators[primaryIndex].child.pid, primaryPid);
    assert.deepEqual(await states[primaryIndex].store.readPrePrepare(epoch), savedPrimary);
    validators[offlineIndex] = await start(environments[offlineIndex]);
    const retry = await request(peers[primaryIndex].url, "/pbft/propose", { batchId: proposal.batchId });
    assert.equal(retry.status, 200); assert.deepEqual(retry.body.record, savedPrimary);
    assert.ok(retry.body.deliveries.every((entry) => entry.delivery === "DELIVERED" && entry.result === "ACCEPTED"));
    assert.deepEqual(await states[backups[0]].store.readPrePrepare(epoch), savedBackup);
    const acceptedBeforeDuplicates = await Promise.all(states.map((state) => state.store.readPrePrepares()));
    for (const index of backups) {
      const duplicates = await Promise.all(Array.from({ length: 3 }, () => request(peers[index].url, "/pbft/pre-prepare", canonical)));
      for (const response of duplicates) { assert.equal(response.status, 200); assert.equal(response.body.result, "ACCEPTED"); }
      assert.deepEqual(await states[index].store.readPrePrepares(), acceptedBeforeDuplicates[index]);
      await expectProposalRejection(index, wrongRoot, "CONFLICTING_PRE_PREPARE");
    }
    const restartIndex = backups[0];
    const backupPid = validators[restartIndex].child.pid;
    await stop(validators[restartIndex]);
    validators[restartIndex] = await start(environments[restartIndex]);
    assert.notEqual(validators[restartIndex].child.pid, backupPid);
    const recovered = await request(peers[restartIndex].url, "/pbft/pre-prepares");
    assert.equal(recovered.status, 200); assert.deepEqual(recovered.body.proposals, acceptedBeforeDuplicates[restartIndex]);
    assert.equal((await request(peers[restartIndex].url, "/pbft/pre-prepare", canonical)).status, 200);
    await expectProposalRejection(restartIndex, wrongRoot, "CONFLICTING_PRE_PREPARE");
    console.log("VALID: primary persistence, partial broadcast retry, concurrent duplicates, and fresh primary/backup recovery preserved one digest");

    // Fresh isolated receivers have no accepted slot that could mask invalid source/lifecycle cases.
    await stop(validators[3]);
    for (const mutation of ["sealed", "block", "reorged", "root"]) {
      await cloneCandidateFixture(sourcePool, sourceConfig.databaseSchema, fixtureSchema);
      if (mutation === "sealed") {
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "message_batches")} SET status = 'SEALED', consensus_pending_at = NULL WHERE batch_id = $1`, [proposal.batchId]);
      } else if (mutation === "block") {
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "source_messages")} SET source_block_hash = $2 WHERE id = $1`,
          [snapshot.members[0].sourceMessageId, `0x${"ee".repeat(32)}`]);
      } else if (mutation === "root") {
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "message_batches")} SET message_root = $2 WHERE batch_id = $1`, [proposal.batchId, `0x${"ee".repeat(32)}`]);
      } else {
        const orphan = originalSourceState.source_messages.find((row) => row.status === "REORGED");
        assert.ok(orphan);
        await sourcePool.query(`UPDATE ${tableName(fixtureSchema, "message_batch_members")}
          SET source_message_id = $2, message_id = $3 WHERE batch_record_id = $1 AND canonical_position = 2`,
        [snapshot.record.batchRecordId, orphan.id, orphan.message_id]);
      }
      const env = { ...environments[3], SOURCE_DB_SCHEMA: fixtureSchema, VALIDATOR_DB_SCHEMA: `${prefix}_pre_${mutation}` };
      const state = await initializeState(env);
      const child = await start(env);
      await expectProposalRejection(3, canonical, mutation === "sealed" ? "INVALID_LIFECYCLE" : "INVALID_SOURCE_STATE");
      assert.deepEqual(await state.store.readPrePrepares(), []);
      await stop(child);
    }
    const preDepth = { ...environments[3], VALIDATOR_DB_SCHEMA: `${prefix}_pre_depth`,
      FINALITY_BLOCK_DEPTH: (BigInt(observations[3][0].source_head_number) + 1n).toString() };
    const depthState = await initializeState(preDepth);
    const depthChild = await start(preDepth);
    await expectProposalRejection(3, canonical, "INVALID_SOURCE_STATE");
    assert.deepEqual(await depthState.store.readPrePrepares(), []);
    await stop(depthChild);
    validators[3] = await start(environments[3]);
    for (let index = 0; index < 4; index++) {
      assert.deepEqual(await states[index].store.readPrePrepares(), acceptedBeforeDuplicates[index]);
      assert.deepEqual(await states[index].store.readObservations(), observations[index]);
      assert.equal((await request(peers[index].url, "/health")).status, 200);
    }

    for (const state of states) {
      const initial = await state.store.readPrepareState(epoch);
      assert.equal(initial.voteCount, 0); assert.equal(initial.prepared, null);
    }
    const earlyCommit = await request(peers[primaryIndex].url, "/pbft/commit/cast", { epoch });
    assert.equal(earlyCommit.status, 422); assert.equal(earlyCommit.body.reason, "NOT_PREPARED");
    const earlyFields = { messageType: "COMMIT", ...expectedCommitStatement(proposal, peers), voterIdentity: peers[primaryIndex].address };
    const earlyDigest = commitDigest(earlyFields);
    const earlySignature = await validatorAccount(keys[primaryIndex]).signMessage({ message: { raw: earlyDigest } });
    const earlyRemote = await request(peers[backups[0]].url, "/pbft/commit",
      { ...earlyFields, commitDigest: earlyDigest, signature: earlySignature });
    assert.equal(earlyRemote.status, 422); assert.equal(earlyRemote.body.reason, "NOT_PREPARED");
    const prepareVoters = [primaryIndex, ...backups];
    const firstVoter = prepareVoters[0];
    const offlinePrepareReceiver = prepareVoters[3];
    await stop(validators[offlinePrepareReceiver]);
    const firstCast = await request(peers[firstVoter].url, "/pbft/prepare/cast", { epoch });
    assert.equal(firstCast.status, 200); assert.equal(firstCast.body.result, "ACCEPTED");
    assert.equal(firstCast.body.voteCount, 1); assert.equal(firstCast.body.prepared, false);
    assert.equal(firstCast.body.record.vote.voterIdentity, peers[firstVoter].address);
    assert.equal(firstCast.body.deliveries.find((entry) => entry.peerAddress === peers[offlinePrepareReceiver].address).delivery, "FAILED");
    const firstVote = firstCast.body.record.vote;
    const firstVoterPid = validators[firstVoter].child.pid;
    await stop(validators[firstVoter]);
    validators[firstVoter] = await start(environments[firstVoter]);
    assert.notEqual(validators[firstVoter].child.pid, firstVoterPid);
    assert.deepEqual((await states[firstVoter].store.readPrepareVote(epoch, peers[firstVoter].address)).vote, firstVote);
    validators[offlinePrepareReceiver] = await start(environments[offlinePrepareReceiver]);
    const firstRetry = await request(peers[firstVoter].url, "/pbft/prepare/cast", { epoch });
    assert.equal(firstRetry.status, 200); assert.deepEqual(firstRetry.body.record.vote, firstVote);
    assert.ok(firstRetry.body.deliveries.every((entry) => entry.delivery === "DELIVERED" && entry.result === "ACCEPTED"));
    for (const state of states) {
      const current = await state.store.readPrepareState(epoch);
      assert.equal(current.voteCount, 1); assert.equal(current.prepared, null);
    }
    console.log("VALID: self PREPARE persisted before a partial broadcast and fresh-process retry delivered the same vote");

    const secondVoter = prepareVoters[1];
    const secondCast = await request(peers[secondVoter].url, "/pbft/prepare/cast", { epoch });
    assert.equal(secondCast.status, 200); assert.equal(secondCast.body.result, "ACCEPTED");
    for (const state of states) {
      const current = await state.store.readPrepareState(epoch);
      assert.equal(current.voteCount, 2); assert.equal(current.prepared, null);
    }
    for (let index = 0; index < 4; index++) {
      for (let duplicate = 0; duplicate < 3; duplicate++) {
        const result = await request(peers[index].url, "/pbft/prepare", secondCast.body.record.vote);
        assert.equal(result.status, 200); assert.equal(result.body.voteCount, 2); assert.equal(result.body.prepared, false);
      }
      assert.equal((await states[index].store.readPrepareState(epoch)).voteCount, 2);
    }
    console.log("VALID: two unique matching PREPARE votes remained below quorum; duplicate delivery retained two votes");
    const twoPrepareCommit = await request(peers[primaryIndex].url, "/pbft/commit/cast", { epoch });
    assert.equal(twoPrepareCommit.status, 422); assert.equal(twoPrepareCommit.body.reason, "NOT_PREPARED");

    const thirdVoter = prepareVoters[2];
    const thirdCast = await request(peers[thirdVoter].url, "/pbft/prepare/cast", { epoch });
    assert.equal(thirdCast.status, 200); assert.equal(thirdCast.body.result, "ACCEPTED");
    const preparedAtThree = [];
    for (const state of states) {
      const current = await state.store.readPrepareState(epoch);
      assert.equal(current.voteCount, 3); assert.equal(current.prepared.quorumVoters.length, 3);
      assert.equal(new Set(current.prepared.quorumVoters).size, 3);
      preparedAtThree.push(current.prepared);
    }
    console.log("VALID: the third distinct durable PREPARE vote atomically produced validator-local PREPARED state");

    const fourthVoter = prepareVoters[3];
    async function signedPrepare(fields, signerIndex) {
      const digest = prepareDigest(fields);
      const signature = await validatorAccount(keys[signerIndex]).signMessage({ message: { raw: digest } });
      return { ...fields, prepareDigest: digest, signature };
    }
    const conflictingFields = { messageType: "PREPARE", protocolVersion: "1",
      sourceDomain: proposal.sourceDomain, sourceGateway: proposal.sourceGateway, epoch,
      batchId: proposal.batchId, messageRoot: `0x${"ed".repeat(32)}`,
      proposalDigest: canonical.proposalDigest, voterIdentity: peers[fourthVoter].address };
    const conflictingVote = await signedPrepare(conflictingFields, fourthVoter);
    const wrongRootVote = await request(peers[0].url, "/pbft/prepare", conflictingVote);
    assert.equal(wrongRootVote.status, 422); assert.equal(wrongRootVote.body.reason, "WRONG_ROOT");
    assert.equal((await states[0].store.readPrepareState(epoch)).voteCount, 3);
    assert.deepEqual((await states[0].store.readPrepareState(epoch)).prepared, preparedAtThree[0]);
    const fourthCast = await request(peers[fourthVoter].url, "/pbft/prepare/cast", { epoch });
    assert.equal(fourthCast.status, 200); assert.equal(fourthCast.body.result, "ACCEPTED");
    for (let index = 0; index < 4; index++) {
      const current = await states[index].store.readPrepareState(epoch);
      assert.equal(current.voteCount, 4); assert.deepEqual(current.prepared, preparedAtThree[index]);
      const conflict = await request(peers[index].url, "/pbft/prepare", conflictingVote);
      assert.equal(conflict.status, 422); assert.equal(conflict.body.reason, "CONFLICTING_PREPARE");
      assert.equal((await states[index].store.readPrepareState(epoch)).voteCount, 4);
    }
    console.log("VALID: a conflicting fourth-validator vote was excluded and could not replace four canonical votes or PREPARED state");

    const preparedRestartIndex = prepareVoters[1];
    const preparedBeforeRestart = await states[preparedRestartIndex].store.readPrepareState(epoch);
    const preparedPid = validators[preparedRestartIndex].child.pid;
    await stop(validators[preparedRestartIndex]);
    validators[preparedRestartIndex] = await start(environments[preparedRestartIndex]);
    assert.notEqual(validators[preparedRestartIndex].child.pid, preparedPid);
    const recoveredPrepare = await request(peers[preparedRestartIndex].url, "/pbft/prepares");
    assert.equal(recoveredPrepare.status, 200);
    assert.deepEqual(recoveredPrepare.body.states[0], preparedBeforeRestart);
    const recoveredCast = await request(peers[preparedRestartIndex].url, "/pbft/prepare/cast", { epoch });
    assert.equal(recoveredCast.status, 200);
    assert.deepEqual(recoveredCast.body.record.vote,
      (await states[preparedRestartIndex].store.readPrepareVote(epoch, peers[preparedRestartIndex].address)).vote);
    for (let index = 0; index < 4; index++) {
      const current = await states[index].store.readPrepareState(epoch);
      assert.equal(current.voteCount, 4); assert.ok(current.prepared);
    }
    console.log("VALID: fresh validator process recovered its vote collection and monotonic PREPARED state without double voting");

    await assert.rejects(sourcePool.query(`UPDATE ${tableName(sourceConfig.databaseSchema, "message_batches")}
      SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP WHERE batch_record_id = $1`,
    [snapshot.record.batchRecordId]), /PBFT quorum authorization/);
    console.log("VALID: validator operations preserved source rows, cursor, blocks, membership, roots, and CONSENSUS_PENDING");
    assert.deepEqual(await sourceState(sourcePool, sourceConfig.databaseSchema), originalSourceState);
    console.log("VALID: four local PREPARED states matched the canonical PRE-PREPARE; no COMMIT vote, commit quorum, or QC was created");

    const commitStatement = expectedCommitStatement(proposal, peers);
    const qcOptions = { peers, expected: commitStatement };
    const firstCommitVoter = prepareVoters[0];
    const offlineCommitReceiver = prepareVoters[3];
    await stop(validators[offlineCommitReceiver]);
    const firstCommit = await request(peers[firstCommitVoter].url, "/pbft/commit/cast", { epoch });
    assert.equal(firstCommit.status, 200); assert.equal(firstCommit.body.voteCount, 1);
    assert.equal(firstCommit.body.commitQuorum, false);
    assert.equal(firstCommit.body.deliveries.find((entry) => entry.peerAddress === peers[offlineCommitReceiver].address).delivery, "FAILED");
    const firstCommitVote = firstCommit.body.record.vote;
    await stop(validators[firstCommitVoter]);
    validators[firstCommitVoter] = await start(environments[firstCommitVoter]);
    validators[offlineCommitReceiver] = await start(environments[offlineCommitReceiver]);
    const retryCommit = await request(peers[firstCommitVoter].url, "/pbft/commit/cast", { epoch });
    assert.equal(retryCommit.status, 200); assert.deepEqual(retryCommit.body.record.vote, firstCommitVote);
    assert.ok(retryCommit.body.deliveries.every((entry) => entry.delivery === "DELIVERED" && entry.result === "ACCEPTED"));
    console.log("VALID: durable self COMMIT survived partial broadcast and process restart; retry used the original envelope");

    const secondCommit = await request(peers[prepareVoters[1]].url, "/pbft/commit/cast", { epoch });
    assert.equal(secondCommit.status, 200);
    for (let index = 0; index < 4; index++) {
      const current = await states[index].store.readCommitState(epoch);
      assert.equal(current.voteCount, 2); assert.equal(current.quorum, null); assert.equal(current.certificate, null);
      for (let copy = 0; copy < 3; copy++) {
        const duplicate = await request(peers[index].url, "/pbft/commit", secondCommit.body.record.vote);
        assert.equal(duplicate.status, 200); assert.equal(duplicate.body.voteCount, 2); assert.equal(duplicate.body.commitQuorum, false);
      }
      const noQc = await request(peers[index].url, "/pbft/qc", { epoch });
      assert.equal(noQc.status, 422); assert.equal(noQc.body.reason, "COMMIT_QUORUM_REQUIRED");
    }
    const sourceLifecycle = createBatchLifecycle({ config: sourceConfig, pool: sourcePool, committee: peers });
    assert.equal((await sourceLifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId })).record.status, "CONSENSUS_PENDING");
    assert.equal((await sourcePool.query(`SELECT COUNT(*)::int AS count FROM ${tableName(sourceConfig.databaseSchema, "batch_quorum_certificates")}`)).rows[0].count, 0);
    console.log("VALID: two distinct COMMIT voters and duplicates could not form QC or commit the pending batch");

    const thirdCommit = await request(peers[prepareVoters[2]].url, "/pbft/commit/cast", { epoch });
    assert.equal(thirdCommit.status, 200);
    const commitQuorumsAtThree = [];
    for (const state of states) {
      const current = await state.store.readCommitState(epoch);
      assert.equal(current.voteCount, 3); assert.equal(current.quorum.status, "COMMIT_QUORUM");
      await verifyQuorumCertificate(current.certificate, qcOptions);
      commitQuorumsAtThree.push(current);
    }
    // Exercise the boundary where durable local QC exists before any global submission.
    const qcRestart = prepareVoters[2];
    await stop(validators[qcRestart]); validators[qcRestart] = await start(environments[qcRestart]);
    const recoveredQc = await request(peers[qcRestart].url, "/pbft/qc", { epoch });
    assert.equal(recoveredQc.status, 200);
    assert.deepEqual(recoveredQc.body.certificate, commitQuorumsAtThree[qcRestart].certificate);
    const certificate = recoveredQc.body.certificate;
    const invalidCertificates = [
      { ...certificate, commits: certificate.commits.slice(0, 2) },
      { ...certificate, commits: [certificate.commits[0], certificate.commits[0], certificate.commits[1]] },
      { ...certificate, messageRoot: `0x${"a1".repeat(32)}` },
      { ...certificate, committeeDigest: `0x${"a2".repeat(32)}` },
      { ...certificate, commits: certificate.commits.map((v, i) => i ? v : { ...v, signature: `0x${"ff".repeat(65)}` }) },
    ];
    for (const invalid of invalidCertificates) {
      const rejection = await request(peers[0].url, "/pbft/qc/submit", invalid);
      assert.equal(rejection.status, 422); assert.equal(rejection.body.result, "REJECTED");
      assert.equal((await sourceLifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId })).record.status, "CONSENSUS_PENDING");
    }
    const failingLifecycle = createBatchLifecycle({ config: sourceConfig, pool: sourcePool, committee: peers,
      afterCertificatePersisted: async () => { throw new Error("injected source QC transaction failure"); } });
    await assert.rejects(failingLifecycle.commitWithCertificate({ certificate }), /injected source QC transaction failure/);
    assert.deepEqual(await sourceState(sourcePool, sourceConfig.databaseSchema), originalSourceState);
    console.log("VALID: invalid QC and injected transaction failure preserved pending status and left no certificate rows");

    const submissions = await Promise.all(peers.map((peer) => request(peer.url, "/pbft/qc/submit", certificate)));
    for (const response of submissions) {
      assert.equal(response.status, 200); assert.equal(response.body.status, "COMMITTED");
      assert.equal(response.body.qcDigest, certificate.qcDigest);
    }
    const committed = await sourceLifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId });
    assert.equal(committed.record.status, "COMMITTED");
    assert.deepEqual(committed.batch, snapshot.batch); assert.deepEqual(committed.members, snapshot.members);
    assert.deepEqual(committed.tree, snapshot.tree);
    await verifyQuorumCertificate(committed.quorumCertificate, qcOptions);
    console.log("VALID: concurrent verified QC submissions atomically committed the real A/B/D batch exactly once");

    const fourthCommitVoter = prepareVoters[3];
    const fourthCommit = await request(peers[fourthCommitVoter].url, "/pbft/commit/cast", { epoch });
    assert.equal(fourthCommit.status, 200);
    const wrongCommitFields = { messageType: "COMMIT", ...commitStatement,
      voterIdentity: peers[fourthCommitVoter].address, messageRoot: `0x${"ed".repeat(32)}` };
    const wrongDigest = commitDigest(wrongCommitFields);
    const wrongSignature = await validatorAccount(keys[fourthCommitVoter]).signMessage({ message: { raw: wrongDigest } });
    const wrongCommit = { ...wrongCommitFields, commitDigest: wrongDigest, signature: wrongSignature };
    for (let index = 0; index < 4; index++) {
      const current = await states[index].store.readCommitState(epoch);
      assert.equal(current.voteCount, 4); assert.deepEqual(current.quorum, commitQuorumsAtThree[index].quorum);
      const conflict = await request(peers[index].url, "/pbft/commit", wrongCommit);
      assert.equal(conflict.status, 422); assert.equal(conflict.body.reason, "CONFLICTING_COMMIT");
      const duplicate = await request(peers[index].url, "/pbft/commit", fourthCommit.body.record.vote);
      assert.equal(duplicate.status, 200); assert.equal(duplicate.body.voteCount, 4);
    }
    const allCommits = (await states[0].store.readCommitState(epoch)).votes;
    const equivalent = await buildQuorumCertificate(allCommits.filter((v) => v.voterIdentity !== certificate.commits[0].voterIdentity), qcOptions);
    assert.equal(equivalent.qcDigest, qcDigest(commitStatement));
    assert.equal((await request(peers[1].url, "/pbft/qc/submit", equivalent)).status, 200);
    assert.deepEqual(await sourceLifecycle.readBatch({ batchRecordId: snapshot.record.batchRecordId }), committed);

    const restartCommitted = fourthCommitVoter;
    const beforeCommitRestart = await states[restartCommitted].store.readCommitState(epoch);
    const beforePrepareRestart = await states[restartCommitted].store.readPrepareState(epoch);
    await stop(validators[restartCommitted]); validators[restartCommitted] = await start(environments[restartCommitted]);
    const restoredCommits = await request(peers[restartCommitted].url, "/pbft/commits");
    assert.equal(restoredCommits.status, 200); assert.deepEqual(restoredCommits.body.states[0], beforeCommitRestart);
    const retrySelf = await request(peers[restartCommitted].url, "/pbft/commit/cast", { epoch });
    assert.equal(retrySelf.status, 200); assert.deepEqual(retrySelf.body.record.vote, fourthCommit.body.record.vote);
    const forcedDoubleCommit = await request(peers[restartCommitted].url, "/pbft/commit/cast",
      { epoch, messageRoot: wrongCommit.messageRoot });
    assert.equal(forcedDoubleCommit.status, 400);
    assert.deepEqual(await states[restartCommitted].store.readCommitState(epoch), beforeCommitRestart);
    const conflictAfterRestart = await request(peers[restartCommitted].url, "/pbft/commit", wrongCommit);
    assert.equal(conflictAfterRestart.status, 422); assert.equal(conflictAfterRestart.body.reason, "CONFLICTING_COMMIT");
    assert.equal((await request(peers[restartCommitted].url, "/pbft/qc/submit", certificate)).status, 200);
    assert.deepEqual(await states[restartCommitted].store.readPrePrepares(), acceptedBeforeDuplicates[restartCommitted]);
    assert.deepEqual(await states[restartCommitted].store.readPrepareState(epoch), beforePrepareRestart);

    const sourceAfterCommit = await sourceState(sourcePool, sourceConfig.databaseSchema);
    assert.equal(sourceAfterCommit.batch_quorum_certificates.length, 1);
    assert.equal(sourceAfterCommit.batch_quorum_certificate_signatures.length, 3);
    for (const name of ["source_messages", "indexer_cursors", "indexed_source_blocks", "message_batch_members"]) {
      assert.deepEqual(sourceAfterCommit[name], originalSourceState[name]);
    }
    assert.deepEqual(sourceAfterCommit.message_batches.map((row) => row.batch_record_id === snapshot.record.batchRecordId
      ? { ...row, status: "CONSENSUS_PENDING", committed_at: null } : row), originalSourceState.message_batches);
    console.log("VALID: immutable first QC, fourth vote, equivalent subset, and restarted COMMIT lock preserved source history and next-epoch Message E");
    return { snapshot: committed, committee: peers };
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
