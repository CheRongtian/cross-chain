import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeCertificate, snapshotContext, solidityContext } from "./pbft-certificate.mjs";

export async function createCertificateChecks({ client, address, registryAddress }) {
  const verifierArtifact = JSON.parse(readFileSync(
    new URL("../../../contracts/out/PBFTCertificateVerifier.sol/PBFTCertificateVerifier.json", import.meta.url), "utf8"));
  const registryArtifact = JSON.parse(readFileSync(
    new URL("../../../contracts/out/ValidatorSetRegistry.sol/ValidatorSetRegistry.json", import.meta.url), "utf8"));
  // Include external registry errors so unknown authority cannot be confused with a transport failure.
  const abi = [...verifierArtifact.abi, ...registryArtifact.abi.filter((item) => item.type === "error")];
  const boundRegistry = await client.readContract({ address, abi, functionName: "validatorSetRegistry" });
  assert.equal(boundRegistry.toLowerCase(), registryAddress.toLowerCase(), "QC verifier registry dependency drift");
  const read = (encoded, expected) => client.readContract({ address, abi, functionName: "verifyCertificate",
    args: [encoded, solidityContext(expected)] });

  async function accept(encoded, expected, label) {
    assert.equal(await read(encoded, expected), true, label);
    console.log(`VALID: Chain B PBFT certificate verification / ${label}`);
  }
  async function reject(encoded, expected, errorName, label) {
    await assert.rejects(() => read(encoded, expected), (error) => {
      // A transport/timeout error must fail verification; only the precise contract revert is expected.
      for (let cause = error; cause; cause = cause.cause) {
        if (cause.data?.errorName === errorName) return true;
      }
      return false;
    }, label);
    console.log(`EXPECTED FAILURE: Chain B PBFT certificate / ${label} (${errorName})`);
  }
  return { accept, reject, snapshot: (snapshot, label) => accept(
    encodeCertificate(snapshot.quorumCertificate), snapshotContext(snapshot), label) };
}
