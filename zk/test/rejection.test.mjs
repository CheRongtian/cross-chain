import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { isCircuitAssertion, requireVerificationRejection, requireWitnessRejection } from "../scripts/verify-rejection.mjs";

const constraintError = prefix => new Error(`${prefix}Assert Failed.\nError in template CredentialAuthorization_334 line: 86\n`);
const unused = () => assert.fail("unexpected verification branch");

test("only explicit false credits a proof or witness verification rejection", async () => {
  await requireVerificationRejection(async () => false, "negative fixture");
  for (const result of [true, undefined, null, 0, "false", {}]) {
    await assert.rejects(requireVerificationRejection(async () => result, "negative fixture"), /expected an explicit verification rejection/);
  }
});

test("file, JSON, WASM, memory and verifier exceptions never credit a negative case", async () => {
  const failures = [Object.assign(new Error("missing input"), { code: "ENOENT" }), new SyntaxError("invalid JSON"),
    new WebAssembly.CompileError("invalid WASM"), new Error("Not enough memory.\n"),
    new Error("Signal credentialCommitment not found\n"), new Error("Not all inputs have been set"),
    new Error("Unknown error.\n"), new Error("Expected Assert Failed. but execution stopped elsewhere")];
  for (const failure of failures) {
    await assert.rejects(requireVerificationRejection(async () => { throw failure; }, "negative fixture"), error => error === failure);
    await assert.rejects(requireWitnessRejection({ label: "negative fixture",
      calculateWitness: async () => { throw failure; }, checkWitness: unused, onConstraintRejection: unused }), error => error === failure);
  }
});

test("only a generated circuit assertion with template location is an expected calculation rejection", async () => {
  for (const prefix of ["", "Error: "]) {
    const failure = constraintError(prefix); const reported = [];
    assert.equal(isCircuitAssertion(failure), true);
    assert.equal(await requireWitnessRejection({ label: "wrong role", calculateWitness: async () => { throw failure; },
      checkWitness: unused, onConstraintRejection: error => reported.push(error) }), "CIRCUIT_ASSERTION");
    assert.deepEqual(reported, [failure]);
  }
  for (const message of ["Assert Failed.", "Not enough memory.\nError in template CredentialAuthorization_334 line: 86",
    "File error: Assert Failed.\nError in template CredentialAuthorization_334 line: 86"]) {
    assert.equal(isCircuitAssertion(new Error(message)), false);
  }
});

test("a calculated witness must reach the real check and only its explicit false is accepted", async () => {
  const witness = new Uint8Array([1, 2, 3]); const checked = [];
  assert.equal(await requireWitnessRejection({ label: "invalid witness", calculateWitness: async () => witness,
    checkWitness: async value => { checked.push(value); return false; }, onConstraintRejection: unused }), "INVALID_WITNESS");
  assert.deepEqual(checked, [witness]);
  await assert.rejects(requireWitnessRejection({ label: "valid witness", calculateWitness: async () => witness,
    checkWitness: async () => true, onConstraintRejection: unused }), /expected an explicit verification rejection/);
  const failure = Object.assign(new Error("could not read r1cs or write witness"), { code: "EACCES" });
  await assert.rejects(requireWitnessRejection({ label: "invalid witness", calculateWitness: async () => witness,
    checkWitness: async () => { throw failure; }, onConstraintRejection: unused }), error => error === failure);
  await assert.rejects(requireWitnessRejection({ label: "missing witness", calculateWitness: async () => undefined,
    checkWitness: unused, onConstraintRejection: unused }), /did not return witness bytes/);
});

test("the CLI fails on missing or malformed inputs without printing a rejection pass", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "cross-chain-rejection-"));
  try {
    const malformed = path.join(directory, "malformed.json");
    const missing = path.join(directory, "missing.json");
    await writeFile(malformed, "{invalid-json", "utf8");
    const script = fileURLToPath(new URL("../scripts/verify-rejection.mjs", import.meta.url));
    for (const input of [missing, malformed]) for (const kind of ["proof", "witness"]) {
      const files = kind === "proof" ? [input, input, input] : [missing, input, path.join(directory, "out.wtns"), missing];
      const result = spawnSync(process.execPath, [script, kind, "invalid inputs", ...files], { encoding: "utf8", timeout: 10000 });
      assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
      assert.match(result.stderr, input === missing ? /ENOENT/ : /SyntaxError/);
      assert.doesNotMatch(result.stdout + result.stderr, /EXPECTED FAILURE:|Verified expected/);
    }
    // Even an assertion-looking error from module/WASM initialization belongs
    // to startup, outside the witness constraint-rejection boundary.
    const input = path.join(directory, "input.json");
    const wasm = path.join(directory, "fixture.wasm");
    await writeFile(input, "{}", "utf8");
    await writeFile(wasm, new Uint8Array());
    await writeFile(path.join(directory, "witness_calculator.js"),
      'module.exports = async function () { throw new Error("Assert Failed.\\nError in template CredentialAuthorization_334 line: 86\\n"); };\n', "utf8");
    const result = spawnSync(process.execPath, [script, "witness", "initialization failure", wasm, input,
      path.join(directory, "out.wtns"), missing], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.error, undefined); assert.equal(result.signal, null); assert.equal(result.status, 1);
    assert.match(result.stderr, /Assert Failed\./);
    assert.doesNotMatch(result.stdout + result.stderr, /EXPECTED FAILURE:|Verified expected/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
