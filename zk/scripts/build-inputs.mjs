import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ZK_ROOT = path.resolve(SCRIPT_DIR, "..");
const PROJECT_ROOT = path.resolve(ZK_ROOT, "..");
const MODEL_ROOT = path.join(ZK_ROOT, "credential-model");
const FIXTURES_ROOT = path.join(MODEL_ROOT, "fixtures");
const OUTPUT_ROOT = path.join(ZK_ROOT, "build", "inputs");

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function encodeString(value, domain, fieldPrime) {
  requireCondition(typeof value === "string" && value.length > 0, "encoded string must be non-empty");
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");
  return BigInt(`0x${digest}`) % fieldPrime;
}

function encodeCredential(credential, encoding, fieldPrime) {
  const domains = encoding.stringEncoding.domains;
  const role = encoding.roleEncoding.values[credential.role];

  requireCondition(Number.isInteger(role) && role > 0, `unsupported role: ${credential.role}`);
  requireCondition(
    Number.isSafeInteger(credential.expiry) && credential.expiry >= 0,
    `invalid expiry: ${credential.expiry}`,
  );

  return {
    subject: encodeString(credential.subject, domains.subject, fieldPrime),
    issuer: encodeString(credential.issuer, domains.issuer, fieldPrime),
    role: BigInt(role),
    expiry: BigInt(credential.expiry),
    credentialId: encodeString(credential.credentialId, domains.credentialId, fieldPrime),
  };
}

function computeCommitment(poseidon, encoded, preimageVersion) {
  const value = poseidon([
    BigInt(preimageVersion),
    encoded.subject,
    encoded.issuer,
    encoded.role,
    encoded.expiry,
    encoded.credentialId,
  ]);
  return BigInt(poseidon.F.toObject(value));
}

function decimalInput(encoded, commitment, policy) {
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
  };
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

  const poseidon = await buildPoseidon();
  const fixtureCache = new Map();

  async function loadFixture(fileName) {
    if (!fixtureCache.has(fileName)) {
      fixtureCache.set(fileName, await loadJson(path.join(FIXTURES_ROOT, fileName)));
    }
    return fixtureCache.get(fileName);
  }

  await mkdir(OUTPUT_ROOT, { recursive: true });

  for (const proofCase of proofCases.cases) {
    requireCondition(typeof proofCase.name === "string" && proofCase.name.length > 0, "proof case has no name");
    requireCondition(typeof proofCase.fixture === "string", `${proofCase.name} has no fixture`);

    const fixture = await loadFixture(proofCase.fixture);
    const witnessCredential = { ...fixture, ...proofCase.privateOverrides };
    const policyOverrides = proofCase.policyOverrides ?? {};
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
    const commitment = computeCommitment(
      poseidon,
      encodedCommitmentSource,
      encoding.commitment.preimageVersion,
    );
    const output = decimalInput(encodedWitness, commitment, policy);
    const outputPath = path.join(OUTPUT_ROOT, `${proofCase.name}.json`);

    await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    console.log(`Prepared proof input: ${path.relative(PROJECT_ROOT, outputPath)}`);
  }
}

await main();
