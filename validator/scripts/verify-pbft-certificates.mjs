import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { createCertificateChecks } from "../test/helpers/pbft-certificate-contract.mjs";

const { CHAIN_B_RPC_URL: rpcUrl, PBFT_CERTIFICATE_VERIFIER_ADDRESS: address,
  VALIDATOR_SET_REGISTRY_ADDRESS: registryAddress } = process.env;
assert.ok(rpcUrl && address && registryAddress, "Chain B RPC, PBFT verifier and historical registry are required");
const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
assert.equal(await client.getChainId(), 2001);
const checks = await createCertificateChecks({ client, address, registryAddress });
const vectors = JSON.parse(readFileSync(new URL("../../test-vectors/pbft-certificates.json", import.meta.url), "utf8"));
const failures = {
  "raw-digest-signing": "SignerIdentityMismatch", "double-digest-signing": "SignerIdentityMismatch",
  "nonmember-signer": "NonmemberSigner", "duplicate-recovered-signer": "NoncanonicalSigners",
  "noncanonical-signer-order": "NoncanonicalSigners", "insufficient-evidence": "InvalidEvidenceCount",
  "claimed-signer-mismatch": "SignerIdentityMismatch", "bad-extra-evidence": "InvalidSignature",
  "wrong-commit-digest": "CommitDigestMismatch", "wrong-qc-digest": "QuorumCertificateDigestMismatch",
  "wrong-proposal-digest": "ProposalDigestMismatch", "wrong-committee-digest": "CommitteeDigestMismatch",
  "wrong-trusted-root": "ContextMismatch", "cross-epoch-context": "ContextMismatch",
  "legacy-downgrade": "ContextMismatch", "legacy-wrong-authority": "LegacyAuthorityMismatch",
};
assert.equal(vectors.cases.length, vectors.caseCount);
for (const entry of vectors.cases) {
  if (entry.valid) await checks.accept(entry.encoded, entry.expected, entry.name);
  else {
    assert.ok(failures[entry.name], `No expected contract error configured for ${entry.name}`);
    await checks.reject(entry.encoded, entry.expected, failures[entry.name], entry.name);
  }
}
const current = vectors.cases.find((entry) => entry.name === "v3-quorum-3");
function word(encoded, offset, value) {
  const start = 2 + offset * 2;
  return `${encoded.slice(0, start)}${BigInt(value).toString(16).padStart(64, "0")}${encoded.slice(start + 64)}`;
}
await checks.reject(word(current.encoded, 0, 4), current.expected,
  "UnsupportedProtocolVersion", "unsupported transport version");
await checks.reject(word(current.encoded, 32, 160), current.expected,
  "InvalidCertificateEncoding", "noncanonical statement offset");
await checks.reject(`${current.encoded}00`, current.expected,
  "InvalidCertificateEncoding", "trailing certificate bytes");
await checks.reject(current.encoded.slice(0, -2), current.expected,
  "InvalidCertificateEncoding", "truncated certificate bytes");
await checks.reject(word(current.encoded, 416, 9), { ...current.expected, authorityEpoch: "9" },
  "UnknownValidatorEpoch", "unknown exact historical epoch has no fallback");
console.log("VALID: all frozen PBFT certificate cases verified on Chain B without consuming messages");
