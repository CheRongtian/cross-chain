import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { normalizeMessageId, messageIdFromURL, messageURL, buildMessageView, orderedAttempts, protocolIntegerText } from "../public/explorer/view-model.js";
import { createSearchController, fetchMessageView } from "../public/explorer/client.js";
import { renderMessageView } from "../public/explorer/render.js";
import { loadMessageQueryConfig } from "../src/api/config.mjs";
import { projectMessageLifecycle } from "../src/api/message-query.mjs";
import { deliveryJson } from "../src/delivery/package.mjs";
import { environment } from "../../validator/test/helpers/fixtures.mjs";
import { querySourceRow } from "./helpers/message-query-fixtures.mjs";
import { deliveryMessage, fixtureHash } from "./helpers/delivery-fixtures.mjs";
import { explorerFixture, textDocument } from "./helpers/explorer-fixtures.mjs";

const json = value => JSON.parse(deliveryJson(value));
const getSection = (view, id) => view.sections.find(value => value.id === id);
const getField = (value, label) => value.fields.find(entry => entry.label === label)?.value;

test("canonical message URLs, whitespace and duplicate parameters are handled without altering internal characters", () => {
  const id = `0x${"ab".repeat(32)}`;
  assert.equal(normalizeMessageId(`  0x${"AB".repeat(32)} \n`), id);
  assert.equal(messageIdFromURL(`/?messageId=${id}`), id);
  assert.equal(messageIdFromURL("/explorer"), null);
  assert.equal(messageURL("http://localhost/explorer", id), `/explorer?messageId=${id}`);
  for (const value of ["0x01", `${id.slice(0, 10)} ${id.slice(10)}`, "<script>alert(1)</script>"]) assert.throws(() => normalizeMessageId(value));
  assert.throws(() => messageIdFromURL(`/?messageId=${id}&messageId=${id}`));
  assert.throws(() => messageIdFromURL("/?messageId="));
});

test("authorization observation requires the configured production application and exact version/domain/Gateway path", () => {
  const message = deliveryMessage(); const source = querySourceRow(message);
  const config = { identityApplicationAddress: message.sourceSender, chainDomain: message.sourceDomain, sourceGateway: message.sourceGateway, finalityBlockDepth: 2n };
  const observe = (configuration, row = source) => json(projectMessageLifecycle({ config: configuration, source: row, occurrences: [row] })).zkAuthorization;
  assert.equal(observe(config).status, "AUTHORIZED");
  assert.equal(observe(config).transactionHash, source.source_tx_hash);
  for (const configuration of [{ ...config, identityApplicationAddress: null }, { ...config, identityApplicationAddress: message.destinationReceiver },
    { ...config, chainDomain: 123n }, { ...config, sourceGateway: message.destinationGateway }]) assert.equal(observe(configuration).status, "UNAVAILABLE");
  assert.equal(observe(config, querySourceRow(deliveryMessage(0, { version: 1n }))).status, "UNAVAILABLE");
  assert.equal(observe(config, querySourceRow(message, "REORGED")).status, "HISTORICAL_AUTHORIZED");
  const env = { ...environment(), DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused" };
  assert.equal(loadMessageQueryConfig(env).identityApplicationAddress, null);
  assert.equal(loadMessageQueryConfig({ ...env, IDENTITY_APPLICATION_ADDRESS: message.sourceSender }).identityApplicationAddress, message.sourceSender);
  for (const invalid of ["bad", `0x${"0".repeat(40)}`]) assert.throws(() => loadMessageQueryConfig({ ...env, IDENTITY_APPLICATION_ADDRESS: invalid }));
});

test("all Explorer sections preserve legacy QC versions, historical epochs and exactly three actual COMMIT signers", async () => {
  for (const version of ["1", "2", "3"]) {
    const { body } = await explorerFixture(version); const view = buildMessageView(body, body.message.messageId);
    assert.deepEqual(view.sections.map(value => value.id), ["source", "authorization", "finality", "batch", "merkle", "consensus", "votes", "quorum", "delivery", "attempts", "destination", "execution"]);
    assert.equal(getField(getSection(view, "quorum"), "QC version"), version);
    assert.equal(getField(getSection(view, "quorum"), "Validator epoch"), body.qc.validatorEpoch ?? "Not recorded");
    assert.equal(getField(getSection(view, "quorum"), "Required quorum"), "3 / 4 required");
    assert.equal(getSection(view, "votes").records.length, 3);
    assert.equal(getSection(view, "votes").details[0].records.filter(value => value.status === "No own COMMIT observed").length, 1);
    assert.equal(getField(getSection(view, "execution"), "Current result"), "CONFIRMED");
    assert.ok(view.timeline.every(value => value.state === "complete"));
  }
});

test("full-width protocol integers remain exact decimal strings without scientific notation", async () => {
  const maximum = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
  assert.equal(protocolIntegerText(maximum), maximum);
  assert.throws(() => protocolIntegerText(1));
  const { body } = await explorerFixture();
  body.message.nonce = maximum; body.message.deadline = maximum;
  body.sourceBlock.blockNumber = maximum; body.sourceOccurrences[0].blockNumber = maximum;
  body.deliveryAttempts[0].nonce = maximum; body.destinationTransaction.nonce = maximum;
  const view = buildMessageView(body, body.message.messageId);
  assert.equal(getField({ fields: view.summary }, "Nonce"), maximum);
  assert.equal(getField(getSection(view, "source"), "Block number"), maximum);
  assert.equal(getField(getSection(view, "attempts").records[0], "Nonce"), maximum);
  const document = textDocument(); const target = document.createElement("main"); renderMessageView(document, target, view);
  assert.ok(target.textContent.includes(maximum)); assert.ok(!target.textContent.includes("1.1579e+77"));
  console.log("VALID: Explorer preserves API protocol integers as exact decimal strings without Number coercion or scientific notation");
});

test("early and reorged source views never fabricate downstream completion or current authorization", () => {
  for (const status of ["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"]) {
    const message = deliveryMessage(); const source = querySourceRow(message, status);
    const config = { chainDomain: message.sourceDomain, sourceGateway: message.sourceGateway, identityApplicationAddress: message.sourceSender, finalityBlockDepth: 2n };
    const body = json(projectMessageLifecycle({ config, source, occurrences: [source] }));
    const view = buildMessageView(body, message.messageId);
    assert.equal(getSection(view, "finality").status, status);
    assert.equal(getField(getSection(view, "execution"), "Current result"), "NOT_EXECUTED");
    assert.ok(view.timeline.filter(value => ["batch", "consensus", "delivery", "destination", "execution"].includes(value.id)).every(value => value.state !== "complete"));
    if (status === "REORGED") {
      assert.equal(body.zkAuthorization.status, "HISTORICAL_AUTHORIZED");
      assert.ok(view.timeline.slice(3).every(value => value.state === "not-reached"));
    }
  }
});

test("consensus pending and unsigned READY views have no QC or transaction-derived execution claim", async () => {
  const { body } = await explorerFixture();
  body.batch.status = "CONSENSUS_PENDING"; body.pbft.status = "CONSENSUS_PENDING";
  body.qc = null; body.delivery = null; body.deliveryAttempts = []; body.destinationTransaction = null; body.execution = null;
  let view = buildMessageView(body, body.message.messageId);
  assert.equal(getSection(view, "quorum").status, "No quorum certificate yet");
  assert.equal(view.timeline.find(value => value.id === "consensus").state, "current");
  const ready = (await explorerFixture()).body;
  ready.deliveryAttempts = []; ready.destinationTransaction = null; ready.execution = null;
  view = buildMessageView(ready, ready.message.messageId);
  assert.equal(getSection(view, "delivery").status, "READY");
  assert.equal(getField(getSection(view, "execution"), "Current result"), "NOT_EXECUTED");
});

test("ordered replacements preserve an older current winner and distinguish orphan history from reorg recovery", async () => {
  const { body } = await explorerFixture(); const parent = body.deliveryAttempts[0];
  const child = { ...structuredClone(parent), attemptId: "2", attemptIndex: "10", transactionHash: fixtureHash(999), replacementOfAttemptId: parent.attemptId, status: "REPLACED", receipts: [] };
  body.deliveryAttempts = [child, parent]; body.destinationTransaction.candidateTransactionHash = child.transactionHash;
  let view = buildMessageView(body, body.message.messageId);
  const attempts = getSection(view, "attempts").records;
  assert.deepEqual(attempts.map(value => getField(value, "Attempt index")), ["0", "10"]);
  assert.equal(getField(attempts[0], "Canonical winner"), "Yes"); assert.equal(getField(attempts[1], "Canonical winner"), "No");
  assert.equal(getField(attempts[1], "Replaces attempt"), parent.attemptId);
  const orphan = parent.receipts[0]; orphan.orphaned = true;
  body.destinationTransaction = { ...body.destinationTransaction, state: "PENDING", canonicality: "REORG_RECOVERY", transactionHash: null, blockNumber: null, blockHash: null, confirmedHead: null, observedConfirmations: null };
  body.execution = { ...body.execution, status: "REORG_RECOVERY", receipt: null };
  view = buildMessageView(body, body.message.messageId);
  assert.equal(getSection(view, "execution").status, "Recovering after destination reorg");
  assert.equal(getSection(view, "attempts").records[0].details[1].records[0].status, "ORPHANED");
  assert.ok(view.timeline.filter(value => ["destination", "execution"].includes(value.id)).every(value => value.state === "current"));
  assert.throws(() => orderedAttempts([{ ...parent, attemptIndex: 1 }], null));
});

test("reverted, transport-only and malformed relationships fail closed without a false execution success", async () => {
  const { body } = await explorerFixture();
  const reverted = structuredClone(body); reverted.execution.status = "REVERTED"; reverted.execution.receipt.status = 0; reverted.destinationTransaction.state = "REVERTED";
  assert.equal(buildMessageView(reverted, reverted.message.messageId).timeline.at(-1).state, "failed");
  const transport = structuredClone(body); transport.execution.status = "TRANSPORT_CONFIRMED"; transport.execution.gatewayCall = null;
  assert.equal(buildMessageView(transport, transport.message.messageId).timeline.at(-1).state, "current");
  for (const change of [value => { value.message.messageId = fixtureHash(998); }, value => { value.qc.messageRoot = fixtureHash(998); },
    value => { value.destinationTransaction.transactionHash = null; }, value => { value.execution.receipt.orphaned = true; },
    value => { value.zkAuthorization.application = value.message.destinationReceiver; }, value => { value.validatorVotes = {}; },
    value => { value.delivery.messageId = fixtureHash(998); }]) {
    const malformed = structuredClone(body); change(malformed);
    assert.throws(() => buildMessageView(malformed, body.message.messageId));
  }
});

test("renderer inserts hostile public strings only into text nodes and never creates executable markup", async () => {
  const { body } = await explorerFixture();
  const script = "<script>alert(1)</script>"; const image = "<img src=x onerror=alert(1)>";
  body.deliveryAttempts[0].lastErrorClass = image; body.deliveryAttempts[0].status = script;
  const view = buildMessageView(body, body.message.messageId);
  getSection(view, "source").fields.push({ label: "Hostile payload-like text", value: script + image });
  const document = textDocument(); const target = document.createElement("main");
  renderMessageView(document, target, view);
  assert.ok(target.textContent.includes(script)); assert.ok(target.textContent.includes(image));
  const walk = value => { assert.ok(!["script", "img", "iframe"].includes(value.tagName)); value.children.forEach(walk); };
  walk(target);
  const payload = `0x${Buffer.from(script + image, "utf8").toString("hex")}`;
  const source = querySourceRow(deliveryMessage(0, { payload }));
  const publicBody = json(projectMessageLifecycle({ config: { finalityBlockDepth: 2n }, source, occurrences: [source] }));
  renderMessageView(document, target, buildMessageView(publicBody, source.message_id));
  assert.ok(target.textContent.includes(payload)); assert.ok(!target.textContent.includes(script)); walk(target);
  console.log("VALID: Explorer renders API-controlled payload/status/error data as text and never injects it as executable HTML");
});

test("search is GET-only, rejects malformed input before fetch and safely maps HTTP/JSON failures", async () => {
  const { body } = await explorerFixture(); const states = []; const calls = [];
  const controller = createSearchController({ onState: value => states.push(value), fetchImpl: async (path, options) => {
    calls.push({ path, options }); return { ok: true, async json() { return body; } };
  } });
  await controller.search("invalid"); assert.equal(calls.length, 0); assert.equal(states.at(-1).state, "invalid");
  await controller.search(body.message.messageId);
  assert.equal(states.at(-1).state, "ready"); assert.equal(calls[0].options.method, "GET"); assert.equal(calls[0].options.credentials, "omit");
  const sentinel = "DO_NOT_EXPOSE_SERVER_DETAILS";
  for (const status of [400, 404, 409, 503, 500]) {
    const result = await fetchMessageView(body.message.messageId, { fetchImpl: async () => ({ ok: false, status, async json() { assert.fail(sentinel); } }) });
    assert.equal(result.state, "error"); assert.ok(!result.message.includes(sentinel));
  }
  const broken = createSearchController({ onState: value => states.push(value), fetchImpl: async () => { throw new Error(sentinel); } });
  await broken.search(body.message.messageId); assert.equal(states.at(-1).state, "error"); assert.ok(!states.at(-1).message.includes(sentinel));
  const invalidJSON = createSearchController({ onState: value => states.push(value), fetchImpl: async () => ({ ok: true,
    async json() { throw new SyntaxError(sentinel); } }) });
  await invalidJSON.search(body.message.messageId); assert.equal(states.at(-1).state, "error"); assert.ok(!states.at(-1).message.includes(sentinel));
  const inconsistent = await fetchMessageView(fixtureHash(777), { fetchImpl: async () => ({ ok: true, async json() { return body; } }) });
  assert.equal(inconsistent.state, "error"); assert.equal(inconsistent.message, "Explorer received inconsistent lifecycle data.");
});

test("a stale request cannot overwrite a newer message even when fetch ignores AbortController", async () => {
  const first = (await explorerFixture()).body;
  const second = structuredClone(first); second.message.messageId = fixtureHash(888); second.delivery.messageId = second.message.messageId;
  const pending = []; const states = [];
  const controller = createSearchController({ onState: value => states.push(value), fetchImpl: (path, options) => new Promise(resolve => pending.push({ path, options, resolve })) });
  const a = controller.search(first.message.messageId); const b = controller.search(second.message.messageId);
  assert.equal(pending[0].options.signal.aborted, true);
  pending[1].resolve({ ok: true, async json() { return second; } }); await b;
  pending[0].resolve({ ok: true, async json() { return first; } }); await a;
  assert.equal(states.at(-1).messageId, second.message.messageId); assert.equal(states.at(-1).state, "ready");
  assert.equal(states.filter(value => value.state === "ready").length, 1);
  const old = controller.search(first.message.messageId); controller.cancel(); await controller.search("invalid");
  pending[2].resolve({ ok: true, async json() { return first; } }); await old;
  assert.equal(states.at(-1).state, "invalid");
});

test("browser modules are repository-local and protocol worker entry points have no Explorer dependency", async () => {
  for (const file of ["app.js", "client.js", "view-model.js", "render.js", "styles.css", "index.html"]) {
    const source = await readFile(new URL(`../public/explorer/${file}`, import.meta.url), "utf8");
    assert.ok(!/DATABASE_URL|PRIVATE_KEY|postgres(?:ql)?:\/\/|node:|localStorage|sessionStorage|indexedDB|WalletConnect|MetaMask|eth_sendRawTransaction/.test(source));
    assert.ok(!/\.innerHTML\s*=|insertAdjacentHTML|document\.write|\beval\s*\(/.test(source));
    assert.ok(!/\b(?:Number|parseInt|parseFloat)\s*\(/.test(source));
  }
  for (const file of ["indexer/src/indexer.mjs", "indexer/src/finality-watcher.mjs", "indexer/src/batch-lifecycle.mjs",
    "indexer/src/relayer/service.mjs", "indexer/src/transaction-manager/service.mjs", "validator/src/main.mjs"]) {
    const source = await readFile(new URL(`../../${file}`, import.meta.url), "utf8");
    assert.ok(!/public\/explorer|\/api\/v1\/messages|src\/api\//.test(source));
  }
  console.log("VALID: Explorer reads lifecycle data only through the existing observational Message Query API and has no database, validator-store or chain-RPC credentials");
  console.log("VALID: stopping or not loading the Explorer is irrelevant to normal protocol processing; no production worker depends on the frontend");
});
