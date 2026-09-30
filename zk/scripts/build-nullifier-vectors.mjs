import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import {
  computeNullifier,
  requireNullifierCondition,
  resolveActionContext,
} from "./nullifier.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZK_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(ZK_ROOT, "..");
const SOURCE_PATH = path.join(PROJECT_ROOT, "test-vectors", "nullifiers.json");
const OUTPUT_PATH = path.join(ZK_ROOT, "build", "nullifier-vectors.json");

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function main() {
  const encoding = await loadJson(path.join(ZK_ROOT, "encoding.json"));
  const nullifierConfig = await loadJson(path.join(ZK_ROOT, "nullifier.json"));
  const vectors = await loadJson(SOURCE_PATH);
  const fieldPrime = BigInt(encoding.scalarField.prime);
  const poseidon = await buildPoseidon();
  const generatedByName = new Map();

  requireNullifierCondition(Array.isArray(vectors.cases), "nullifier vector cases must be an array");

  const generatedCases = vectors.cases.map((vector) => {
    const context = {
      applicationDomain: BigInt(vector.applicationDomain),
      policyEpoch: BigInt(vector.policyEpoch),
      actionContext: resolveActionContext(vector.actionContext, nullifierConfig),
    };
    const expectedNullifier = computeNullifier(
      poseidon,
      BigInt(vector.credentialIdField),
      context,
      nullifierConfig,
      fieldPrime,
    );
    const generated = {
      name: vector.name,
      nullifierVersion: nullifierConfig.nullifierVersion.toString(),
      credentialIdField: vector.credentialIdField,
      applicationDomain: context.applicationDomain.toString(),
      policyEpoch: context.policyEpoch.toString(),
      actionContext: context.actionContext.toString(),
      expectedNullifier: expectedNullifier.toString(),
    };

    generatedByName.set(vector.name, generated);
    return generated;
  });

  for (const [leftName, rightName] of vectors.expectedRelations.equal) {
    requireNullifierCondition(
      generatedByName.get(leftName).expectedNullifier === generatedByName.get(rightName).expectedNullifier,
      `${leftName} and ${rightName} must produce equal nullifiers`,
    );
  }

  for (const [leftName, rightName] of vectors.expectedRelations.different) {
    requireNullifierCondition(
      generatedByName.get(leftName).expectedNullifier !== generatedByName.get(rightName).expectedNullifier,
      `${leftName} and ${rightName} must produce different nullifiers`,
    );
  }

  await mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(
    OUTPUT_PATH,
    `${JSON.stringify({ vectorVersion: vectors.vectorVersion, cases: generatedCases }, null, 2)}\n`,
    "utf8",
  );
  console.log(`Prepared nullifier vectors: ${path.relative(PROJECT_ROOT, OUTPUT_PATH)}`);
  console.log("Verified deterministic nullifier context separation.");
}

await main();
