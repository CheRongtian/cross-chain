# Zero-Knowledge Credential Authorization

This directory contains a minimal credential authorization proof built with
Circom 2, circomlib Poseidon, snarkjs, Groth16, and the BN254 curve.
The proof can be verified locally and by a Solidity verifier exported from the
same Groth16 proving key.

## Proven statement

The prover demonstrates all of the following in one circuit:

- the prover knows the five private credential fields bound by the public
  `credentialCommitment`;
- the private issuer equals the public `trustedIssuer` selected by policy;
- the private role equals the public `requiredRole` selected by policy;
- the credential is unexpired under the strict rule
  `currentTimestamp < expiry`;
- the active leaf derived from `credentialCommitment` belongs to the public
  `credentialStateRoot` through the private Merkle path;
- the public `nullifier` is derived from the private credential identifier and
  the public application, policy epoch, and action context.

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
- `statePathElements[8]`
- `statePathIndices[8]`

Public inputs, in circuit order:

- `credentialCommitment`
- `trustedIssuer`
- `requiredRole`
- `currentTimestamp`
- `credentialStateRoot`
- `applicationDomain`
- `policyEpoch`
- `actionContext`
- `nullifier`

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

## Nullifier and application context

[`nullifier.json`](nullifier.json) defines the context-bound nullifier:

```text
Poseidon(1, credentialIdField, applicationDomain, policyEpoch, actionContext)
```

`credentialIdField` remains private. The other values and the resulting
nullifier are public signals. The application domain is the BN254 scalar-field
reduction of:

```text
keccak256(abi.encode(namespaceHash, chainId, applicationAddress))
```

where `namespaceHash` is the Keccak-256 hash of
`cross-chain:identity-application-domain:v1`. Policy epoch `1` is the initial
application authorization context and is unrelated to a validator or consensus
epoch. Action `1` means supplier verification. Equal contexts produce an
equal nullifier. A different application, epoch, or action produces a separate
nullifier. Shared relation cases live in
[`../test-vectors/nullifiers.json`](../test-vectors/nullifiers.json); concrete
Poseidon outputs are generated under `build/nullifier-vectors.json`.

## Active credential state

[`credential-state.json`](credential-state.json) defines a fixed-depth tree of
256 leaves. Active credential commitments are sorted numerically, placed from
the leftmost leaf, and right-padded with zero leaves. An occupied leaf is
`Poseidon(1, credentialCommitment)` and every parent is
`Poseidon(left, right)`.

`scripts/build-credential-state.mjs` creates deterministic Root N and Root N+1
artifacts. Credential A is active under Root N and removed from Root N+1;
credential B remains active and receives a valid Root N+1 membership witness.
Reversing fixture input order is checked to produce the same root.

## Verification cases

[`proof-cases.json`](proof-cases.json) defines deterministic synthetic cases:

- a valid credential produces a proof that verifies;
- alternate issuer and `AUDITOR` credentials produce valid proofs when their
  public proof policy matches those credentials;
- the same credential and context reproduce the same nullifier;
- changing the application domain, policy epoch, or action context changes the
  nullifier while preserving cryptographic proof validity for that new context;
- a modified private subject paired with the original commitment is rejected;
- an expired credential is rejected;
- a credential with the wrong role is rejected;
- a credential from a different issuer is rejected;
- an invalid Merkle path is rejected;
- a valid path paired with the wrong public root is rejected;
- a witness paired with an incorrect nullifier is rejected;
- the revoked credential cannot satisfy membership under Root N+1;
- the unaffected credential produces a valid proof under Root N+1;
- changing the public commitment after proof generation makes verification
  fail.

The fixtures come from [`credential-model/fixtures`](credential-model/fixtures).
Generated inputs, witnesses, proving keys, proofs, and public signals are kept
under `zk/build/` and are ignored by version control.

## Solidity verification

The verification script exports `Groth16Verifier.sol` directly from the active
zkey and generates proof fixtures with snarkjs `exportSolidityCallData`. The
generated Solidity files are placed under `contracts/generated/` and ignored.

The Solidity public-signal order is:

```text
[0] credentialCommitment
[1] trustedIssuer
[2] requiredRole
[3] currentTimestamp
[4] credentialStateRoot
[5] applicationDomain
[6] policyEpoch
[7] actionContext
[8] nullifier
```

`contracts/src/CredentialVerifier.sol` converts its named public-input struct
into this array and delegates to the generated verifier. The public timestamp
is proof context and is not compared with `block.timestamp` by this adapter.

`contracts/src/IdentityApplicationA.sol` selects a trusted issuer and the
`VERIFIED_SUPPLIER` role, applies a proof freshness window against
`block.timestamp`, accepts only the current credential-state root, and records
successful authorization by public credential commitment. It also requires
its canonical application domain, current policy epoch, and supplier action,
then consumes the proof nullifier after verifier success. Its authority can
advance the policy epoch, rotate the root, and mark commitments revoked.
Consumed nullifiers are retained across both operations. The circuit does not
bind its private subject to an EVM account, so application authorization is not
keyed by the transaction submitter.

## Running verification

From the project root, run:

```bash
./scripts/verify.sh
```

The root verification script validates the credential model, calls
`zk/scripts/verify-circuit.sh`, builds the generated Solidity verifier, and
deploys the verifier, adapter, and identity application to Chain A for
integration checks. It expects `circom` on `PATH` and the exact npm dependencies
from `zk/package.json` to already exist in `zk/node_modules`; it does not install
or initialize the development environment.

The Powers of Tau contribution and Groth16 setup performed by the script use
fixed local-development entropy to avoid interactive input. Those generated
files are appropriate only for local verification and must not be treated as
production trusted setup.

## Deliberately absent

- issuer signature verification and issuer registry management
- anonymous unlinkability for the public credential commitment and other
  public proof signals
- automatic expiry of stored application authorization
- decentralized credential-state root publication or governance
- SourceGateway authorization integration
