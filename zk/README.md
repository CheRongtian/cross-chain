# Zero-Knowledge Credential Authorization

[Project overview and public commands](../README.md)

This directory owns the synthetic credential model, its field encoding,
the Circom authorization circuit, and the development Groth16 artifact workflow.
Chain A verifies this proof before the current exact-intent forwarding entry.
Chain B does not receive the private witness or run Groth16.

## Contents

- [Proven statement and trust](#proven-statement-and-trust)
- [Credential model and encoding](#credential-model-and-encoding)
- [Circuit inputs](#circuit-inputs)
- [Active credential state](#active-credential-state)
- [Nullifiers and application context](#nullifiers-and-application-context)
- [Exact forwarding intent](#exact-forwarding-intent)
- [Time and execution policy](#time-and-execution-policy)
- [Artifacts and Solidity boundary](#artifacts-and-solidity-boundary)
- [Security and regression coverage](#security-and-regression-coverage)
- [Verification and dependencies](#verification-and-dependencies)
- [Privacy and limitations](#privacy-and-limitations)

## Proven statement and trust

The prover demonstrates:

- knowledge of the five private fields bound by the public credential commitment;
- issuer and role equality with the public policy values;
- an authorization window satisfying
  `currentTimestamp < authorizationValidUntil <= expiry`;
- membership of the commitment's active leaf under the public credential-state root;
- correct derivation of the public context-bound nullifier.

[Circuit source](circuits/CredentialAuthorization.circom) uses Circom 2,
circomlib Poseidon, Groth16, and the BN254 curve.
The deployed generated verifier checks the same statement as local snarkjs.

Issuer equality is not issuer authentication.
The application selects its trusted issuer; the circuit verifies no issuer
signature and maintains no issuer registry.
The configured credential-state authority determines active membership.

Proof validity alone does not authorize application execution.
[IdentityApplicationA](../contracts/src/IdentityApplicationA.sol) independently
enforces configured issuer/role, current root/epoch, action, time, revocation,
nullifier replay, and the exact forwarding-intent context.

## Credential model and encoding

The synthetic model has five fields:

| Field | Representation before field encoding | Visibility in the witness |
| --- | --- | --- |
| subject | Credential subject string | Private |
| issuer | Issuer identifier string | Private; equality to policy is proven |
| role | Explicit symbolic role | Private; equality to policy is proven |
| expiry | Unsigned 64-bit Unix seconds | Private |
| credentialId | Credential identifier string | Private |

[Credential model README](credential-model/README.md) owns the JSON schema,
synthetic fixture definitions, and Python model validation.
[encoding.json](encoding.json) is the machine-readable field boundary.

Subject, issuer, and credential identifier use SHA-256 over the domain's UTF-8
bytes, one zero separator byte, and the value's UTF-8 bytes.
The big-endian digest integer is reduced modulo the BN254 scalar field.
Roles use the explicit table, including `VERIFIED_SUPPLIER = 1` and `AUDITOR = 2`.
Expiry maps directly from uint64 Unix seconds.

The credential commitment is:

```text
Poseidon(1, subjectField, issuerField, roleField, expiry, credentialIdField)
```

The leading `1` versions the preimage.
Generated circuit JSON uses unsigned decimal field elements.
Protocol code avoids JavaScript Number conversion for expiry, timestamps,
field elements, and other full-width integers.

A commitment is public and stable for those credential fields.
It is not an issuer signature, an EVM account address, or an unlinkable identifier.

## Circuit inputs

Private witness inputs are the five credential fields and
`statePathElements[8]` / `statePathIndices[8]`.
The circuit constrains path indices to boolean directions.

The public signal order is exactly:

| Index | Signal |
| ---: | --- |
| 0 | credentialCommitment |
| 1 | trustedIssuer |
| 2 | requiredRole |
| 3 | currentTimestamp |
| 4 | credentialStateRoot |
| 5 | applicationDomain |
| 6 | policyEpoch |
| 7 | actionContext |
| 8 | nullifier |
| 9 | forwardIntentDigestHi |
| 10 | forwardIntentDigestLo |
| 11 | authorizationValidUntil |

The circuit, snarkjs output, Solidity adapter, and fixtures must agree on all
twelve positions.
Private expiry is not an additional public signal.

Expiry, proof timestamp, and authorization deadline are constrained to uint64
before comparison. The forwarding-intent limbs are each constrained to uint128.
These constraints prevent field-wrap values from satisfying ordinary time or
full-width digest expectations.

## Active credential state

[credential-state.json](credential-state.json) defines a fixed-depth tree:
depth `8`, capacity `256` leaves.

Active commitments are sorted numerically and placed from the leftmost position,
with zero leaves on the right.
An occupied leaf is `Poseidon(1, credentialCommitment)`;
each parent is `Poseidon(left, right)`, preserving position.

The membership witness is private.
The public root commits to the active set selected by its publisher.
This credential-state tree is distinct from the ABI/Keccak message Merkle tree.

[scripts/build-credential-state.mjs](scripts/build-credential-state.mjs)
creates deterministic Root N / Root N+1 fixtures.
Credential A is removed in Root N+1; credential B remains and receives an updated
valid path. Reversing fixture order must preserve the root.

On-chain root rotation and explicit commitment revocation are authority operations.
The circuit demonstrates current-root membership but does not publish roots,
discover revocations, or manage governance.

## Nullifiers and application context

[nullifier.json](nullifier.json) defines:

```text
Poseidon(2, credentialIdField, applicationDomain, policyEpoch,
         actionContext, forwardIntentDigestHi, forwardIntentDigestLo)
```

The private credential identifier remains hidden.
The other context values and resulting nullifier are public signals.
The leading `2` is the nullifier preimage version.

The application domain is the field reduction of:

```text
keccak256(abi.encode(namespaceHash, chainId, applicationAddress))
namespaceHash = keccak256("cross-chain:identity-application-domain:v1")
```

Initial application policy epoch is `1`.
It is unrelated to a batch epoch, validator-set epoch, or PBFT view.

| Action | Meaning |
| --- | --- |
| 1 | Standalone supplier verification; both forwarding-intent limbs must be zero |
| 3 | Authorization for one exact forwarding intent |

Equal complete nullifier contexts reproduce the same nullifier.
Changing application, policy epoch, action, or intent changes its context.
The authorization deadline is not a nullifier input.
Changing only that deadline cannot bypass an already consumed nullifier.

Application A consumes a nullifier only after successful verification and
retains it through root/epoch changes.
A reverted forwarding transaction restores consumption atomically.

[Shared nullifier relations](../test-vectors/nullifiers.json) are fixed inputs;
concrete Poseidon outputs are generated under `build/nullifier-vectors.json`.
This source replay boundary is distinct from destination message-ID replay.

## Exact forwarding intent

The current `forwardAuthorizedMessage` entry recomputes:

```text
ForwardAuthorizationIntent(uint8 protocolVersion,uint256 action,uint256 sourceDomain,address application,address sourceGateway,uint256 destinationDomain,address destinationGateway,address destinationReceiver,bytes32 payloadHash,uint256 deadline,address authorizedExecutor)
```

The digest uses the type hash and standard ABI encoding with protocol version
`2`, action `3`, the actual chain, application, immutable Gateway, destination,
payload hash, message deadline, and actual executor.

Its high/low uint128 limbs preserve the complete 256-bit Keccak digest.
They are not replaced by a single scalar-field reduction.
Fixed [forwarding vectors](../test-vectors/forward-authorizations.json)
cover ABI parity and full-width limb behavior.

Application A compares both public limbs to that exact recomputed intent.
Proof verification, nullifier consumption, and SourceGateway emission share
one transaction. A Gateway rejection restores all source-side effects.

Standalone verification grants no subsequent forwarding permission.
The private credential subject is not EVM-address-bound.
Binding an executor prevents reuse of that proof by a different caller; it does
not prove that the executor or destination supplier owns the private subject.

Only this current application path supplies that exact binding.
SourceGateway is credential-unaware, other admitted applications own their policy,
and historical messages are not rewritten or retroactively bound.

## Time and execution policy

There are three independent time boundaries:

| Boundary | Enforced by |
| --- | --- |
| `currentTimestamp < authorizationValidUntil <= expiry` | Circuit |
| Proof is not future/stale under `maxProofAge`, and `block.timestamp < authorizationValidUntil` | Application A |
| `block.timestamp < message.deadline` | Source admission and destination message policy at their respective execution times |

The public deadline is chosen by the prover.
It reveals `expiry >= authorizationValidUntil`; equality with private expiry
is allowed, so privacy does not imply the public deadline hides every expiry bound.

The helper's default lifetime is two hours, independent of private expiry and
`maxProofAge`. Choosing a deadline beyond expiry fails the circuit.
There is no mandatory freshness buffer or hidden extension of credential validity.

A proof for `currentTimestamp = expiry - 1`,
`authorizationValidUntil = expiry` is cryptographically valid.
Executing one second before the deadline is valid if other policy checks pass.
Execution exactly at or after the deadline rejects with `AuthorizationExpired`.

Stored supplier status is a separate commitment-keyed business record and does
not automatically expire when a proof deadline or credential expiry passes.

## Artifacts and Solidity boundary

The root workflow validates model fixtures, builds encoded inputs and state
paths, compiles the circuit, constructs development Groth16 keys, generates
witnesses/proofs/public signals, and exports verification artifacts.

| Location | Contents |
| --- | --- |
| `credential-model/fixtures/` | Tracked synthetic credential inputs |
| `proof-cases.json` | Tracked positive/negative proof case definitions |
| `build/` | Ignored inputs, state paths, R1CS/WASM, witnesses, keys, proofs, public signals |
| `../contracts/generated/` | Ignored generated Solidity verifier and proof fixtures |

The script exports Solidity directly from the active zkey.
Proof fixtures come from snarkjs `exportSolidityCallData`.
The fifteen-line Cast text and JSON companion share that export, preserving
G2 coordinate ordering without a second independent encoder.

`CredentialVerifier` converts named inputs to the twelve-element array.
The adapter checks cryptographic validity; it does not compare proof time with
`block.timestamp` or apply application authorization policy.

The current statement is intentionally incompatible with old eleven-signal
proofs and keys.
Regeneration updates circuit artifacts, proving/verification keys, Solidity
verifier, and fixtures together.
Deployment wires fresh immutable verifier/adapter/application instances and
admits the new application at SourceGateway; existing deployments do not upgrade.

[Historical eleven-signal proof/key](../test-vectors/legacy-credential-proof.json)
is regression evidence only.
It first verifies against its original key, then fails under the complete new
twelve-signal statement. There is no production old-verifier fallback.

The public deadline does not change credential commitments, nullifier derivation,
credential-state trees, forwarding hashes, message IDs, batches, Merkle roots,
QCs, transport bytes, or the destination protocol.
Historical source events and consumed nullifiers require no rewrite.

Runtime proof preparation reuses the existing WASM/zkey, reads current deployed
policy/root/epoch and Chain A time, and uses the active secondary synthetic credential.
Its snarkjs CLI owns temporary proving workers and removes temporary input/proof files.

## Security and regression coverage

[proof-cases.json](proof-cases.json) includes:

- valid policy and alternate issuer/AUDITOR proofs whose own public policy matches;
- equal-context nullifier stability and changed-context separation;
- altered private subject, identifier, expiry, or commitment;
- wrong issuer/role under the selected proof policy;
- invalid path, another credential's path, wrong root, and revoked membership;
- expired, equality, one-second-valid, overflow, and field-wrap time cases;
- deadlines before/equal to proof time or beyond private expiry;
- equality of authorization deadline and private expiry;
- wrong nullifier and public-signal mutation.

Alternate valid proofs demonstrate why application policy is independent of
cryptographic validity: a proof can be valid under another issuer or role and
still fail Application A.

[scripts/verify-security-invariants.mjs](scripts/verify-security-invariants.mjs)
verifies genuine positive proofs and independently mutates all twelve public
signals with the original proof unchanged.
The Solidity suites also exercise root/epoch/replay policy and exact forwarding.

Negative witness checks accept a located generated Circom assertion or explicit
`false` from witness checking.
Tampered-proof verification must return explicit `false`.
Missing files, invalid JSON, input-shape problems, WASM/proving failures, and
unexpected verifier exceptions fail the workflow; arbitrary process failure is
not evidence of a rejected cryptographic statement.

[scripts/verify-rejection.mjs](scripts/verify-rejection.mjs) owns short-lived
curve workers, and [test/rejection.test.mjs](test/rejection.test.mjs) checks
that boundary.

The final full-workflow expiry regression uses genuine near-expiry proofs and
controlled mined timestamps. Exact/after-deadline rejection must leave nullifiers,
business state, and source effects unchanged.
It runs after temporary fault-stack cleanup.

## Verification and dependencies

The normal command, from the project root, is:

```bash
./scripts/verify.sh
```

It writes the complete result to root `verification.log`.
A ZK-only script is an internal diagnostic, not a substitute for the complete
contract, policy, transport, and execution checks.

Existing environment requirements are Python 3, Circom 2, and the exact
dependencies in [package.json](package.json) / [package-lock.json](package-lock.json):
`circomlib 2.0.5`, `circomlibjs 0.1.7`, and `snarkjs 0.7.6`.
The workflow does not install them or initialize the environment.

Development Powers of Tau contributions and Groth16 setup use fixed local entropy
to avoid interactive input.
The resulting keys must not be treated as production trusted setup.

## Privacy and limitations

Public context includes the commitment, policy values, root, domain, epoch,
action, nullifier, intent limbs, proof timestamp, and authorization deadline.
These values and transaction metadata permit correlation.

Private fields and membership paths remain in the proving workflow.
The public deadline leaks an expiry lower bound; role and issuer equality also
reveal those policy values.

Source events and destination packages carry public message payloads, not a raw
credential or private witness. Application payload privacy is not provided.
Local generated proof/input files can contain sensitive demonstration material
and remain ignored development artifacts.

Issuer signature verification, subject-to-account ownership, unlinkability,
automatic stored-status expiry, and decentralized root governance are absent.
See the [contract reference](../contracts/README.md#credential-application) and
[system trust model](../README.md#trust-model) for the application boundary.
