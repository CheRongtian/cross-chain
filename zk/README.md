# Zero-Knowledge Credential Authorization

This directory contains a minimal credential authorization proof built with
Circom 2, circomlib Poseidon, snarkjs, Groth16, and the BN254 curve.

## Proven statement

The prover demonstrates all of the following in one circuit:

- the prover knows the five private credential fields bound by the public
  `credentialCommitment`;
- the private issuer equals the public `trustedIssuer` selected by policy;
- the private role equals the public `requiredRole` selected by policy;
- the credential is unexpired under the strict rule
  `currentTimestamp < expiry`.

Issuer trust is an external policy decision. Equality with `trustedIssuer`
shows that the committed issuer matches that policy value; this circuit does
not authenticate an issuer signature or maintain an issuer registry.

## Inputs

Private witness inputs:

- `subject`
- `issuer`
- `role`
- `expiry`
- `credentialId`

Public inputs, in circuit order:

- `credentialCommitment`
- `trustedIssuer`
- `requiredRole`
- `currentTimestamp`

The circuit range-constrains `expiry` and `currentTimestamp` to unsigned
64-bit values before applying the strict comparison.

## Encoding and commitment

[`encoding.json`](encoding.json) is the machine-readable encoding boundary.
The subject, issuer, and credential identifier are encoded by hashing the UTF-8
domain string, one zero separator byte, and the UTF-8 value with SHA-256. The
big-endian digest integer is reduced modulo the BN254 scalar field. Roles use
an explicit positive-integer table, and expiry maps directly from uint64 Unix
seconds.

The commitment is:

```text
Poseidon(1, subjectField, issuerField, roleField, expiry, credentialIdField)
```

The leading `1` is the commitment preimage version. Commitment and all circuit
inputs are serialized as unsigned decimal field elements in generated JSON.

## Verification cases

[`proof-cases.json`](proof-cases.json) defines deterministic synthetic cases:

- a valid credential produces a proof that verifies;
- a modified private subject paired with the original commitment is rejected;
- an expired credential is rejected;
- a credential with the wrong role is rejected;
- a credential from a different issuer is rejected;
- changing the public commitment after proof generation makes verification
  fail.

The fixtures come from [`credential-model/fixtures`](credential-model/fixtures).
Generated inputs, witnesses, proving keys, proofs, and public signals are kept
under `zk/build/` and are ignored by version control.

## Running verification

From the project root, run:

```bash
./scripts/verify.sh
```

The root verification script preserves the Solidity and local-chain checks,
validates the credential model, and then calls
`zk/scripts/verify-circuit.sh`. It expects `circom` on `PATH` and the exact npm
dependencies from `zk/package.json` to already exist in `zk/node_modules`; it
does not install or initialize the development environment.

The Powers of Tau contribution and Groth16 setup performed by the script use
fixed local-development entropy to avoid interactive input. Those generated
files are appropriate only for local verification and must not be treated as
production trusted setup.

## Deliberately absent

- on-chain verifier generation or deployment
- issuer signature verification and issuer registry management
- revocation enforcement, trees, and roots
- nullifiers and anonymous replay protection
- application behavior and SourceGateway authorization integration
