# Cross-Chain Protocol

This repository is a prototype for canonical cross-chain source messaging and zero-knowledge credential authorization with revocation and replay protection. It provides a source-chain gateway, a two-chain local environment, a user-held credential model, credential proofs that can be verified locally or on Chain A, and an identity application that can create canonical outbound messages through the gateway.

The current implementation can:

- produce deterministic message identifiers that can be reproduced across implementations;
- emit complete canonical message data from a source-chain gateway;
- run and verify two independent local Anvil chains;
- describe private credentials, issuer trust, roles, expiry, and active or revoked lifecycle state;
- build deterministic Poseidon Merkle roots for active credentials;
- commit to credential fields and prove issuer, role, expiry, and active-state membership in one circuit;
- derive a deterministic Poseidon nullifier from the private credential identifier and a public application, epoch, and action context;
- verify a valid proof and reject an invalid witness, expired credential, wrong role, untrusted issuer, or tampered public input;
- generate a Solidity verifier from the active Groth16 proving key and verify the same proof on Chain A;
- enforce a fixed issuer, the `VERIFIED_SUPPLIER` role, proof freshness, and the current credential-state root in `IdentityApplicationA`;
- rotate the accepted root through an explicit authority and remove effective authorization for revoked commitments;
- preserve authorization for an unaffected active credential across a root rotation;
- reject both exact proof replay and a newly generated proof for the same credential and authorization context;
- advance the application policy epoch without deleting previously consumed nullifiers;
- bind a future Unix deadline into every canonical source message;
- let `IdentityApplicationA` call `SourceGateway` while preserving the gateway as the canonical message and nonce authority.

## Architecture

```text
                                  ┌──────────────────────────┐
Private credential ──> encoding ─>│ CredentialAuthorization  │
Active-set Merkle path ──────────>│ Circom + Poseidon        │
Public policy, state + context ──>│ Groth16 / BN254          │ ──> proof + public signals
                                  └──────────────────────────┘              │
                                                                            v
                                                         Solidity verifier on Chain A
                                                                            │
                                                                            v
                                                         CredentialVerifier adapter
                                                                            │
                                                                            v
                                                         IdentityApplicationA policy
                                                           │       │        │
                                                           │       v        v
                                                           │ usedNullifiers commitment status
                                                           v
                                                     SourceGateway
                                                           │
                                                           v
                                                CrossChainMessage event

Caller ──> SourceGateway on Chain A ──> CrossChainMessage event
                                                    │
                                                    └──> Relayer and destination execution are not implemented
```

`IdentityApplicationA` can call `SourceGateway`, but proof verification and message creation remain separate application entry points. A successful credential proof does not automatically emit a message, and sending a message does not consume a ZK nullifier. The generated Groth16 verifier, its credential adapter, `SourceGateway`, and `IdentityApplicationA` are deployed to Chain A during verification.

## Cross-Chain Messages

### Canonical message ID

A message ID is derived from the following fields in a fixed Solidity ABI encoding order:

```text
version
sourceDomain
sourceGateway
sourceSender
destinationDomain
destinationReceiver
nonce
payloadHash
deadline
```

The hashes are defined as:

```text
payloadHash = keccak256(payload)
messageId   = keccak256(abi.encode(...canonical fields))
```

`deadline` is the latest Unix timestamp at which the message is intended to remain valid and is part of the message identity. Changing only the deadline changes the message ID. Policy epoch, message status, and other runtime lifecycle values are excluded. Shared inputs in `test-vectors/canonical-messages.json` are evaluated with standard Solidity ABI encoding during verification, producing a concrete expected message ID under `zk/build/` and a generated Solidity fixture.

### SourceGateway

`contracts/src/SourceGateway.sol` exposes:

```solidity
sendMessage(
    uint256 destinationDomain,
    address destinationReceiver,
    bytes payload,
    uint256 deadline
) returns (bytes32 messageId, uint256 nonce)
```

Gateway behavior:

- the canonical wire-format version is `2`;
- the nonce starts at `1` and increments after each message;
- the destination domain cannot be `0` or the current chain ID;
- the destination receiver cannot be the zero address;
- the deadline must be strictly greater than `block.timestamp`;
- rejected messages do not consume a nonce;
- a successful call emits `CrossChainMessage`;
- the event contains the original payload, so event payloads are public.

The event records the direct Gateway caller as `sourceSender`. When `IdentityApplicationA` calls the Gateway, this value is the application contract address rather than the originating EOA. The Gateway currently accepts calls from arbitrary addresses and contracts; recording a caller does not classify it as a trusted source application.

The repository currently implements source-chain message production and event verification. It does not yet provide a relayer, destination gateway, message confirmation, destination execution, or destination-side replay protection.

## Credentials and Zero-Knowledge Authorization

### Credential fields

A credential contains the following canonical fields:

| Field | Type | Meaning |
| --- | --- | --- |
| `subject` | UTF-8 string | Credential subject identifier |
| `issuer` | UTF-8 string | Credential issuer identifier |
| `role` | UTF-8 token | Business role asserted by the issuer |
| `expiry` | uint64 Unix seconds | Credential expiry time |
| `credentialId` | UTF-8 string | Unique credential identifier |

A credential also has an external lifecycle status of `ACTIVE` or `REVOKED`. Status is excluded from the credential commitment so that revoking a credential preserves its identifier. Revocation is enforced by proving membership in the current active-credential Merkle root.

### Field encoding

The circuit operates over the BN254 scalar field. String values use this deterministic encoding:

```text
SHA-256(domain || 0x00 || UTF8(value)) mod BN254_SCALAR_FIELD
```

`subject`, `issuer`, and `credentialId` use separate domains. Roles use an explicit positive-integer mapping:

```text
VERIFIED_SUPPLIER = 1
AUDITOR           = 2
```

`expiry` maps directly from uint64 Unix seconds. The complete machine-readable specification is in `zk/encoding.json`.

### Credential commitment

The credential commitment uses circomlib Poseidon(6):

```text
Poseidon(
    1,
    subjectField,
    issuerField,
    roleField,
    expiry,
    credentialIdField
)
```

The leading `1` is the commitment preimage version. The output is serialized as an unsigned decimal BN254 scalar-field element.

### Active credential state

`zk/credential-state.json` defines a fixed-depth Poseidon Merkle tree with 256 leaves. Active credential commitments are sorted numerically and placed from the leftmost leaf. Each occupied leaf is:

```text
Poseidon(1, credentialCommitment)
```

Unused leaves are `0`, every parent is `Poseidon(left, right)`, and empty space is right-padded. This gives the same root for the same active set regardless of fixture insertion order. Removing credential A creates Root N+1, while an unaffected credential B receives a valid membership path under the new root.

### Context-bound nullifier

Each authorization proof exposes a deterministic nullifier while keeping `credentialId` private:

```text
Poseidon(
    1,
    credentialIdField,
    applicationDomain,
    policyEpoch,
    actionContext
)
```

The leading `1` is the nullifier version. `applicationDomain` is bound to the deployed application and chain:

```text
keccak256(
    abi.encode(
        keccak256("cross-chain:identity-application-domain:v1"),
        chainId,
        applicationAddress
    )
) mod BN254_SCALAR_FIELD
```

`policyEpoch` starts at `1` and can only increase by one. It is the authorization-policy context owned by `IdentityApplicationA`; it is unrelated to any future validator or consensus epoch. The supplier-verification action is encoded as `1`. The same private credential and the same three public context values produce the same nullifier. Changing the application, epoch, or action produces a different nullifier. Machine-readable definitions are in `zk/nullifier.json`; reusable relation vectors are in `test-vectors/nullifiers.json`, and verification writes their concrete Poseidon results to `zk/build/nullifier-vectors.json`.

### Circuit statement

`zk/circuits/CredentialAuthorization.circom` proves that:

- the prover knows private credential fields matching the public `credentialCommitment`;
- the private `issuer` equals the public policy value `trustedIssuer`;
- the private `role` equals the public policy value `requiredRole`;
- `currentTimestamp < expiry`;
- `currentTimestamp` and `expiry` both fit in uint64;
- the active leaf derived from `credentialCommitment` belongs to the public `credentialStateRoot`.
- the public `nullifier` is the Poseidon hash of the private `credentialId` and the public application, epoch, and action context.

Private witness inputs:

```text
subject
issuer
role
expiry
credentialId
statePathElements[8]
statePathIndices[8]
```

Public inputs, in circuit order:

```text
credentialCommitment
trustedIssuer
requiredRole
currentTimestamp
credentialStateRoot
applicationDomain
policyEpoch
actionContext
nullifier
```

Issuer trust remains an external policy decision. The circuit proves that the committed issuer matches the supplied public policy value. It does not verify an issuer signature or query an issuer registry.

### Solidity verification

The Solidity verifier is exported directly from the active Groth16 zkey with `snarkjs zkey export solidityverifier`. Verification-key constants are generated cryptographic source and are written to the ignored `contracts/generated/` directory. They are never maintained manually.

The generated contract implements this low-level ABI:

```solidity
verifyProof(
    uint256[2] proofA,
    uint256[2][2] proofB,
    uint256[2] proofC,
    uint256[9] publicSignals
) returns (bool)
```

`contracts/src/CredentialVerifier.sol` provides the stable project-facing `verifyCredentialProof` interface. It accepts a named `CredentialPublicInputs` struct and constructs the public-signal array in this protocol order:

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

Proof coordinates are converted with snarkjs `groth16.exportSolidityCallData`, including the required G2 coordinate ordering. The same generated calldata is used by Forge tests and Chain A integration verification.

The Solidity verifier establishes that a Groth16 proof is valid for the supplied public signals. It does not decide which issuer is trusted, which role an application should require, or whether a caller may send a cross-chain message.

`currentTimestamp` is a public input bound by the proof. The credential adapter passes it to the generated verifier without applying wall-clock policy. `IdentityApplicationA` performs the corresponding comparison against `block.timestamp`.

### Identity application on Chain A

`contracts/src/IdentityApplicationA.sol` consumes the stable `CredentialVerifier` interface and owns the business policy. Its deployment configuration contains:

- the credential verifier address;
- the source gateway address;
- one trusted issuer field value;
- the required role, fixed to the existing `VERIFIED_SUPPLIER = 1` encoding;
- a non-zero maximum proof age;
- a non-zero credential-state authority;
- a non-zero initial credential-state root.

`verifySupplier` accepts the proof coordinates and the nine-field public-input struct used by the credential verifier. Before calling the verifier, the application requires the proof issuer and role to equal its deployment policy, rejects timestamps later than `block.timestamp`, rejects timestamps older than `maxProofAge`, requires the proof root to equal the current application root, rejects commitments already marked `REVOKED`, and requires the canonical application domain, current policy epoch, and supplier action context. It also rejects out-of-field or previously consumed nullifiers. A successful verification atomically sets:

```text
usedNullifiers[nullifier] = true
authorizationStatus[credentialCommitment] = VERIFIED_SUPPLIER
```

Authorization is keyed by the public `credentialCommitment`. The current circuit proves knowledge of a private credential subject but does not bind that subject to an EVM address, so submitting a proof does not grant account-level authorization to `msg.sender`. The `SupplierVerified` event contains only the commitment, transaction submitter, and proof timestamp; it contains no private credential fields.

The credential-state authority calls `updateCredentialStateRoot` with a new non-zero root and the commitments revoked by that transition. The update changes the accepted root and marks those commitments `REVOKED` in one transaction. `isVerifiedSupplier` then returns `false` for a previously verified revoked commitment. Proofs bound to the old root are rejected, while an unaffected credential can authorize under the new root.

The same authority calls `advancePolicyEpoch` to increment the application epoch. Existing nullifier history is retained. A credential can therefore authorize once in the new epoch with its new context-bound nullifier, while its old-epoch proof remains rejected as an epoch mismatch or consumed nullifier depending on the checked context.

An exact proof replay and a newly generated proof for the same credential and context both expose the same nullifier and are rejected after the first successful use. The nullifier prevents duplicate authorization within its defined context; it does not hide the public credential commitment or provide global unlinkability. Freshness is checked when a proof is submitted. Stored `VERIFIED_SUPPLIER` state does not automatically expire when `maxProofAge` elapses, while an authority root update can explicitly revoke it.

Revocation and nullifier consumption answer separate questions and are enforced together. Active-state membership answers whether the credential is still active. The nullifier registry answers whether that credential has already performed the protected action in the current application context. A fresh, unused nullifier cannot make a revoked credential valid.

### Application source messaging

`IdentityApplicationA.sendCrossChainMessage` forwards the destination domain, destination receiver, payload, and deadline to its configured `ISourceGateway`. It returns the Gateway-created message ID and nonce and does not maintain a second nonce or message encoding implementation. The Gateway observes `address(IdentityApplicationA)` as the direct `sourceSender`.

This transport entry point is currently separate from `verifySupplier`. It does not require a proof, check stored supplier authorization, or consume a nullifier. Direct calls to `SourceGateway` also remain available because no trusted-source registry is implemented yet.

## Local Two-Chain Environment

`scripts/start-chains.sh` starts two Anvil chains:

| Chain | Chain ID | RPC |
| --- | ---: | --- |
| Chain A | `10011` | `http://127.0.0.1:4545` |
| Chain B | `2001` | `http://127.0.0.1:9545` |

Start both chains from the repository root:

```bash
./scripts/start-chains.sh
```

The command remains active until interrupted with `Ctrl+C`. Chain output is written to `chain-a.log` and `chain-b.log` in the repository root.

Chain A hosts the generated Groth16 verifier, its credential adapter, `IdentityApplicationA`, and `SourceGateway` during complete verification. Chain B verifies the two-chain environment and supplies the destination domain. No destination message receiver is deployed to Chain B.

## Prerequisites

Install these tools before using the repository:

- Bash;
- Foundry, including `forge`, `cast`, and `anvil`;
- Circom 2;
- Node.js 20 or later;
- npm;
- Python 3.

Check the local environment:

```bash
bash --version
forge --version
cast --version
anvil --version
circom --version
node --version
npm --version
python3 --version
```

Foundry and Circom are system tools and are not installed by the verification scripts:

- [Foundry installation](https://getfoundry.sh/introduction/installation/)
- [Circom 2 installation](https://docs.circom.io/getting-started/installation/)

The JavaScript dependencies are pinned in `zk/package.json` and `zk/package-lock.json`:

| Dependency | Version |
| --- | --- |
| `circomlib` | `2.0.5` |
| `circomlibjs` | `0.1.7` |
| `snarkjs` | `0.7.6` |

Install repository dependencies:

```bash
cd zk
npm ci
cd ..
```

The Python validator uses only the standard library, so the repository does not need a `requirements.txt` file.

## Build and Test

### Solidity

The Solidity build depends on verifier and proof-fixture source generated from the current Groth16 zkey and proof, plus the canonical message fixture generated from the shared vector. Generate those files first:

```bash
bash zk/scripts/verify-circuit.sh
node scripts/build-canonical-message-vector.mjs
```

Then build and test:

```bash
cd contracts
forge build
forge test -vv
```

Check Solidity formatting:

```bash
forge fmt --check
```

### Credential model

Run from the repository root:

```bash
python3 zk/credential-model/validate.py
```

The validator checks the schema, field names and order, data types, issuer trust fixtures, expiry semantics, role cases, revocation status, commitment encoding, credential-state tree configuration, nullifier definition, and nullifier vector relations.

### ZK circuit

To verify only the circuit, proof flow, and negative cases:

```bash
bash zk/scripts/verify-circuit.sh
```

The script:

- compiles `CredentialAuthorization.circom`;
- builds deterministic Root N and Root N+1 active-credential states and Merkle witnesses;
- computes shared nullifier vectors and proof inputs for equal and separated contexts;
- prepares deterministic test inputs;
- creates Powers of Tau and Groth16 proving material for local verification only;
- generates and verifies a proof for the valid credential;
- generates valid alternate-issuer and `AUDITOR` proofs for application policy checks;
- generates valid proofs for replay, alternate-domain, next-epoch, and alternate-action application checks;
- confirms rejection of an invalid credential witness, expired credential, wrong role, untrusted issuer, invalid Merkle path, wrong root, and revoked credential under the current root;
- generates a valid credential B proof under Root N+1;
- confirms that the original proof fails after any public signal is changed, including its nullifier context;
- exports the Solidity Groth16 verifier from the active zkey;
- generates a Solidity proof fixture and Chain A calldata through the snarkjs calldata converter.

Generated circuits, witnesses, proofs, public signals, ptau files, and zkey files are written under `zk/build/`. Generated Solidity cryptographic source is written under `contracts/generated/`. Both locations are excluded from source control.

## Complete Verification

Run the unified verification script from the repository root:

```bash
./scripts/verify.sh
```

The script uses strict error handling and performs:

1. local-chain availability and chain ID checks;
2. selection of a proof timestamp relative to the current Chain A block;
3. credential model, fixture, and state-tree configuration validation;
4. deterministic Root N and Root N+1 construction, nullifier-vector generation, and ZK circuit compilation with positive and negative local proof verification;
5. Solidity verifier, proof-fixture, and deadline-bound canonical message fixture generation;
6. Solidity formatting, build, and tests against the real generated verifier;
7. focused canonical-message, credential-verifier, and identity-application tests;
8. deployment of the generated verifier, credential adapter, source gateway, and identity application to Chain A;
9. valid on-chain proof verification and credential A authorization under Root N;
10. rejection of future, stale, tampered, alternate-policy, alternate-domain, alternate-epoch, alternate-action, and non-current-root submissions;
11. rejection of exact and regenerated same-context proof replays;
12. authorized policy-epoch advancement and acceptance of credential A's new-epoch nullifier;
13. rejection of unauthorized and zero-root credential-state updates;
14. rotation to Root N+1, revocation of credential A, preservation of consumed-nullifier history, and rejection of A's old-root proof;
15. authorization and retained active status for credential B under Root N+1;
16. direct `SourceGateway` message creation with deadline-bound message ID and nonce verification;
17. real `IdentityApplicationA → SourceGateway` message creation and event decoding;
18. verification that the Gateway records the application address as `sourceSender`;
19. rejection of current or expired deadlines without nonce consumption.

If neither configured RPC endpoint is running, the script starts both chains through `scripts/start-chains.sh` and stops the processes it created when verification ends. If both chains already exist with the expected chain IDs, the script reuses them and leaves them running.

All stdout and stderr are displayed in the terminal and written to:

```text
verification.log
```

Each run replaces the previous `verification.log`. A successful run ends with:

```text
VERIFICATION PASSED
Chain A Source Messaging
```

### Expected error output

Complete verification intentionally executes negative cases, so a passing log can contain:

```text
Error: execution reverted: InvalidDestinationDomain
Error: execution reverted: InvalidDestinationReceiver
Error: execution reverted: InvalidDeadline
Error: Assert Failed.
Invalid proof
FutureProofTimestamp
InvalidCredentialProof
InvalidIssuerPolicy
InvalidRolePolicy
InvalidCredentialStateRoot
InvalidApplicationDomain
InvalidPolicyEpoch
InvalidActionContext
NullifierAlreadyUsed
UnauthorizedPolicyEpochAuthority
UnauthorizedCredentialStateAuthority
StaleProofTimestamp
```

These messages demonstrate that the contracts reject invalid destinations and deadlines, the circuit rejects invalid witnesses, a proof cannot be reused with a tampered public input, and the identity application enforces policy, freshness, context-bound replay protection, state-root authority, and revocation. Each expected failure is followed by `Verified rejection`, `EXPECTED FAILURE`, or `Verified expected ... rejection`. Complete verification succeeds only when the script exits with code `0` and the log ends with `VERIFICATION PASSED`.

The on-chain negative cases normally return `false` and are reported as `Verified expected on-chain rejection`. A successful result for any modified proof or public policy value fails the complete verification.

## Repository Layout

```text
Cross-Chain/
├── contracts/
│   ├── foundry.toml
│   ├── src/
│   │   ├── interfaces/
│   │   │   ├── ICredentialVerifier.sol
│   │   │   ├── IGroth16Verifier.sol
│   │   │   └── ISourceGateway.sol
│   │   ├── CredentialVerifier.sol
│   │   ├── IdentityApplicationA.sol
│   │   ├── MessageCodec.sol
│   │   └── SourceGateway.sol
│   └── test/
│       ├── CredentialVerifier.t.sol
│       ├── IdentityApplicationA.t.sol
│       ├── mocks/
│       │   ├── MockCredentialVerifier.sol
│       │   └── MockSourceGateway.sol
│       └── SourceGateway.t.sol
├── scripts/
│   ├── build-canonical-message-vector.mjs
│   ├── deploy-verifier.sh
│   ├── start-chains.sh
│   └── verify.sh
├── test-vectors/
│   ├── canonical-messages.json
│   └── nullifiers.json
├── zk/
│   ├── circuits/
│   │   └── CredentialAuthorization.circom
│   ├── credential-model/
│   │   ├── fixtures/
│   │   ├── credential-model.json
│   │   ├── credential.schema.json
│   │   ├── trusted-issuers.json
│   │   └── validate.py
│   ├── scripts/
│   │   ├── build-credential-state.mjs
│   │   ├── build-inputs.mjs
│   │   ├── build-nullifier-vectors.mjs
│   │   ├── build-solidity-fixtures.mjs
│   │   ├── credential-state.mjs
│   │   ├── nullifier.mjs
│   │   ├── tamper-public.mjs
│   │   └── verify-circuit.sh
│   ├── credential-state.json
│   ├── encoding.json
│   ├── nullifier.json
│   ├── proof-cases.json
│   ├── package.json
│   └── package-lock.json
└── README.md
```

## Security and Usage Boundaries

- The repository uses synthetic credential fixtures and contains no real identity data or production secrets.
- The ZK verification script uses fixed local-development entropy. Its proving material must not be used in production.
- The circuit does not verify issuer signatures.
- `trustedIssuer` is a public policy input supplied to the verification flow.
- The Solidity verifier validates proofs for supplied public signals; `IdentityApplicationA` selects the issuer and role policy it accepts.
- The credential adapter does not compare the public timestamp with chain time; `IdentityApplicationA` enforces this check for its authorization entry point.
- Authorization belongs to a credential commitment because the circuit does not bind its private subject to `msg.sender`.
- Stored authorization does not automatically expire when the proof freshness window passes.
- Revocation uses membership in a deterministic active-credential root and an explicit Chain A root authority. The authority is responsible for publishing a root and revoked-commitment list that describe the same transition.
- Nullifiers prevent repeated authorization for the same credential, application, epoch, and action. They do not hide the public credential commitment, prevent correlation through other public signals, or provide global replay protection across distinct contexts.
- `SourceGateway` records its direct caller as `sourceSender` and currently has no trusted-source application registry or allowlist.
- `IdentityApplicationA` can call `SourceGateway`, while mandatory ZK-gated message creation and proof-to-message nullifier binding remain unimplemented.
- The current message binds its source chain, source gateway, destination domain, and destination receiver. Complete remote-gateway domain separation and a remote gateway registry remain unimplemented.
- The repository does not provide an indexer, finality watcher, reorg handling, relayer, Merkle batching, PBFT validation, destination gateway or execution, Application B, finality proof, or production cross-chain security model.
- ZK authorization remains local to `IdentityApplicationA` on Chain A and is not propagated across chains.

Before using real assets, permissions, or production networks, the protocol requires a production trusted setup or verifiable ceremony, issuer authentication, production credential-state publication and governance, message relay, and a destination-chain execution security design.
