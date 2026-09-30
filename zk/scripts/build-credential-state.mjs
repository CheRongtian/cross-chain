import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import {
  buildCredentialState,
  computeCredentialCommitment,
  encodeCredential,
  requireCondition,
} from "./credential-state.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZK_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(ZK_ROOT, "..");
const FIXTURES_ROOT = path.join(ZK_ROOT, "credential-model", "fixtures");
const OUTPUT_ROOT = path.join(ZK_ROOT, "build", "credential-state");

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function serializeState(name, state) {
  return {
    name,
    treeDepth: state.depth,
    capacity: state.capacity,
    root: state.root.toString(),
    activeCredentialCount: state.activeCredentials.length,
    activeCredentials: state.activeCredentials.map((entry) => ({
      fixture: entry.fixture,
      credentialCommitment: entry.credentialCommitment.toString(),
      activeLeaf: entry.activeLeaf.toString(),
      leafIndex: entry.leafIndex,
    })),
    memberships: Object.fromEntries(
      [...state.memberships.entries()].map(([fixture, witness]) => [
        fixture,
        {
          credentialCommitment: witness.credentialCommitment.toString(),
          activeLeaf: witness.activeLeaf.toString(),
          leafIndex: witness.leafIndex,
          statePathElements: witness.statePathElements.map(String),
          statePathIndices: witness.statePathIndices.map(String),
        },
      ]),
    ),
  };
}

async function main() {
  const encoding = await loadJson(path.join(ZK_ROOT, "encoding.json"));
  const stateConfig = await loadJson(path.join(ZK_ROOT, "credential-state.json"));
  const proofCases = await loadJson(path.join(ZK_ROOT, "proof-cases.json"));

  requireCondition(Array.isArray(proofCases.credentialStates), "credentialStates must be an array");

  const poseidon = await buildPoseidon();
  const fixtureCache = new Map();
  const states = new Map();

  async function loadFixture(fileName) {
    if (!fixtureCache.has(fileName)) {
      fixtureCache.set(fileName, await loadJson(path.join(FIXTURES_ROOT, fileName)));
    }
    return fixtureCache.get(fileName);
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });

  for (const definition of proofCases.credentialStates) {
    requireCondition(typeof definition.name === "string" && definition.name.length > 0, "state has no name");
    requireCondition(Array.isArray(definition.fixtures), `${definition.name} fixtures must be an array`);

    const credentialEntries = [];

    for (const fixture of definition.fixtures) {
      credentialEntries.push({ fixture, credential: await loadFixture(fixture) });
    }

    const state = buildCredentialState(poseidon, credentialEntries, encoding, stateConfig);
    const reversedState = buildCredentialState(poseidon, [...credentialEntries].reverse(), encoding, stateConfig);

    requireCondition(state.root !== 0n, `${definition.name} produced a zero credential state root`);
    requireCondition(state.root === reversedState.root, `${definition.name} root depends on fixture insertion order`);

    states.set(definition.name, state);

    const outputPath = path.join(OUTPUT_ROOT, `${definition.name}.json`);
    await writeFile(outputPath, `${JSON.stringify(serializeState(definition.name, state), null, 2)}\n`, "utf8");
    console.log(`Built credential state ${definition.name}: ${state.root}`);
    console.log(`Prepared credential state: ${path.relative(PROJECT_ROOT, outputPath)}`);
  }

  const rootN = states.get("root-n");
  const rootNPlusOne = states.get("root-n-plus-1");
  requireCondition(rootN !== undefined, "root-n credential state is missing");
  requireCondition(rootNPlusOne !== undefined, "root-n-plus-1 credential state is missing");
  requireCondition(rootN.root !== rootNPlusOne.root, "revocation must change the credential state root");
  requireCondition(rootN.memberships.has("valid.json"), "credential A must be active in root-n");
  requireCondition(rootNPlusOne.memberships.has("active-secondary.json"), "credential B must remain active");
  requireCondition(!rootNPlusOne.memberships.has("revoked.json"), "revoked fixture must not have active membership");

  const revokedCredential = await loadFixture("revoked.json");
  const fieldPrime = BigInt(encoding.scalarField.prime);
  const revokedCommitment = computeCredentialCommitment(
    poseidon,
    encodeCredential(revokedCredential, encoding, fieldPrime),
    encoding.commitment.preimageVersion,
  );
  requireCondition(
    rootN.memberships.get("valid.json").credentialCommitment === revokedCommitment,
    "revoked fixture must identify credential A",
  );

  console.log("Verified credential A has no membership witness under root-n-plus-1.");
  console.log("Verified credential B remains active under root-n-plus-1.");
}

await main();
