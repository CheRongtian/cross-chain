import { mkdtemp,readFile,rm,writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { buildPoseidon } from "circomlibjs";
import { groth16 } from "snarkjs";
import { computeCredentialCommitment,encodeCredential,requireCondition } from "./credential-state.mjs";
import { computeNullifier } from "./nullifier.mjs";
import { decimalInput } from "./build-inputs.mjs";
import { CREDENTIAL_PUBLIC_SIGNAL_ORDER,computeForwardIntentDigest,normalizeForwardIntent,splitForwardIntentDigest } from "../../indexer/src/forward-authorization.mjs";

const json = async relative => JSON.parse(await readFile(new URL(relative,import.meta.url),"utf8"));
const format = value => Array.isArray(value) ? "[" + value.map(format).join(",") + "]" : value;
const execFileAsync = promisify(execFile);
const cli = fileURLToPath(new URL("../node_modules/snarkjs/build/cli.cjs",import.meta.url));

// Reuse the compiled circuit and one existing development zkey. This prepares
// one proof per real, distinct intent and never starts another setup ceremony.
export async function generateCredentialProof({ intent,applicationDomain,policyEpoch,currentTimestamp,credentialStateRoot,trustedIssuer,requiredRole }) {
  const [encoding,config,fixture,state] = await Promise.all([
    json("../encoding.json"),json("../nullifier.json"),json("../credential-model/fixtures/active-secondary.json"),
    json("../build/credential-state/root-n-plus-1.json"),
  ]);
  const field = BigInt(encoding.scalarField.prime);
  const poseidon = await buildPoseidon();
  const encoded = encodeCredential(fixture,encoding,field);
  const commitment = computeCredentialCommitment(poseidon,encoded,encoding.commitment.preimageVersion);
  const membership = state.memberships["active-secondary.json"];
  requireCondition(BigInt(state.root) === BigInt(credentialStateRoot),"forwarding fixture must match the application's current credential root");
  requireCondition(BigInt(membership.credentialCommitment) === commitment,"forwarding requires the credential's actual membership witness");
  const normalized = intent === undefined ? undefined : normalizeForwardIntent(intent);
  if (normalized) requireCondition(normalized.action === BigInt(config.actionContexts.FORWARD_MESSAGE),"forwarding requires its dedicated action");
  const digest = normalized ? computeForwardIntentDigest(normalized) : null;
  const context = { applicationDomain: BigInt(applicationDomain),policyEpoch: BigInt(policyEpoch),
    actionContext: normalized?.action ?? BigInt(config.actionContexts.VERIFY_SUPPLIER),
    ...(digest ? splitForwardIntentDigest(digest) : { forwardIntentDigestHi: 0n,forwardIntentDigestLo: 0n }) };
  context.nullifier = computeNullifier(poseidon,encoded.credentialId,context,config,field);
  const input = decimalInput(encoded,commitment,{ trustedIssuer: BigInt(trustedIssuer),requiredRole: BigInt(requiredRole),
    currentTimestamp: BigInt(currentTimestamp) },{ root: BigInt(state.root),pathElements: membership.statePathElements.map(BigInt),
    pathIndices: membership.statePathIndices.map(BigInt) },context);
  // The existing CLI owns and exits its proving worker pool. Keeping fullProve
  // and verify inside the integration process would leave cached curve workers.
  const temporary = await mkdtemp(fileURLToPath(new URL("../build/proving/forwarding-",import.meta.url)));
  let proof; let publicSignals; let failure;
  try {
    const inputPath = temporary + "/input.json"; const proofPath = temporary + "/proof.json"; const publicPath = temporary + "/public.json";
    await writeFile(inputPath,JSON.stringify(input),"utf8");
    const run = async args => {
      try {
        const result = await execFileAsync(process.execPath,[cli,...args],{ timeout: 120000,maxBuffer: 8 * 1024 * 1024 });
        process.stdout.write(result.stdout); process.stderr.write(result.stderr);
        return result;
      }
      catch (error) { process.stdout.write(error.stdout ?? ""); process.stderr.write(error.stderr ?? ""); throw error; }
    };
    await run(["groth16","fullprove",inputPath,
      fileURLToPath(new URL("../build/circuit/CredentialAuthorization_js/CredentialAuthorization.wasm",import.meta.url)),
      fileURLToPath(new URL("../build/proving/CredentialAuthorization_final.zkey",import.meta.url)),proofPath,publicPath]);
    await run(["groth16","verify",fileURLToPath(new URL("../build/proving/verification_key.json",import.meta.url)),publicPath,proofPath]);
    proof = JSON.parse(await readFile(proofPath,"utf8")); publicSignals = JSON.parse(await readFile(publicPath,"utf8"));
  } catch (error) { failure = error; throw error; }
  finally {
    try { await rm(temporary,{ recursive: true,force: true }); }
    catch (error) { if (!failure) throw error; console.error("Temporary forwarding proof cleanup failed: " + error.message); }
  }
  requireCondition(publicSignals.length === CREDENTIAL_PUBLIC_SIGNAL_ORDER.length,"forwarding public-signal count mismatch");
  for (const [index,name] of CREDENTIAL_PUBLIC_SIGNAL_ORDER.entries()) {
    requireCondition(BigInt(publicSignals[index]) === BigInt(input[name]),"forwarding public-signal order mismatch: " + name);
  }
  const [proofA,proofB,proofC,signals] = JSON.parse("[" + await groth16.exportSolidityCallData(proof,publicSignals) + "]");
  return {
    intentDigest: digest,publicSignals: publicSignals.map(String),
    proofA,proofB,proofC,
    publicInputs: Object.fromEntries(CREDENTIAL_PUBLIC_SIGNAL_ORDER.map((name,index) => [name,publicSignals[index].toString()])),
    calldataLines: [format(proofA),format(proofB),format(proofC),...signals.map(value => BigInt(value).toString())],
  };
}
