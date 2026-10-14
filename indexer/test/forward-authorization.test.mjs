import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { keccak256,stringToHex } from "viem";
import { FORWARD_AUTHORIZATION_TYPE,CREDENTIAL_PUBLIC_SIGNAL_ORDER,computeForwardIntentDigest,encodeForwardIntent,normalizeForwardIntent,splitForwardIntentDigest } from "../src/forward-authorization.mjs";

const vectors = JSON.parse(await readFile(new URL("../../test-vectors/forward-authorizations.json",import.meta.url),"utf8"));
test("forward authorization matches independently frozen ABI words and public-signal order", () => {
  assert.equal(FORWARD_AUTHORIZATION_TYPE,vectors.type);
  assert.deepEqual(CREDENTIAL_PUBLIC_SIGNAL_ORDER,vectors.publicSignalOrder);
  assert.equal(vectors.abiWords.length,11);
  assert.ok(vectors.abiWords.every(word => /^[0-9a-f]{64}$/.test(word)));
  const expected = keccak256(stringToHex(vectors.type)) + vectors.abiWords.join("");
  assert.equal(encodeForwardIntent(vectors.intent),expected);
  assert.equal(computeForwardIntentDigest(vectors.intent),keccak256(expected));
  assert.equal(computeForwardIntentDigest(Object.fromEntries(Object.entries(vectors.intent).reverse())),keccak256(expected));
});
test("forward intent split preserves leading zeros, high bits and all 256 bits", () => {
  for (const vector of vectors.limbs) {
    const limbs = splitForwardIntentDigest(vector.digest);
    assert.equal(limbs.forwardIntentDigestHi,BigInt(vector.hi));
    assert.equal(limbs.forwardIntentDigestLo,BigInt(vector.lo));
    const reconstructed = (limbs.forwardIntentDigestHi << 128n) | limbs.forwardIntentDigestLo;
    assert.equal(reconstructed,BigInt(vector.digest));
  }
});
test("every intent field is bound without gateway nonce or Number truncation", () => {
  const intent = normalizeForwardIntent(vectors.intent); const baseline = computeForwardIntentDigest(intent);
  for (const [name,value] of Object.entries(intent)) {
    const mutation = typeof value === "bigint" ? value + 1n : name === "payloadHash" ? "0x" + "01".repeat(32) : "0x0000000000000000000000000000000000000123";
    assert.notEqual(computeForwardIntentDigest({ ...intent,[name]: mutation }),baseline,name);
  }
  assert.equal(computeForwardIntentDigest({ ...intent,nonce: 999n }),baseline);
  assert.notEqual(computeForwardIntentDigest({ ...intent,sourceDomain: (1n << 200n) + 1n }),baseline);
  assert.throws(() => encodeForwardIntent({ ...intent,deadline: Number.MAX_SAFE_INTEGER + 1 }),/unsafe/);
  assert.throws(() => normalizeForwardIntent({ ...intent,payload: "0x01" }),/payload hash mismatch/);
});
