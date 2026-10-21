import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertLocalOwnership,ensureLocalExplorerMessage } from "../scripts/local/main.mjs";
import { assertNoPrivateCredential,renderExplorerText } from "../scripts/local/privacy.mjs";
import { ROOT,processIdentity,safeError,spawnLogged,stopRecordedProcess,waitFor } from "../scripts/local/tools.mjs";

const privateCredential = {
  credential: { subject: "private-subject-0123456789abcdef",credentialId: "private-id-9876543210abcdef" },
  encoded: { subject: 123456789012345678901234567890123456789n,credentialId: 987654321098765432109876543210987654321n,expiry: 1893456799n },
};
test("ownership accepts only one exact local/verification run directory",() => {
  const runId = "9c6f2b54-a4b5-496e-a8dc-b3ce16108100";
  const record = { runId,parent: join(ROOT,".run/local"),directory: join(ROOT,".run/local",runId),control: "http://127.0.0.1:12345" };
  assert.equal(assertLocalOwnership(record),record);
  for (const change of [{ directory: ROOT },{ directory: join(ROOT,".run/local/another-run") },{ parent: "/tmp" },{ control: "http://example.com:12345" },{ runId: "../../" }]) {
    assert.throws(() => assertLocalOwnership({ ...record,...change }));
  }
});

function startupFixture() {
  const runId = "9c6f2b54-a4b5-496e-a8dc-b3ce16108100";
  const record = { runId,parent: join(ROOT,".run/local"),directory: join(ROOT,".run/local",runId),control: "http://127.0.0.1:12345" };
  const result = { messageId: "0x" + "12".repeat(32),destinationTransaction: "0x" + "23".repeat(32),
    batchId: "0x" + "34".repeat(32),qcDigest: "0x" + "45".repeat(32),privacy: "PASSED",messageExecuted: true,supplierVerified: true };
  const observed = { execution: { status: "CONFIRMED" },destinationTransaction: { transactionHash: result.destinationTransaction },
    batch: { batchId: result.batchId },qc: { qcDigest: result.qcDigest } };
  return { stack: { record,manifest: { api: "http://127.0.0.1:8080" } },result,observed };
}

test("startup prepares the real happy path once, then reuses its API-confirmed message without another transaction",async () => {
  const { stack,result,observed } = startupFixture();
  let saved; let creations = 0; let reads = 0;
  const hooks = {
    async readResult(path) { assert.equal(path,join(stack.record.directory,"demo-result.json")); return saved; },
    async demonstrate(record,progress,scenario) {
      assert.equal(record,stack.record); assert.equal(typeof progress,"function"); assert.equal(scenario,"happy-path");
      creations++; saved = result; return result;
    },
    async readMessage(url) { assert.equal(url,stack.manifest.api + "/api/v1/messages/" + result.messageId); reads++; return observed; },
  };
  assert.equal(await ensureLocalExplorerMessage(stack,() => {},hooks),result);
  assert.equal(await ensureLocalExplorerMessage(stack,() => {},hooks),result);
  assert.equal(creations,1); assert.equal(reads,2,"repeat startup must consult the live API, not trust a saved success flag");
});

test("startup cannot accept incomplete or conflicting cached message evidence",async () => {
  const { stack,result,observed } = startupFixture();
  let creations = 0;
  const hooks = { readResult: async () => result,demonstrate: async () => { creations++; throw new Error("unexpected duplicate transaction"); } };
  for (const change of [{ execution: { status: "PENDING" } },{ destinationTransaction: { transactionHash: "0x" + "ff".repeat(32) } },
    { batch: { batchId: "0x" + "ff".repeat(32) } },{ qc: { qcDigest: "0x" + "ff".repeat(32) } }]) {
    await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{ ...hooks,readMessage: async () => ({ ...observed,...change }) }));
  }
  for (const change of [{ privacy: "FAILED" },{ messageExecuted: false },{ supplierVerified: false }]) {
    await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{ ...hooks,readResult: async () => ({ ...result,...change }),readMessage: async () => observed }));
  }
  assert.equal(creations,0,"invalid persisted authority must fail startup without silently sending another message");
});

test("startup propagates proof and observation failures and honours cancellation before work",async () => {
  const { stack,result } = startupFixture();
  await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{
    readResult: async () => null,demonstrate: async () => { throw new Error("proof generation failed"); },
    readMessage: async () => { assert.fail("failed proving cannot continue to observation"); },
  }),/proof generation failed/);
  await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{
    readResult: async () => result,readMessage: async () => { throw new Error("observation unavailable"); },
  }),/observation unavailable/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{ signal: controller.signal,
    readResult: async () => { assert.fail("cancelled startup must not read or submit"); },
  }),{ name: "AbortError" });
});

test("startup forwards cancellation to the normal message operation",async () => {
  const { stack } = startupFixture();
  const controller = new AbortController();
  await assert.rejects(ensureLocalExplorerMessage(stack,() => {},{ signal: controller.signal,readResult: async () => null,
    async demonstrate(record,progress,scenario,signal) {
      assert.equal(record,stack.record); assert.equal(scenario,"happy-path"); assert.equal(signal,controller.signal);
      controller.abort(); signal.throwIfAborted();
    },
  }),{ name: "AbortError" });
});
test("privacy accepts public policy and rejects raw and full canonical private encodings",() => {
  assert.doesNotThrow(() => assertNoPrivateCredential({ trustedIssuer: "17",requiredRole: "1",credentialCommitment: "19",
    credentialStateRoot: "23",nullifier: "29",authorizationValidUntil: "1893456000" },privateCredential,"public"));
  for (const value of [privateCredential.credential.subject,privateCredential.credential.credentialId,
    Buffer.from(privateCredential.credential.subject).toString("hex"),...Object.values(privateCredential.encoded).map(value => value.toString(16).padStart(64,"0")),
    privateCredential.encoded.expiry.toString(),'{"statePathElements":[]}','{"raw_signed_transaction":"0x02"}']) {
    assert.throws(() => assertNoPrivateCredential(value,privateCredential,"surface"),/private|internal/);
  }
});
test("actual Explorer renderer uses text sinks for message evidence",() => {
  const view = { messageId: "0x" + "12".repeat(32),status: "CONFIRMED",observedAt: "2026-10-21T00:00:00Z",summary: [],
    timeline: [{ label: "Execution",status: "CONFIRMED",state: "complete" }],
    sections: [{ id: "execution",title: "Execution",status: "CONFIRMED",fields: [{ label: "Receiver",value: "<script>private-looking text</script>" }] }] };
  const text = renderExplorerText(view);
  assert.ok(text.includes(view.messageId)); assert.ok(text.includes("<script>private-looking text</script>"));
});
test("terminal verification errors fail immediately and timeouts retain last observation",async () => {
  let calls = 0;
  await assert.rejects(waitFor("terminal",() => { calls++; throw new Error("wrong canonical receipt"); },{ retryErrors: false }),/wrong canonical receipt/);
  assert.equal(calls,1);
  await assert.rejects(waitFor("bounded readiness",() => { throw new Error("last observed unavailable"); },{ timeout: 5,interval: 1 }),/last observation: last observed unavailable/);
});
test("local diagnostics redact connection material without printing field values",() => {
  const message = safeError(new Error("connection: postgresql://example-user:example-secret@127.0.0.1/example"));
  assert.ok(!message.includes("example-secret")); assert.ok(message.includes("<database>"));
});
test("spawn readiness cannot lose next-tick startup events and cleanup owns only that child",{ timeout: 10000 },async () => {
  const directory = await mkdtemp(join(tmpdir(),"local-process-test-"));
  let child;
  try {
    child = await spawnLogged("owned-child",process.execPath,["-e","setTimeout(() => {}, 5000)"],{ directory,env: process.env });
    assert.ok(child.record.pid > 0); assert.ok(child.record.identity);
    // A stale identity must leave the live child untouched.
    await stopRecordedProcess({ ...child.record,identity: "previous unrelated process" });
    assert.equal(await processIdentity(child.record.pid),child.record.identity);
    await stopRecordedProcess(child.record);
    assert.notEqual(await processIdentity(child.record.pid),child.record.identity);
  } finally {
    if (child) await stopRecordedProcess(child.record);
    await rm(directory,{ recursive: true,force: true });
  }
});
