import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import {
  computeCredentialCommitment,
  encodeCredential,
  encodeString,
  requireCondition,
} from "./credential-state.mjs";
import { computeNullifier, resolveActionContext } from "./nullifier.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZK_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(ZK_ROOT, "..");
const MODEL_ROOT = path.join(ZK_ROOT, "credential-model");
const FIXTURES_ROOT = path.join(MODEL_ROOT, "fixtures");
const OUTPUT_ROOT = path.join(ZK_ROOT, "build", "inputs");
const STATE_OUTPUT_ROOT = path.join(ZK_ROOT, "build", "credential-state");

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function decimalInput(encoded, commitment, policy, credentialState, nullifierContext) {
  return {
    subject: encoded.subject.toString(),
    issuer: encoded.issuer.toString(),
    role: encoded.role.toString(),
    expiry: encoded.expiry.toString(),
    credentialId: encoded.credentialId.toString(),
    credentialCommitment: commitment.toString(),
    trustedIssuer: policy.trustedIssuer.toString(),
    requiredRole: policy.requiredRole.toString(),
    currentTimestamp: policy.currentTimestamp.toString(),
    credentialStateRoot: credentialState.root.toString(),
    applicationDomain: nullifierContext.applicationDomain.toString(),
    policyEpoch: nullifierContext.policyEpoch.toString(),
    actionContext: nullifierContext.actionContext.toString(),
    nullifier: nullifierContext.nullifier.toString(),
    statePathElements: credentialState.pathElements.map(String),
    statePathIndices: credentialState.pathIndices.map(String),
  };
}

function parseFieldElement(value, fieldPrime, label) {
  requireCondition(
    typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value),
    `${label} must be an unsigned decimal integer`,
  );
  const parsed = BigInt(value);
  requireCondition(parsed >= 0n && parsed < fieldPrime, `${label} must fit the BN254 scalar field`);
  return parsed;
}

function incrementField(value, fieldPrime) {
  return (BigInt(value) + 1n) % fieldPrime;
}

function evaluationTime(manifest) {
  const configuredTimestamp = process.env.CREDENTIAL_PROOF_TIMESTAMP;

  if (configuredTimestamp === undefined) {
    return manifest.evaluationTime;
  }

  requireCondition(
    /^(0|[1-9][0-9]*)$/.test(configuredTimestamp),
    "CREDENTIAL_PROOF_TIMESTAMP must be an unsigned decimal integer",
  );

  const parsedTimestamp = Number(configuredTimestamp);
  requireCondition(
    Number.isSafeInteger(parsedTimestamp),
    "CREDENTIAL_PROOF_TIMESTAMP must be a safe integer",
  );

  return parsedTimestamp;
}

async function main() {
  const encoding = await loadJson(path.join(ZK_ROOT, "encoding.json"));
  const stateConfig = await loadJson(path.join(ZK_ROOT, "credential-state.json"));
  const nullifierConfig = await loadJson(path.join(ZK_ROOT, "nullifier.json"));
  const proofCases = await loadJson(path.join(ZK_ROOT, "proof-cases.json"));
  const manifest = await loadJson(path.join(FIXTURES_ROOT, "manifest.json"));
  const issuerDocument = await loadJson(path.join(MODEL_ROOT, "trusted-issuers.json"));
  const fieldPrime = BigInt(encoding.scalarField.prime);
  const trustedIssuers = issuerDocument.issuers.filter((entry) => entry.trusted === true);

  requireCondition(trustedIssuers.length === 1, "proof policy requires exactly one trusted issuer fixture");
  requireCondition(Array.isArray(proofCases.cases), "proof cases must be an array");
  requireCondition(
    Number.isSafeInteger(manifest.evaluationTime) && manifest.evaluationTime >= 0,
    "evaluation time must be a non-negative safe integer",
  );

  const currentTimestamp = evaluationTime(manifest);
  const configuredApplicationDomain =
    process.env.APPLICATION_DOMAIN ?? proofCases.defaultContext.applicationDomain;
  const defaultContext = {
    applicationDomain: parseFieldElement(
      configuredApplicationDomain,
      fieldPrime,
      "APPLICATION_DOMAIN",
    ),
    policyEpoch: parseFieldElement(
      proofCases.defaultContext.policyEpoch,
      fieldPrime,
      "default policyEpoch",
    ),
    actionContext: resolveActionContext(
      proofCases.defaultContext.actionContext,
      nullifierConfig,
    ),
  };

  requireCondition(defaultContext.applicationDomain !== 0n, "applicationDomain must be non-zero");
  requireCondition(defaultContext.policyEpoch !== 0n, "policyEpoch must be non-zero");

  const poseidon = await buildPoseidon();
  const fixtureCache = new Map();
  const stateCache = new Map();
  const generatedNullifiers = new Map();

  async function loadFixture(fileName) {
    if (!fixtureCache.has(fileName)) {
      fixtureCache.set(fileName, await loadJson(path.join(FIXTURES_ROOT, fileName)));
    }
    return fixtureCache.get(fileName);
  }

  async function loadCredentialState(stateName) {
    if (!stateCache.has(stateName)) {
      stateCache.set(stateName, await loadJson(path.join(STATE_OUTPUT_ROOT, `${stateName}.json`)));
    }
    return stateCache.get(stateName);
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });

  for (const proofCase of proofCases.cases) {
    requireCondition(typeof proofCase.name === "string" && proofCase.name.length > 0, "proof case has no name");
    requireCondition(typeof proofCase.fixture === "string", `${proofCase.name} has no fixture`);
    requireCondition(typeof proofCase.credentialState === "string", `${proofCase.name} has no credential state`);
    requireCondition(typeof proofCase.membershipSource === "string", `${proofCase.name} has no membership source`);

    const fixture = await loadFixture(proofCase.fixture);
    const witnessCredential = { ...fixture, ...proofCase.privateOverrides };
    const policyOverrides = proofCase.policyOverrides ?? {};
    const contextOverrides = proofCase.contextOverrides ?? {};
    const trustedIssuer = policyOverrides.trustedIssuer ?? trustedIssuers[0].issuer;
    const requiredRoleName = policyOverrides.requiredRole ?? manifest.requiredRole;
    const requiredRole = encoding.roleEncoding.values[requiredRoleName];

    requireCondition(
      typeof trustedIssuer === "string" && trustedIssuer.length > 0,
      `${proofCase.name} has an invalid trusted issuer policy`,
    );
    requireCondition(
      Number.isInteger(requiredRole) && requiredRole > 0,
      `${proofCase.name} required role has no field encoding`,
    );

    const policy = {
      trustedIssuer: encodeString(
        trustedIssuer,
        encoding.stringEncoding.domains.issuer,
        fieldPrime,
      ),
      requiredRole: BigInt(requiredRole),
      currentTimestamp: BigInt(currentTimestamp),
    };
    const commitmentFixture =
      proofCase.commitmentSource === "self"
        ? fixture
        : await loadFixture(proofCase.commitmentSource);
    const encodedWitness = encodeCredential(witnessCredential, encoding, fieldPrime);
    const encodedCommitmentSource = encodeCredential(commitmentFixture, encoding, fieldPrime);
    const commitment = computeCredentialCommitment(
      poseidon,
      encodedCommitmentSource,
      encoding.commitment.preimageVersion,
    );
    const state = await loadCredentialState(proofCase.credentialState);
    const membership = state.memberships[proofCase.membershipSource];

    requireCondition(membership !== undefined, `${proofCase.name} membership witness is unavailable`);
    requireCondition(state.treeDepth === stateConfig.treeDepth, `${proofCase.name} state depth is inconsistent`);
    requireCondition(
      membership.statePathElements.length === stateConfig.treeDepth,
      `${proofCase.name} path element count is inconsistent`,
    );
    requireCondition(
      membership.statePathIndices.length === stateConfig.treeDepth,
      `${proofCase.name} path index count is inconsistent`,
    );

    if (proofCase.expected === "proof-verifies") {
      requireCondition(
        BigInt(membership.credentialCommitment) === commitment,
        `${proofCase.name} valid proof does not use its own membership witness`,
      );
    }

    const credentialState = {
      root: BigInt(state.root),
      pathElements: membership.statePathElements.map(BigInt),
      pathIndices: membership.statePathIndices.map(BigInt),
    };

    if (proofCase.stateWitnessMutation === "increment-first-path-element") {
      credentialState.pathElements[0] = incrementField(credentialState.pathElements[0], fieldPrime);
    }
    if (proofCase.stateRootMutation === "increment") {
      credentialState.root = incrementField(credentialState.root, fieldPrime);
    }

    const nullifierContext = {
      applicationDomain: defaultContext.applicationDomain,
      policyEpoch:
        contextOverrides.policyEpoch === undefined
          ? defaultContext.policyEpoch
          : parseFieldElement(contextOverrides.policyEpoch, fieldPrime, `${proofCase.name} policyEpoch`),
      actionContext:
        contextOverrides.actionContext === undefined
          ? defaultContext.actionContext
          : resolveActionContext(contextOverrides.actionContext, nullifierConfig),
    };

    if (contextOverrides.applicationDomainMutation === "increment") {
      nullifierContext.applicationDomain = incrementField(
        nullifierContext.applicationDomain,
        fieldPrime,
      );
    }

    requireCondition(nullifierContext.applicationDomain !== 0n, `${proofCase.name} applicationDomain is zero`);
    requireCondition(nullifierContext.policyEpoch !== 0n, `${proofCase.name} policyEpoch is zero`);

    let nullifier = computeNullifier(
      poseidon,
      encodedWitness.credentialId,
      nullifierContext,
      nullifierConfig,
      fieldPrime,
    );

    if (proofCase.nullifierMutation === "increment") {
      nullifier = incrementField(nullifier, fieldPrime);
    }

    const outputContext = { ...nullifierContext, nullifier };

    const output = decimalInput(encodedWitness, commitment, policy, credentialState, outputContext);
    const outputPath = path.join(OUTPUT_ROOT, `${proofCase.name}.json`);

    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    generatedNullifiers.set(proofCase.name, nullifier);
    console.log(`Prepared proof input: ${path.relative(PROJECT_ROOT, outputPath)}`);
  }

  requireCondition(
    generatedNullifiers.get("valid") === generatedNullifiers.get("valid-replay"),
    "same credential and context must produce the same nullifier",
  );
  requireCondition(
    generatedNullifiers.get("valid") !== generatedNullifiers.get("application-next-epoch"),
    "different policy epochs must produce different nullifiers",
  );
  requireCondition(
    generatedNullifiers.get("valid") !== generatedNullifiers.get("application-alternate-domain"),
    "different application domains must produce different nullifiers",
  );
  requireCondition(
    generatedNullifiers.get("valid") !== generatedNullifiers.get("application-other-action"),
    "different action contexts must produce different nullifiers",
  );
  console.log("Verified proof-input nullifier determinism and context separation.");
}

await main();
