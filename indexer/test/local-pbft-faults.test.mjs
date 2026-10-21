import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { acceptedDelivery,createPipelineDriver,faultSelection } from "../scripts/local/pipeline.mjs";
import { assertConflictResponse,assertOwnedValidator } from "../scripts/local/pbft-faults.mjs";
import { localRpc } from "../scripts/local/ipc.mjs";
import { validatorAccount } from "../../validator/src/identity.mjs";
import { canonicalCommittee,deterministicPrimary } from "../../validator/src/committee.mjs";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { prepareDigest,authenticatePrepare } from "../../validator/src/prepare.mjs";
import { commitDigest,authenticateCommit } from "../../validator/src/commit.mjs";
import { expectedCommitStatement } from "../../validator/src/quorum-certificate.mjs";
import { signAdversarialEvidence } from "../../validator/scripts/lib/adversarial-evidence.mjs";

const keys = [1n,2n,3n,4n].map(value => "0x" + value.toString(16).padStart(64,"0"));
const peers = keys.map((key,index) => ({ address: validatorAccount(key).address.toLowerCase(),url: `http://127.0.0.1:${31001 + index}` }));
const directory = { chainDomain: 10011n,sourceGateway: "0x" + "55".repeat(20),peers,
  validatorSets: createValidatorSetResolver([{ validatorEpoch: "7",activationBatchEpoch: "0",validators: peers.map(peer => peer.address) }]) };

test("fault selection follows the actual epoch and canonical committee, always excluding the primary",() => {
  for (let epoch = 0n; epoch < 12n; epoch++) {
    const selection = faultSelection([...peers].reverse(),String(epoch));
    assert.equal(selection.primary,deterministicPrimary(peers,String(epoch),"0"));
    assert.equal(selection.target,canonicalCommittee(peers).find(address => address !== selection.primary));
    assert.notEqual(selection.primary,selection.target); assert.equal(selection.honest.length,3);
    assert.ok(!selection.honest.includes(selection.target)); assert.ok(selection.honest.includes(selection.primary));
  }
});

test("strict delivery checks tolerate only the explicitly designated crashed peer",() => {
  const deliveries = peers.slice(1).map(peer => ({ peerAddress: peer.address,delivery: "DELIVERED",result: "ACCEPTED" }));
  assert.doesNotThrow(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE"));
  assert.throws(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE",peers[1].address),/unexpectedly answered/);
  deliveries[0] = { peerAddress: peers[1].address,delivery: "FAILED" };
  assert.throws(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE"),/live validator/);
  assert.doesNotThrow(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE",peers[1].address));
  assert.throws(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE",peers[2].address),/live validator/);
  deliveries[1] = { peerAddress: peers[2].address,delivery: "DELIVERED",result: "REJECTED",reason: "WRONG_ROOT" };
  assert.throws(() => acceptedDelivery({ result: "ACCEPTED",deliveries },"PREPARE",peers[1].address),/live validator/);
});

test("pipeline pause acknowledges an in-flight pass before fault stepping and resumes explicitly",async () => {
  let finish; let calls = 0; let sealed = 0; let releases = 0;
  const driver = createPipelineDriver({ runOnce() { calls++; return new Promise(resolve => { finish = resolve; }); },
    async sealTarget() { sealed++; return "sealed"; },step() {},release() { releases++; } });
  await assert.rejects(driver.handlers.sealTarget({}),/acknowledge/);
  const pass = driver.runOnce();
  await assert.rejects(driver.runOnce(),/already running/);
  let acknowledged = false;
  const pause = driver.handlers.pause().then(() => { acknowledged = true; });
  await driver.runOnce(); assert.equal(calls,1);
  await assert.rejects(driver.handlers.sealTarget({}),/acknowledge/);
  assert.equal(acknowledged,false); finish(); await pass; await pause;
  assert.equal(await driver.handlers.sealTarget({}),"sealed"); assert.equal(sealed,1);
  await driver.handlers.resume(); assert.equal(releases,1);
  await assert.rejects(driver.handlers.step({ phase: "commit" }),/acknowledge/);
});

test("IPC matches run ownership and child PID, rejects disconnects, and bounds unanswered requests",async () => {
  const child = new EventEmitter(); child.connected = true; child.pid = 42;
  let request;
  child.send = (value,callback) => { request = value; callback(); };
  const rpc = localRpc(child,"owned-run",{ timeout: 20 });
  const response = rpc("status");
  child.emit("message",{ ...request,runId: "different-run",pid: 42,value: "wrong" });
  child.emit("message",{ ...request,pid: 43,value: "wrong" });
  child.emit("message",{ ...request,pid: 42,value: "owned" });
  assert.equal(await response,"owned");
  const disconnected = rpc("step"); child.connected = false; child.emit("disconnect");
  await assert.rejects(disconnected,/disconnected/); await assert.rejects(rpc("status"),/unavailable/);
  child.connected = true;
  await assert.rejects(rpc("unanswered"),/timed out: unanswered/);
  child.send = () => { throw new Error("IPC send closed"); };
  await assert.rejects(rpc("closed"),/IPC send closed/);
});

test("crash control refuses stale OS identities, manifest/PID mismatches and wrong validator identity",() => {
  const record = { name: "validator-2",pid: 42,identity: "actual OS start and command",log: "/owned/validator.log" };
  const ownership = { record,observedIdentity: record.identity,registered: { ...record },published: { name: record.name,pid: 42 },
    address: peers[1].address,health: { pid: 42,validatorAddress: peers[1].address,ready: true } };
  assert.doesNotThrow(() => assertOwnedValidator(ownership));
  for (const change of [{ observedIdentity: "stale" },{ registered: { ...record,pid: 43 } },
    { published: { name: record.name,pid: 43 } },{ health: { ...ownership.health,validatorAddress: peers[0].address } },
    { health: { ...ownership.health,ready: false } }]) assert.throws(() => assertOwnedValidator({ ...ownership,...change }));
});

test("shared adversarial evidence has a real member signature and exact context, with a deterministic wrong root",async () => {
  const selection = faultSelection(peers,"2");
  const canonical = expectedCommitStatement({ protocolVersion: "3",sourceDomain: "10011",sourceGateway: directory.sourceGateway,
    epoch: "2",view: "0",batchId: "0x" + "ab".repeat(32),messageRoot: "0x" + "cd".repeat(32) },directory);
  const target = { ...canonical,...selection };
  const wrong = expectedCommitStatement({ ...canonical,proposalDigest: undefined,
    messageRoot: `0x${(BigInt(canonical.messageRoot) ^ 1n).toString(16).padStart(64,"0")}` },directory);
  const key = keys[peers.findIndex(peer => peer.address === selection.target)];
  for (const phase of ["PREPARE","COMMIT"]) {
    const vote = await signAdversarialEvidence(key,selection.target,{ messageType: phase,...wrong,voterIdentity: selection.target },
      phase === "PREPARE" ? prepareDigest : commitDigest);
    assert.deepEqual(await (phase === "PREPARE" ? authenticatePrepare : authenticateCommit)(directory,vote),vote);
    const result = { pid: 42,address: selection.target,envelope: vote,deliveries: selection.honest.map(peerAddress =>
      ({ peerAddress,delivery: "DELIVERED",result: "REJECTED",reason: "WRONG_ROOT" })) };
    assert.doesNotThrow(() => assertConflictResponse(result,target,phase,42));
    assert.throws(() => assertConflictResponse({ ...result,pid: 43 },target,phase,42));
    assert.throws(() => assertConflictResponse({ ...result,deliveries: result.deliveries.slice(1) },target,phase,42));
    assert.throws(() => assertConflictResponse({ ...result,deliveries: result.deliveries.map(value => ({ ...value,reason: "INVALID_SIGNATURE" })) },target,phase,42));
  }
});

test("fault controls remain script-local with no production HTTP administration routes",async () => {
  const main = await readFile(new URL("../../validator/src/main.mjs",import.meta.url),"utf8");
  const server = await readFile(new URL("../../validator/src/server.mjs",import.meta.url),"utf8");
  assert.doesNotMatch(main,/local-validator|serveLocalRpc|owned-local-demo/);
  assert.doesNotMatch(server,/byzantine|\/crash|\/arm|\/demo|serveLocalRpc/);
  const wrapper = await readFile(new URL("../../validator/scripts/local-validator.mjs",import.meta.url),"utf8");
  assert.match(wrapper,/await import\("\.\.\/src\/main\.mjs"\)/);
  assert.match(wrapper,/assert\.ok\(armed,"fault injection is unarmed"\)/);
});
