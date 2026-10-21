import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { groth16, wtns } from "snarkjs";
import { buildPoseidon } from "circomlibjs";
import { encodeCredential } from "./credential-state.mjs";
import { computeNullifier } from "./nullifier.mjs";
import { CREDENTIAL_PUBLIC_SIGNAL_ORDER } from "../../indexer/src/forward-authorization.mjs";
import { requireVerificationRejection } from "./verify-rejection.mjs";

const json = async relative => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const proving = relative => new URL(`../build/proving/${relative}`, import.meta.url);
const logger = { info: console.log, warn: console.warn, error: console.error, debug: console.debug };

// Run by the existing circuit verification script after its real witness/proof
// generation and strict negative-witness checks. No setup or alternate encoder.
async function main() {
  const [definition, encoding, key] = await Promise.all([
    json("../proof-cases.json"), json("../encoding.json"), json("../build/proving/verification_key.json"),
  ]);
  const scalarField = BigInt(encoding.scalarField.prime);
  const frozen = await json("../../test-vectors/forward-authorizations.json");
  assert.deepEqual(CREDENTIAL_PUBLIC_SIGNAL_ORDER, [...frozen.publicSignalOrder, "authorizationValidUntil"]);
  assert.equal(key.nPublic, 12);
  assert.equal(key.IC.length, 13);
  for (const privateName of ["subject", "issuer", "role", "expiry", "credentialId", "statePathElements", "statePathIndices"]) {
    assert.equal(CREDENTIAL_PUBLIC_SIGNAL_ORDER.includes(privateName), false);
  }
  const cases = new Map();
  for (const entry of definition.cases.filter(value => value.expected === "proof-verifies")) {
    const stem = entry.name === "valid" ? "" : `${entry.name}-`;
    const [input, proof, signals] = await Promise.all([
      json(`../build/inputs/${entry.name}.json`),
      json(`../build/proving/${stem}proof.json`),
      json(`../build/proving/${stem}public.json`),
    ]);
    assert.equal(signals.length, 12);
    for (const [index, name] of CREDENTIAL_PUBLIC_SIGNAL_ORDER.entries()) {
      assert.equal(BigInt(signals[index]), BigInt(input[name]), `${entry.name}: positional signal ${name}`);
    }
    assert.equal(await groth16.verify(key, signals, proof, logger), true, `${entry.name}: genuine valid proof`);
    assert.ok(BigInt(input.currentTimestamp) < BigInt(input.authorizationValidUntil));
    assert.ok(BigInt(input.authorizationValidUntil) <= BigInt(input.expiry));
    cases.set(entry.name, { input, proof, signals });
  }
  assert.equal(await wtns.check(new URL("../build/circuit/CredentialAuthorization.r1cs", import.meta.url).pathname,
    proving("valid.wtns").pathname, logger), true, "valid witness satisfies the actual circuit");
  const valid = cases.get("valid");
  const saved = structuredClone(valid);
  for (const [index, name] of CREDENTIAL_PUBLIC_SIGNAL_ORDER.entries()) {
    const mutated = [...valid.signals];
    mutated[index] = ((BigInt(mutated[index]) + 1n) % scalarField).toString();
    assert.notEqual(BigInt(mutated[index]), BigInt(valid.signals[index]));
    for (let other = 0; other < mutated.length; other++) {
      if (other !== index) assert.equal(mutated[other], valid.signals[other]);
    }
    await requireVerificationRejection(() => groth16.verify(key, mutated, valid.proof, logger), name);
    console.log(`EXPECTED FAILURE: modified public input ${name} (INVALID_PROOF)`);
  }
  const secondary = cases.get("active-secondary-initial");
  assert.notEqual(secondary.signals[0], valid.signals[0], "independent legitimate credential B");
  const impersonation = [...valid.signals];
  impersonation[0] = secondary.signals[0];
  await requireVerificationRejection(() => groth16.verify(key, impersonation, valid.proof, logger), "A proof with B commitment");
  console.log("EXPECTED FAILURE: wrong credential A proof cannot claim valid credential B (INVALID_PROOF)");
  assert.deepEqual(cases.get("valid-replay").signals, valid.signals, "regenerated proof preserves the complete statement");
  for (const name of ["application-next-epoch", "application-alternate-domain", "application-other-action", "authorized-forward-valid"]) {
    assert.notEqual(cases.get(name).signals[8], valid.signals[8], `${name}: context-bound nullifier isolation`);
  }
  assert.notEqual(cases.get("application-alternate-issuer").signals[1], valid.signals[1]);
  assert.notEqual(cases.get("application-auditor-role").signals[2], valid.signals[2]);
  assert.equal(cases.get("application-auditor-role").signals[1], valid.signals[1]);
  const lastSecond = cases.get("expiry-last-second");
  assert.equal(BigInt(lastSecond.input.currentTimestamp), BigInt(lastSecond.input.expiry) - 1n);
  assert.equal(lastSecond.input.authorizationValidUntil, lastSecond.input.expiry);
  const narrow = cases.get("authorization-narrow");
  assert.equal(BigInt(narrow.input.authorizationValidUntil), BigInt(narrow.input.currentTimestamp) + 1n);
  const renewed = cases.get("authorization-renewed");
  for (const name of CREDENTIAL_PUBLIC_SIGNAL_ORDER) {
    if (name === "authorizationValidUntil") assert.notEqual(renewed.input[name], valid.input[name]);
    else assert.equal(renewed.input[name], valid.input[name], `changing only the authorization deadline preserves ${name}`);
  }
  const equal = await json("../build/inputs/expiry-equal.json");
  const after = await json("../build/inputs/expiry-after.json");
  assert.equal(BigInt(equal.currentTimestamp), BigInt(equal.expiry));
  assert.equal(BigInt(after.currentTimestamp), BigInt(after.expiry) + 1n);
  const legacy = await json("../../test-vectors/legacy-credential-proof.json");
  assert.equal(legacy.publicSignals.length, 11);
  assert.equal(legacy.verificationKey.nPublic, 11);
  assert.equal(await groth16.verify(legacy.verificationKey, legacy.publicSignals, legacy.proof, logger), true,
    "historical proof must first verify against its actual historical key");
  const legacyStatement = [...legacy.publicSignals, (BigInt(legacy.publicSignals[3]) + 7200n).toString()];
  await requireVerificationRejection(() => groth16.verify(key, legacyStatement, legacy.proof, logger), "historical proof with a well-formed twelve-signal statement");
  assert.equal(valid.signals[0], legacy.publicSignals[0], "credential commitment stays identical to the fixed historical fixture");
  assert.equal(valid.signals[4], legacy.publicSignals[4], "credential state root format stays unchanged");
  const fixture = await json("../credential-model/fixtures/valid.json");
  const nullifierConfig = await json("../nullifier.json");
  const encoded = encodeCredential(fixture, encoding, scalarField);
  const historicalContext = Object.fromEntries(frozen.publicSignalOrder.map((name, index) => [name, BigInt(legacy.publicSignals[index])]));
  assert.equal(computeNullifier(await buildPoseidon(), encoded.credentialId, historicalContext, nullifierConfig, scalarField).toString(),
    legacy.publicSignals[8], "the production nullifier formula reproduces the fixed pre-upgrade value");
  assert.deepEqual(valid, saved, "negative probes do not rewrite the original proof or signals");
  assert.equal(await groth16.verify(key, valid.signals, valid.proof, logger), true);
  console.log("VALID: valid credential proof succeeds (real witness and off-chain Groth16)");
  console.log("VALID: alternate issuer/role, independent B and regenerated same-context proofs are cryptographically valid");
  console.log("VALID: credential authorization statement exposes 12 public signals with authorizationValidUntil appended while credential expiry remains private");
  console.log("VALID: original eleven public-signal meanings and canonical indices are unchanged");
  console.log("VALID: circuit proves currentTimestamp < authorizationValidUntil <= private credential expiry, including a one-second authorization window");
  console.log("VALID: authorizationValidUntil may equal private credential expiry without adding a private-expiry public signal");
  console.log("VALID: credential commitment, state-root format and nullifier derivation reproduce fixed historical values");
  console.log("EXPECTED FAILURE: legacy 11-signal proof is not accepted by the upgraded verifier under a well-formed 12-signal statement");
  console.log("VALID: expiry - 1 proof is valid; equality/after-expiry witnesses were rejected by the circuit group");
  console.log("ZK CIRCUIT AND CRYPTOGRAPHIC INVARIANTS PASSED; application and execution-time expiry checks remain required");
}

let exitCode = 0;
try { await main(); }
catch (error) { console.error(error); exitCode = 1; }
// This CLI owns the cached snarkjs curve workers; preserve diagnostics and end
// them exactly as the existing verification-rejection CLI does.
await new Promise(resolve => process.stdout.write("", resolve));
await new Promise(resolve => process.stderr.write("", resolve));
process.exit(exitCode);
