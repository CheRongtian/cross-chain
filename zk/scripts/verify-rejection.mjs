import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A verifier's explicit false result is distinct from an exception, process
// failure or malformed return value. Never turn those failures into a pass.
export async function requireVerificationRejection(verify, label) {
  if (await verify() !== false) throw new Error(`${label}: expected an explicit verification rejection`);
}

export function isCircuitAssertion(error) {
  if (!(error instanceof Error)) return false;
  const lines = error.message.split(/\r?\n/);
  // Circom 2.2.3's generated calculator wraps its assertion error once. Its
  // memory/input/module errors have different messages and must propagate.
  return /^(?:Error: )?Assert Failed\.$/.test(lines[0]) &&
    lines.slice(1).some(line => /^Error in template [A-Za-z0-9_]+ line: [0-9]+$/.test(line));
}

export async function requireWitnessRejection({ calculateWitness, checkWitness, label, onConstraintRejection }) {
  let witness;
  try {
    witness = await calculateWitness();
  } catch (error) {
    if (!isCircuitAssertion(error)) throw error;
    onConstraintRejection(error);
    return "CIRCUIT_ASSERTION";
  }
  if (!(witness instanceof Uint8Array)) throw new Error(`${label}: witness calculation did not return witness bytes`);
  await requireVerificationRejection(() => checkWitness(witness), label);
  return "INVALID_WITNESS";
}

const json = async filename => JSON.parse(await readFile(filename, "utf8"));
const logger = { info: console.log, warn: console.warn, error: console.error, debug: console.debug };

async function main([kind, label, ...files]) {
  if (!label || !((kind === "witness" && files.length === 4) || (kind === "proof" && files.length === 3))) {
    throw new Error("usage: verify-rejection.mjs witness <label> <wasm> <input> <witness> <r1cs> | proof <label> <verification-key> <public> <proof>");
  }
  if (kind === "witness") {
    const [wasmFile, inputFile, witnessFile, r1csFile] = files;
    // Reading/parsing inputs and loading/initializing WASM happen outside the
    // circuit-assertion catch. Their failures can never credit a negative case.
    const input = await json(inputFile);
    const wasm = await readFile(wasmFile);
    const builder = createRequire(import.meta.url)(path.resolve(path.dirname(wasmFile), "witness_calculator.js"));
    const calculator = await builder(wasm);
    const reason = await requireWitnessRejection({ label,
      calculateWitness: () => calculator.calculateWTNSBin(input, 0),
      checkWitness: async witness => {
        await writeFile(witnessFile, witness);
        const { wtns } = await import("snarkjs");
        return wtns.check(r1csFile, witnessFile, logger);
      },
      onConstraintRejection: error => console.error(`Expected circuit constraint rejection:\n${error.stack}`),
    });
    console.log(`EXPECTED FAILURE: ${label} (${reason})`);
  } else {
    const [verificationKey, publicSignals, proof] = await Promise.all(files.map(json));
    const { groth16 } = await import("snarkjs");
    await requireVerificationRejection(() => groth16.verify(verificationKey, publicSignals, proof, logger), label);
    console.log(`EXPECTED FAILURE: ${label} (PROOF_VERIFICATION_FALSE)`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let exitCode = 0;
  try { await main(process.argv.slice(2)); }
  catch (error) { console.error(error); exitCode = 1; }
  // This short-lived CLI owns snarkjs's cached curve workers, just as the
  // existing snarkjs CLI does. Flush diagnostics before terminating the pool.
  await new Promise(resolve => process.stdout.write("", resolve));
  await new Promise(resolve => process.stderr.write("", resolve));
  process.exit(exitCode);
}
