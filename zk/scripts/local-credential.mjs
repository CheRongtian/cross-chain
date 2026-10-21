import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { buildPoseidon } from "circomlibjs";
import { buildCredentialState,encodeCredential } from "./credential-state.mjs";

// Synthetic, local issuer material. The actual root is published by the
// deployed credential-state authority, exactly as required by the application.
export async function createLocalIssuer() {
  const read = async path => JSON.parse(await readFile(new URL(path,import.meta.url),"utf8"));
  const [encoding,stateConfig,issuers,poseidon] = await Promise.all([
    read("../encoding.json"),read("../credential-state.json"),read("../credential-model/trusted-issuers.json"),buildPoseidon(),
  ]);
  const issuer = issuers.issuers.find(value => value.trusted)?.issuer;
  if (!issuer) throw new Error("Development trusted issuer configuration is missing");
  const field = BigInt(encoding.scalarField.prime);
  const stateFor = entries => {
    const value = buildCredentialState(poseidon,entries,encoding,stateConfig);
    return { root: value.root.toString(),memberships: Object.fromEntries([...value.memberships].map(([key,value]) =>
      [key,{ ...value,credentialCommitment: value.credentialCommitment.toString(),activeLeaf: value.activeLeaf.toString(),statePathElements: value.statePathElements.map(String) }])) };
  };
  const entries = [];
  return {
    initialRoot: BigInt(stateFor([]).root),
    trustedIssuer: encodeCredential({ subject: "development-root",issuer,role: "VERIFIED_SUPPLIER",expiry: 0,credentialId: "development-root" },encoding,field).issuer,
    issue(now) {
      const fixture = randomUUID();
      const credential = { subject: "urn:private:subject:" + randomUUID(),issuer,role: "VERIFIED_SUPPLIER",
        expiry: Number(now + 86400n),credentialId: "urn:private:credential:" + randomUUID(),status: "ACTIVE" };
      entries.push({ fixture,credential });
      const state = stateFor(entries);
      return { fixture,credential,state,encoded: encodeCredential(credential,encoding,field) };
    },
  };
}
