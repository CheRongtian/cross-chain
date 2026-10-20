import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeAbiParameters } from "viem";
import { developmentKeys, environment } from "../../validator/test/helpers/fixtures.mjs";
import { loadMessageQueryConfig, publicMessageQueryConfig } from "../src/api/config.mjs";
import { createMessageQuery, projectMessageLifecycle } from "../src/api/message-query.mjs";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { MessageQueryError } from "../src/api/errors.mjs";
import { readSnapshot } from "../src/api/read-snapshot.mjs";
import { deliveryJson } from "../src/delivery/package.mjs";
import { deliveryMessage, fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { queryProjectionFixture, querySourceRow } from "./helpers/message-query-fixtures.mjs";
import { assertMessageQueryPrivacy } from "./helpers/message-query-privacy.mjs";

const json = value => JSON.parse(deliveryJson(value));
const env = overrides => ({ ...environment(), DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused", ...overrides });

test("query configuration is independent of signer/RPC secrets, validates binding, and exposes only public startup metadata", () => {
  const config = loadMessageQueryConfig(env());
  assert.equal(config.listenHost, "127.0.0.1"); assert.equal(config.listenPort, 8080);
  assert.equal(Object.hasOwn(config, "privateKey"), false);
  const publicText = deliveryJson(publicMessageQueryConfig(config));
  assert.ok(!publicText.includes(config.databaseUrl)); assert.ok(!publicText.includes(environment().VALIDATOR_PRIVATE_KEY));
  for (const port of ["0", "65536", "1.5", "oops", "", " 8080"]) assert.throws(() => loadMessageQueryConfig(env({ MESSAGE_QUERY_API_PORT: port })));
  assert.throws(() => loadMessageQueryConfig(env({ MESSAGE_QUERY_API_HOST: "http://localhost" })));
  assert.throws(() => loadMessageQueryConfig(env({ MESSAGE_QUERY_VALIDATOR_STORES: "not-json" })));
});

test("real loopback HTTP validates IDs before reads, normalizes hex and rejects state-changing methods", async () => {
  const calls = []; const id = fixtureHash(123);
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {
    async getMessageLifecycle(messageId) { calls.push(messageId); return { messageId, nonce: (1n << 255n) - 1n }; },
  } });
  await runtime.listen();
  const url = `http://127.0.0.1:${runtime.server.address().port}/api/v1/messages/`;
  try {
    for (const dirty of ["0x1", "123", "hello", `${id}%20`, "0xzz", ""]) assert.equal((await fetch(url + dirty)).status, 400);
    assert.equal(calls.length, 0);
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "HEAD"]) {
      const response = await fetch(url + id, { method }); assert.equal(response.status, 405); assert.equal(response.headers.get("allow"), "GET");
    }
    assert.equal(calls.length, 0);
    const upper = `0x${id.slice(2).toUpperCase()}`;
    const response = await fetch(url + upper); assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { messageId: id, nonce: ((1n << 255n) - 1n).toString() });
    assert.deepEqual(calls, [id]);
  } finally { await runtime.close(); }
});

test("HTTP status and error content are fail-closed without reflecting secrets, raw bytes or stacks", async () => {
  const sentinel = "DO_NOT_EXPOSE_DATABASE_PASSWORD_OR_RAW_SIGNED_TRANSACTION";
  const cases = [new MessageQueryError("MESSAGE_NOT_FOUND", 404), new MessageQueryError("INCONSISTENT_EVIDENCE", 409),
    Object.assign(new Error(sentinel), { code: "ECONNREFUSED" }), new Error(sentinel)];
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {
    async getMessageLifecycle() { throw cases.shift(); },
  } });
  await runtime.listen();
  try {
    for (const status of [404, 409, 503, 500]) {
      const response = await fetch(`http://127.0.0.1:${runtime.server.address().port}/api/v1/messages/${fixtureHash(1)}`);
      assert.equal(response.status, status); const text = await response.text(); assert.ok(!text.includes(sentinel)); assert.ok(!text.includes("stack"));
    }
  } finally { await runtime.close(); }
});

test("early source lifecycles and orphan provenance have no fabricated future sections", () => {
  for (const status of ["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"]) {
    const source = querySourceRow(deliveryMessage(0, { nonce: 1n << 150n }), status);
    const result = json(projectMessageLifecycle({ config: { finalityBlockDepth: 2n }, source, occurrences: [source] }));
    assert.equal(result.finality.status, status); assert.equal(result.message.nonce, (1n << 150n).toString());
    assert.equal(result.sourceTransaction.transactionHash, source.source_tx_hash); assert.equal(result.sourceBlock.blockHash, source.source_block_hash);
    for (const key of ["batch", "merkle", "pbft", "qc", "delivery", "destinationTransaction", "execution"]) assert.equal(result[key], null);
    assert.deepEqual(result.deliveryAttempts, []); assert.deepEqual(result.validatorVotes, []);
  }
});

test("public ABI payloads matching development signing scalars retain their exact source provenance without false leakage failures", () => {
  const privateKeys = developmentKeys(5);
  const grant = encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }, { type: "address" }],
    [1, 1, "0x900000000000000000000000000000000000004a"]);
  assert.ok(grant.startsWith(privateKeys[0]), "the regression must reproduce the public ABI prefix collision");
  for (const payload of [grant, encodeAbiParameters([{ type: "uint8" }], [1])]) {
    const source = querySourceRow(deliveryMessage(0, { payload }));
    const body = json(projectMessageLifecycle({ config: { finalityBlockDepth: 2n }, source, occurrences: [source] }));
    assertMessageQueryPrivacy(body, { source, privateKeys });
    assert.equal(body.message.payload, payload);
  }
});

test("public payload collisions never exempt leaked configuration, signing bytes or modified source evidence", () => {
  const privateKeys = developmentKeys(5);
  const source = querySourceRow(deliveryMessage(0, { payload: encodeAbiParameters([{ type: "uint8" }, { type: "uint8" }], [1, 1]) }));
  const body = json(projectMessageLifecycle({ config: { finalityBlockDepth: 2n }, source, occurrences: [source] }));
  const connection = "postgresql://fixture:QUERY_PASSWORD_SENTINEL@127.0.0.1/unused";
  const raw = "RAW_SIGNED_SECRET_SENTINEL";
  const privacy = { source, privateKeys, connectionStrings: [connection], rawSignedTransactions: [raw] };
  const changes = [
    value => { value.debug = { privateKey: privateKeys[0] }; },
    value => { value.debug = { private_key: privateKeys[0] }; },
    value => { value.debug = { databaseUrl: connection }; },
    value => { value.deliveryAttempts = [{ rawSignedTransaction: raw }]; },
    value => { value.debug = { witness: "PRIVATE_WITNESS_SENTINEL" }; },
    value => { value.debug = { note: `diagnostic ${privateKeys[0]}` }; },
    value => { value.debug = { note: `diagnostic ${connection}` }; },
    value => { value.debug = { note: `diagnostic ${raw}` }; },
    value => { value.message.privateKey = privateKeys[0]; },
    value => { value.message.payload += privateKeys[0].slice(2); },
  ];
  for (const change of changes) {
    const leaked = structuredClone(body); change(leaked);
    assert.throws(() => assertMessageQueryPrivacy(leaked, privacy), { code: "ERR_ASSERTION" });
  }
  assertMessageQueryPrivacy(body, privacy);
});

test("full public lifecycle preserves context, exact integers and original QC versions while excluding internal transaction fields", async () => {
  for (const version of ["1", "2", "3"]) {
    const data = await queryProjectionFixture(version);
    const privateKey = `0x${"fa".repeat(32)}`;
    const connection = "postgresql://fixture:QUERY_PASSWORD_SENTINEL@127.0.0.1/unused";
    for (const value of [data.config, data.source, data.entry.job, data.stored.intent, data.stored.attempt, data.stored.currentReceipt]) {
      Object.assign(value, { privateKey, databaseUrl: connection });
    }
    const result = json(projectMessageLifecycle(data));
    assertMessageQueryPrivacy(result, { source: data.source, privateKeys: [privateKey], connectionStrings: [connection],
      rawSignedTransactions: data.stored.attempts.map(attempt => attempt.rawSignedTransaction) });
    assert.equal(result.authority, "OBSERVATIONAL"); assert.equal(result.apiVersion, "1");
    assert.equal(result.message.messageId, data.source.message_id); assert.equal(result.batch.batchId, data.snapshot.record.batchId);
    assert.equal(result.merkle.root, data.snapshot.record.messageRoot); assert.equal(result.qc.protocolVersion, version);
    assert.equal(result.qc.validatorEpoch, data.snapshot.quorumCertificate.validatorEpoch ?? null);
    assert.equal(result.validatorVotes.length, 3); assert.equal(result.delivery.messageId, result.message.messageId);
    assert.equal(result.execution.status, "CONFIRMED"); assert.equal(result.destinationTransaction.transactionHash, data.stored.winningAttempt.transactionHash);
    assert.equal(result.destinationTransaction.nonce, (1n << 110n).toString()); assert.equal(result.destinationTransaction.blockNumber, (1n << 100n).toString());
    const text = deliveryJson(result);
    assert.ok(!text.includes(data.stored.attempt.rawSignedTransaction));
    for (const field of ["rawSignedTransaction", "privateKey", "databaseUrl", "ownerSessionId", "witness"]) assert.ok(!text.includes(field));
    const before = deliveryJson(data); const again = json(projectMessageLifecycle(data));
    delete again.observedAt; delete result.observedAt; assert.deepEqual(again, result); assert.equal(deliveryJson(data), before);
  }
});

test("same-nonce replacement history can have an older canonical winner; orphan history alone cannot claim current success", async () => {
  const data = await queryProjectionFixture(); const parent = data.stored.attempt;
  const child = { ...parent, attemptId: "2", attemptNumber: 1, replacementOfAttemptId: parent.attemptId,
    transactionHash: fixtureHash(900), status: "REPLACED" };
  data.stored.attempts.push(child); data.stored.attempt = child;
  let result = json(projectMessageLifecycle(data));
  assert.deepEqual(result.deliveryAttempts.map(attempt => attempt.attemptIndex), ["0", "1"]);
  assert.equal(result.deliveryAttempts[1].replacementOfAttemptId, "1");
  assert.equal(result.destinationTransaction.transactionHash, parent.transactionHash);
  assert.equal(result.destinationTransaction.candidateTransactionHash, child.transactionHash);
  data.stored.intent.status = "PENDING"; data.stored.intent.reorgRecovery = { rebroadcastRequired: true };
  data.stored.winningAttempt = null; data.stored.currentReceipt = null; data.stored.receipts[0].orphaned = true;
  result = json(projectMessageLifecycle(data));
  assert.equal(result.execution.status, "REORG_RECOVERY"); assert.equal(result.destinationTransaction.transactionHash, null);
  assert.equal(result.destinationTransaction.blockHash, null); assert.equal(result.execution.receipt, null);
  assert.equal(result.deliveryAttempts[0].receipts[0].orphaned, true);
  data.stored.winningAttempt = parent; data.stored.currentReceipt = { ...data.stored.receipts[0], orphaned: false };
  data.stored.intent.status = "CONFIRMED"; data.config.productionDestinationGateway = null;
  assert.equal(projectMessageLifecycle(data).execution.status, "TRANSPORT_CONFIRMED");
});

test("pending consensus remains pending with no fabricated QC or delivery even when local PREPARE evidence exists", async () => {
  const data = await queryProjectionFixture();
  data.snapshot = { ...data.snapshot, record: { ...data.snapshot.record, status: "CONSENSUS_PENDING" }, quorumCertificate: undefined };
  data.consensus = { pbft: { status: "CONSENSUS_PENDING", view: "0" }, validatorVotes: data.consensus.validatorVotes.map(vote => ({ ...vote, phase: "PREPARE" })) };
  data.entry = null; data.stored = null;
  const before = deliveryJson(data);
  const body = projectMessageLifecycle(data);
  assert.equal(body.pbft.status, "CONSENSUS_PENDING"); assert.equal(body.qc, null); assert.equal(body.delivery, null);
  assert.equal(body.validatorVotes.length, 3); assert.equal(deliveryJson(data), before);
});

test("query read transaction has no row/advisory locks or writes and does not own the injected pool", async () => {
  const statements = []; let releases = 0;
  const pool = { async connect() { return { async query(sql) { statements.push(sql); return { rows: [] }; }, release() { releases++; } }; },
    end() { assert.fail("query must not close shared pools"); } };
  assert.equal(await readSnapshot(pool, async client => { await client.query("SELECT 1"); return 7; }), 7);
  assert.deepEqual(statements, ["BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY", "SELECT 1", "COMMIT"]); assert.equal(releases, 1);
});

test("real query composition performs only scoped SELECTs for early messages; repeated reads cannot change finality, allocate nonce or broadcast", async () => {
  const source = querySourceRow(deliveryMessage(), "FINALIZING"); const original = deliveryJson(source); const sql = [];
  const pool = { async connect() { return { async query(statement, parameters) {
    sql.push(statement);
    assert.ok(!/\b(INSERT|UPDATE|DELETE|FOR SHARE|FOR UPDATE|pg_.*advisory)/i.test(statement));
    if (statement.includes('"source_messages"')) { assert.equal(parameters[0], source.message_id); return { rows: [source] }; }
    return { rows: [] };
  }, release() {} }; } };
  const query = createMessageQuery({ config: { ...loadMessageQueryConfig(env()), sourceGateway: source.source_gateway }, pool });
  for (let count = 0; count < 2; count++) {
    const result = await query.getMessageLifecycle(source.message_id); assert.equal(result.finality.status, "FINALIZING"); assert.equal(result.delivery, null);
  }
  assert.equal(deliveryJson(source), original); assert.ok(sql.length > 0);
  const bad = createMessageQuery({ config: loadMessageQueryConfig(env()), pool: { connect() { assert.fail("malformed ID must fail before database access"); } } });
  await assert.rejects(() => bad.getMessageLifecycle("0x01"), { code: "INVALID_MESSAGE_ID", status: 400 });
  source.payload_hash = fixtureHash(999);
  await assert.rejects(() => query.getMessageLifecycle(source.message_id), { code: "INCONSISTENT_EVIDENCE", status: 409 });
});
