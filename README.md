# Cross-Chain Protocol

This repository is a prototype for canonical cross-chain messaging and zero-knowledge credential authorization. It provides a source-chain gateway, a two-chain local environment, a user-held credential model, and a minimal authorization proof built with Circom, Poseidon, Groth16, and BN254.

The current implementation can:

- produce deterministic message identifiers that can be reproduced across implementations;
- emit complete canonical message data from a source-chain gateway;
- run and verify two independent local Anvil chains;
- describe private credentials, issuer trust, roles, expiry, and revocation status;
- commit to credential fields and prove that a credential satisfies issuer, role, and expiry policies;
- verify a valid proof and reject an invalid witness, expired credential, wrong role, untrusted issuer, or tampered public input.

## Architecture

```text
                                  ┌──────────────────────────┐
Private credential ──> encoding ─>│ CredentialAuthorization  │
                                  │ Circom + Poseidon        │
Public authorization policy ─────>│ Groth16 / BN254          │ ──> proof + public signals
                                  └──────────────────────────┘

Caller ──> SourceGateway on Chain A ──> CrossChainMessage event
                                                    │
                                                    └──> Relayer and destination execution are not implemented
```

Cross-chain messaging and zero-knowledge authorization can currently be verified independently. `SourceGateway` does not yet require callers to submit a ZK proof, and the repository does not contain an on-chain Groth16 verifier.

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
```

The hashes are defined as:

```text
payloadHash = keccak256(payload)
messageId   = keccak256(abi.encode(...canonical fields))
```

`epoch`, message status, and other runtime lifecycle values are excluded from the message ID. Shared vectors in `test-vectors/canonical-messages.json` ensure that independent implementations can reproduce the same results.

### SourceGateway

`contracts/src/SourceGateway.sol` exposes:

```solidity
sendMessage(
    uint256 destinationDomain,
    address destinationReceiver,
    bytes payload
) returns (bytes32 messageId, uint256 nonce)
```

Gateway behavior:

- the message version is fixed at `1`;
- the nonce starts at `1` and increments after each message;
- the destination domain cannot be `0` or the current chain ID;
- the destination receiver cannot be the zero address;
- a successful call emits `CrossChainMessage`;
- the event contains the original payload, so event payloads are public.

The repository currently implements source-chain message production and event verification. It does not yet provide a relayer, destination gateway, message confirmation, destination execution, or cross-chain replay protection.

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

A credential also has an external lifecycle status of `ACTIVE` or `REVOKED`. Status is excluded from the credential commitment, and the current circuit does not enforce revocation.

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

### Circuit statement

`zk/circuits/CredentialAuthorization.circom` proves that:

- the prover knows private credential fields matching the public `credentialCommitment`;
- the private `issuer` equals the public policy value `trustedIssuer`;
- the private `role` equals the public policy value `requiredRole`;
- `currentTimestamp < expiry`;
- `currentTimestamp` and `expiry` both fit in uint64.

Private witness inputs:

```text
subject
issuer
role
expiry
credentialId
```

Public inputs, in circuit order:

```text
credentialCommitment
trustedIssuer
requiredRole
currentTimestamp
```

Issuer trust remains an external policy decision. The circuit proves that the committed issuer matches the supplied public policy value. It does not verify an issuer signature or query an issuer registry.

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

Chain B currently verifies the two-chain environment and supplies the destination domain. No destination message receiver is deployed to Chain B.

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

The validator checks the schema, field names and order, data types, issuer trust fixtures, expiry semantics, role cases, revocation status, and commitment encoding configuration.

### ZK circuit

To verify only the circuit, proof flow, and negative cases:

```bash
bash zk/scripts/verify-circuit.sh
```

The script:

- compiles `CredentialAuthorization.circom`;
- prepares deterministic test inputs;
- creates Powers of Tau and Groth16 proving material for local verification only;
- generates and verifies a proof for the valid credential;
- confirms rejection of an invalid witness, expired credential, wrong role, and untrusted issuer;
- confirms that the original proof fails after its public commitment is changed.

Generated circuits, witnesses, proofs, public signals, ptau files, and zkey files are written under `zk/build/` and are excluded from source control.

## Complete Verification

Run the unified verification script from the repository root:

```bash
./scripts/verify.sh
```

The script uses strict error handling and performs:

1. Solidity formatting, build, and tests;
2. focused canonical-message encoding tests;
3. local-chain availability checks;
4. chain ID verification;
5. `SourceGateway` deployment to Chain A;
6. initial state, payload, and payload-hash verification;
7. two message sends with nonce, message ID, and event verification;
8. rejection checks for invalid destination domains and zero receivers;
9. credential model and fixture validation;
10. ZK circuit compilation and positive and negative proof verification.

If neither configured RPC endpoint is running, the script starts both chains through `scripts/start-chains.sh` and stops the processes it created when verification ends. If both chains already exist with the expected chain IDs, the script reuses them and leaves them running.

All stdout and stderr are displayed in the terminal and written to:

```text
verification.log
```

Each run replaces the previous `verification.log`. A successful run ends with:

```text
VERIFICATION PASSED
Credential Model and Minimal ZK Circuit
```

### Expected error output

Complete verification intentionally executes negative cases, so a passing log can contain:

```text
Error: execution reverted: InvalidDestinationDomain
Error: execution reverted: InvalidDestinationReceiver
Error: Assert Failed.
Invalid proof
```

These messages demonstrate that the contracts reject invalid destinations, the circuit rejects invalid witnesses, and a proof cannot be reused with a tampered public input. Each expected failure is followed by `Verified rejection` or `Verified expected ... rejection`. Complete verification succeeds only when the script exits with code `0` and the log ends with `VERIFICATION PASSED`.

## Repository Layout

```text
Cross-Chain/
├── contracts/
│   ├── foundry.toml
│   ├── src/
│   │   ├── MessageCodec.sol
│   │   └── SourceGateway.sol
│   └── test/
│       └── SourceGateway.t.sol
├── scripts/
│   ├── start-chains.sh
│   └── verify.sh
├── test-vectors/
│   └── canonical-messages.json
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
│   │   ├── build-inputs.mjs
│   │   ├── tamper-public.mjs
│   │   └── verify-circuit.sh
│   ├── encoding.json
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
- Revocation is not enforced by the circuit, and no revocation tree or on-chain revocation registry exists.
- The repository does not provide nullifiers or anonymous replay protection.
- `SourceGateway` does not yet integrate credential-proof verification.
- The repository does not provide a relayer, destination execution, finality proof, or production cross-chain security model.

Before using real assets, permissions, or production networks, the protocol requires a production trusted setup or verifiable ceremony, issuer authentication, revocation enforcement, an on-chain verifier, message relay, and a destination-chain execution security design.
