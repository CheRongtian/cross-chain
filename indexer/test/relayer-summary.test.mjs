import assert from "node:assert/strict";
import test from "node:test";
import { deliveryJson } from "../src/delivery/package.mjs";
import { formatRelayerSummary } from "../src/relayer/summary.mjs";

const parentHash = `0x${"aa".repeat(32)}`;
const childHash = `0x${"bb".repeat(32)}`;
const deliveryJobId = `10011:0x0000000000000000000000000000000000001001:0x${"cc".repeat(32)}:0`;
const largeNonce = ((1n << 200n) + 17n).toString();
const publicSummary = record => JSON.parse(deliveryJson(formatRelayerSummary(record)));

test("reorg summary exposes recovery without presenting the orphaned receipt as current success or leaking signed data", () => {
  const summary = publicSummary({ intent: { deliveryJobId,status: "PENDING",nonce: largeNonce,
    reorgRecovery: { reorgId: "17",rebroadcastRequired: true } },
  attempt: { transactionHash: parentHash,status: "BROADCAST",attemptNumber: 0,nonce: largeNonce,rawSignedTransaction: "private-signed-bytes" },winningAttempt: null });
  assert.equal(summary.status,"PENDING"); assert.equal(summary.canonicality,"REORG_RECOVERY");
  assert.equal(summary.reorgId,"17"); assert.equal(summary.transactionHash,parentHash);
  assert.equal(JSON.stringify(summary).includes("private-signed-bytes"),false);
});

for (const status of ["CONFIRMED","REVERTED"]) {
  test(`relayer summary reports the historical parent ${status} winner and retains the latest REPLACED child diagnostic`, () => {
    const parent = Object.freeze({ transactionHash: parentHash,status,attemptNumber: 0,nonce: largeNonce });
    const child = Object.freeze({ transactionHash: childHash,status: "REPLACED",attemptNumber: 1,nonce: largeNonce });
    const record = Object.freeze({ intent: Object.freeze({ deliveryJobId,status,nonce: largeNonce }),
      attempt: child,attempts: Object.freeze([parent,child]),winningAttempt: parent,
      workerId: "relayer-a",fencingToken: "9007199254740993",submitted: false });
    const before = structuredClone(record);
    assert.deepEqual(publicSummary(record),{
      deliveryJobId,transactionHash: parentHash,nonce: largeNonce,intentStatus: status,
      latestAttempt: { transactionHash: childHash,status: "REPLACED",attemptNumber: 1 },
      status,workerId: "relayer-a",fencingToken: "9007199254740993",submitted: false,
    });
    assert.deepEqual(record,before,"formatting must not rewrite the winner or losing child");
  });

  test(`relayer summary remains consistent when the latest attempt is the ${status} winner`, () => {
    const latest = Object.freeze({ transactionHash: childHash,status,attemptNumber: 7,nonce: largeNonce });
    assert.deepEqual(publicSummary({ intent: { deliveryJobId,status,nonce: largeNonce },
      attempt: latest,winningAttempt: latest,submitted: false }),{
      deliveryJobId,transactionHash: childHash,nonce: largeNonce,intentStatus: status,
      latestAttempt: { transactionHash: childHash,status,attemptNumber: 7 },status,submitted: false,
    });
  });
}

for (const attemptStatus of ["SIGNED","BROADCAST"]) {
  test(`relayer summary reports PENDING with the latest ${attemptStatus} candidate and does not fabricate a canonical outcome`, () => {
    const latest = { transactionHash: childHash,status: attemptStatus,attemptNumber: 1,nonce: largeNonce };
    const summary = publicSummary({ intent: { deliveryJobId,status: "PENDING",nonce: largeNonce },
      attempt: latest,winningAttempt: null,submitted: attemptStatus === "BROADCAST" });
    assert.deepEqual(summary,{
      deliveryJobId,transactionHash: childHash,nonce: largeNonce,intentStatus: "PENDING",
      latestAttempt: { transactionHash: childHash,status: attemptStatus,attemptNumber: 1 },
      status: "PENDING",submitted: attemptStatus === "BROADCAST",
    });
  });
}

test("relayer summary preserves historical direct submission without inventing an intent or nonce", () => {
  assert.deepEqual(publicSummary({ historicalSubmission: {
    deliveryJobId,transactionHash: parentHash,packageDigest: `0x${"dd".repeat(32)}`,
  },created: false,workerId: "relayer-a",submitted: false }),{
    deliveryJobId,transactionHash: parentHash,status: "HISTORICAL",workerId: "relayer-a",submitted: false,
  });
});

for (const action of ["BUSY","BLOCKED_BY_EARLIER_NONCE"]) {
  test(`relayer summary preserves no-intent ${action} without inventing transaction identity`, () => {
    assert.deepEqual(publicSummary({ deliveryJobId,action,workerId: "relayer-a",submitted: false }),{
      deliveryJobId,status: action,workerId: "relayer-a",submitted: false,
    });
  });
}

test("relayer summary preserves PREPARATION_DEFERRED reason and retry time with no intent, nonce or hash", () => {
  const retryAt = "2026-10-16T10:00:00.000Z";
  assert.deepEqual(publicSummary({ deliveryJobId,action: "PREPARATION_DEFERRED",
    reason: "ESTIMATE_EXECUTION_REVERT",retryAt,workerId: "relayer-a",submitted: false }),{
    deliveryJobId,reason: "ESTIMATE_EXECUTION_REVERT",retryAt,status: "PREPARATION_DEFERRED",
    workerId: "relayer-a",submitted: false,
  });
});

test("relayer summary keeps exact large nonces through the existing BigInt-safe JSON serializer", () => {
  for (const nonce of [largeNonce,BigInt(largeNonce)]) {
    const latest = { transactionHash: parentHash,status: "SIGNED",attemptNumber: 0,nonce };
    const record = { intent: { deliveryJobId,status: "PENDING",nonce },attempt: latest,winningAttempt: null };
    assert.equal(formatRelayerSummary(record).nonce,nonce);
    assert.deepEqual(publicSummary(record),{
      deliveryJobId,transactionHash: parentHash,nonce: largeNonce,intentStatus: "PENDING",
      latestAttempt: { transactionHash: parentHash,status: "SIGNED",attemptNumber: 0 },status: "PENDING",
    });
  }
});

test("relayer summary allowlists fields and excludes raw signed bytes, signer secrets, RPC credentials and internal diagnostics", () => {
  const secrets = ["SECRET_RAW_SENTINEL","SECRET_SIGNATURE_SENTINEL","SECRET_CALLDATA_SENTINEL",
    "SECRET_KEY_SENTINEL","SECRET_RPC_SENTINEL","SECRET_PROVIDER_SENTINEL","SECRET_DB_SENTINEL"];
  const parent = Object.freeze({ transactionHash: parentHash,status: "CONFIRMED",attemptNumber: 0,nonce: largeNonce,
    rawSignedTransaction: secrets[0],signedTransaction: secrets[1],rawBytes: secrets[0],
    providerDiagnostics: secrets[5] });
  const child = Object.freeze({ transactionHash: childHash,status: "REPLACED",attemptNumber: 1,nonce: largeNonce,
    rawSignedTransaction: secrets[0],rawTransaction: secrets[0],requestBody: secrets[2] });
  const record = Object.freeze({ intent: Object.freeze({ deliveryJobId,status: "CONFIRMED",nonce: largeNonce,
    calldata: secrets[2],privateKey: secrets[3] }),attempt: child,attempts: Object.freeze([parent,child]),
    winningAttempt: parent,config: { privateKey: secrets[3],rpcUrl: secrets[4],databaseUrl: secrets[6] },
    error: new Error(secrets[5]),rpcObservations: [{ endpoint: secrets[4],message: secrets[5] }],submitted: false });
  const summary = publicSummary(record);
  assert.deepEqual(summary,{
    deliveryJobId,transactionHash: parentHash,nonce: largeNonce,intentStatus: "CONFIRMED",
    latestAttempt: { transactionHash: childHash,status: "REPLACED",attemptNumber: 1 },status: "CONFIRMED",submitted: false,
  });
  const json = deliveryJson(summary);
  for (const secret of secrets) assert.ok(!json.includes(secret));
});
