# Cross-Chain Protocol

This repository is a prototype for canonical cross-chain source messaging, zero-knowledge credential authorization with revocation and replay protection, persistent source-event indexing, configurable source-block finality, reorganization recovery, deterministic message batching, Merkle commitments shared across JavaScript and Solidity, and four independent validators exchanging signed PBFT PRE-PREPARE, PREPARE, and COMMIT messages. Validators independently recheck Chain A and retain durable proposal and vote locks. Three matching PREPARE voters establish local `PREPARED`; three matching COMMIT voters produce a verifiable Quorum Certificate (QC) that authorizes an atomic batch transition to `COMMITTED`. The static committee uses `n = 4`, `f = 1`, and quorum `3`. Verification includes non-primary process failure, conflicting Byzantine messages, a bidirectional 2|2 partition and reconnection, and primary-failure safety. Signed VIEW_CHANGE and independently verified NEW_VIEW permit safe primary replacement within the same batch epoch. Rotation, relaying, and destination execution remain unimplemented.

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
- bind source and destination domains and gateways into a type-tagged message identity;
- restrict canonical message creation to explicitly authorized source applications;
- let an explicit source-authorization administrator authorize and revoke application contracts;
- let `IdentityApplicationA` call `SourceGateway` while preserving the gateway as the canonical message and nonce authority;
- scan one configured Chain A `SourceGateway` in bounded block ranges;
- recompute and validate canonical message IDs before persistence;
- identify each concrete source-log occurrence by its chain, gateway, block hash, transaction hash, and log index;
- enforce one PostgreSQL row per exact source event across retries, rescans, and clean process restarts;
- persist canonical metadata for every scanned source block, including blocks without matching events;
- persist complete messages and source-event provenance in PostgreSQL with an initial `OBSERVED` status;
- advance each message through `OBSERVED → FINALIZING → FINALIZED` using a configurable source-block depth;
- detect a source-chain divergence before indexing or finality advancement and recover from the common ancestor;
- preserve orphaned unfinalized occurrences as terminal `REORGED` audit records while re-indexing the replacement branch;
- fail closed without database mutation when a detected fork reaches a `FINALIZED` occurrence;
- consume only `FINALIZED` source occurrences through the existing batching eligibility query;
- deterministically order batch membership by canonical source block and log position;
- bind an explicit batch epoch, source scope, and ordered canonical message IDs into an ABI-encoded batch identifier;
- reconstruct the same batch from the same eligible message set and context across repeated reads and fresh builder instances;
- validate batch integrity before constructing a deterministic ordered Merkle tree;
- bind each Merkle leaf to its batch ID, canonical message position, and canonical message ID;
- reproduce the same Message Root and per-message inclusion proofs from the same valid batch;
- verify inclusion proofs off-chain and reject changed messages, contexts, positions, roots, and paths;
- compute the same Merkle leaves and ordered nodes in an EVM-compatible Solidity library;
- lock domains, encodings, roots, and proof paths against one fixed shared golden fixture;
- assign finalized source occurrences to one durable lifecycle batch each;
- persist a single `BUILDING` batch per source scope and derive subsequent epochs from durable history;
- atomically seal canonical membership, batch identity, message count, and Message Root;
- restore immutable `SEALED` and `CONSENSUS_PENDING` snapshots and inclusion proofs after process restarts;
- allocate later finalized messages to the next epoch without changing old sealed commitments;
- preserve finality state and timestamps across duplicate event ingestion;
- recover the Indexer from a persisted next-block cursor after graceful or abrupt process loss;
- preserve `OBSERVED`, `FINALIZING`, `FINALIZED`, and `REORGED` lifecycle data across worker restarts;
- recreate a failed or closed PostgreSQL client and continue from durable database state;
- run four independent validator processes with distinct secp256k1 identities and isolated state;
- authenticate configured peer identities with source-bound challenge-response signatures;
- independently verify canonical source blocks, receipts, raw event logs, and fixed-head finality;
- reconstruct each candidate's batch ID and Message Root using the existing protocol implementations;
- preserve validator-local validation observations across fresh-process restarts without granting commit authority;
- select a deterministic primary from a canonically ordered static committee for each exact batch epoch;
- sign domain-separated PRE-PREPARE proposals only after independent validation of a pending batch;
- independently authenticate and validate proposals on backups, retain one immutable proposal per epoch/view, and recover it after process loss;
- retry partial proposal delivery without changing the primary or replacing accepted state;
- create a domain-separated PREPARE vote only from a locally accepted PRE-PREPARE;
- count one durable vote per committee identity and form validator-local `PREPARED` state at three matching votes;
- recover self-vote locks, remote votes, and monotonic `PREPARED` state after process loss without committing the batch;
- persist and broadcast COMMIT only after durable local `PREPARED`, with one vote per validator and epoch/view;
- bind the static four-validator committee into each COMMIT and QC;
- construct and independently verify a QC carrying three or four distinct matching COMMIT signatures;
- atomically persist an immutable QC and commit the corresponding pending batch;
- verify persisted certificates when reading `COMMITTED` batches and recover the same result after restart.
- continue the same consensus instance through explicit durable-message retries after connectivity returns;
- exercise deterministic process and transport faults while preserving quorum identity, immutable vote locks, and source history.

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
                                      authorized application registry ──> SourceGateway
                                                           │                    │
                                                           │                    v
                                                           │   Domain-separated CrossChainMessage event
                                                           │                    │
Unknown EOA or contract ───────────────────────────────> rejected               v
                                                                     Chain A Indexer
                                                                               │
                                                                               v
                                                       PostgreSQL / canonical block history
                                                               │              │
                                                               v              v
                                                        OBSERVED          reorg check
                                                               │              │
                                                               v              v
                                                        FINALIZING        REORGED
                                                               │
                                                               v
                                                         FINALIZED
                                                               │
                                                               v
                                                       BUILDING batch
                                                               │
                                                               v
                                                  canonical batch + Merkle Tree
                                                               │
                                                               v
                                                SEALED root + inclusion proofs
                                                               │
                                                               v
                                                     CONSENSUS_PENDING
                                                               │
                                                               v
                                              V1 / V2 / V3 / V4 independent processes
                                              own key + state + Chain A RPC checks
                                                               │
                                                               v
                                              deterministic primary per batch epoch/view
                                                               │
                                                               v
                                                     signed PRE-PREPARE
                                                               │
                                                               v
                                              independent backup source validation
                                                               │
                                                               v
                                              validator-local accepted proposal locks
                                                               │
                                                               v
                                                  signed PREPARE votes
                                                               │
                                                               v
                                              3 distinct matching validators
                                                               │
                                                               v
                                                validator-local PREPARED
                                                               │
                                                               v
                                                  signed COMMIT votes
                                                               │
                                                               v
                                              3 distinct matching validators
                                                               │
                                                               v
                                               Quorum Certificate + verification
                                                               │
                                                               v
                                              atomic QC persistence + COMMITTED
```

`IdentityApplicationA` can call `SourceGateway`, but proof verification and message creation remain separate application entry points. A successful credential proof does not automatically emit a message, and sending a message does not consume a ZK nullifier. The Indexer persists emitted source events, and the Finality Watcher advances their database lifecycle; neither component adds proof-to-message binding. The generated Groth16 verifier, its credential adapter, `SourceGateway`, and `IdentityApplicationA` are deployed to Chain A during verification.

The Indexer and Finality Watcher are disposable worker processes. Their durable operational progress lives in PostgreSQL, and every new process reconciles that state with Chain A before continuing.

The batch lifecycle assigns finalized source occurrences to durable batch records. Sealing reuses the deterministic batch and Merkle builders to persist an immutable snapshot, and reading it reconstructs its inclusion proofs. A verified QC authorizes `CONSENSUS_PENDING → COMMITTED`. Source messages and finality data remain unchanged by that transition; destination delivery is outside the current implementation.

The same commitment primitive is implemented in JavaScript and Solidity. Shared committed vectors constrain both runtimes, and complete verification passes a reconstructed real sealed batch into Foundry's local EVM. This compatibility path does not deploy a destination endpoint or execute a message on Chain B.

Each validator reads the immutable source candidate and independently rechecks Chain A. Its local `VALID` or `INVALID` result is an observation, with no PBFT vote, quorum, or authorization to change the source batch lifecycle. Four local `VALID` results leave the batch `CONSENSUS_PENDING`.

## Cross-Chain Messages

### Canonical message ID

A message ID is derived from a protocol type hash and the following fields in a fixed Solidity ABI encoding order:

```text
MESSAGE_TYPEHASH
version
sourceDomain
sourceGateway
sourceSender
destinationDomain
destinationGateway
destinationReceiver
nonce
payloadHash
deadline
```

The hashes are defined as:

```text
MESSAGE_TYPE     = "CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)"
MESSAGE_TYPEHASH = keccak256(bytes(MESSAGE_TYPE))
payloadHash      = keccak256(payload)
messageId        = keccak256(
    abi.encode(
        MESSAGE_TYPEHASH,
        version,
        sourceDomain,
        sourceGateway,
        sourceSender,
        destinationDomain,
        destinationGateway,
        destinationReceiver,
        nonce,
        payloadHash,
        deadline
    )
)
```

`destinationGateway` identifies the selected remote cross-chain protocol endpoint. `destinationReceiver` identifies the target application contract behind that endpoint. Both addresses are independently bound to the message ID.

`deadline` is the latest Unix timestamp at which the message is intended to remain valid and is part of the message identity. Changing only the deadline changes the message ID. Policy epoch, message status, and other runtime lifecycle values are excluded. Shared inputs in `test-vectors/canonical-messages.json` cover the base message and one-field source-domain, source-gateway, destination-domain, and destination-gateway variants. Verification evaluates them with standard Solidity ABI encoding, produces concrete expected message IDs under `zk/build/`, and generates a Solidity fixture from the same data.

The Gateway nonce is monotonically increasing within one `SourceGateway` deployment. It is not globally unique across chains or Gateway contracts. Global protocol message identity comes from the complete type-tagged encoding, so the same nonce can appear on different source chains, source gateways, destination chains, or destination gateways without producing the same message ID.

### SourceGateway

`contracts/src/SourceGateway.sol` exposes:

```solidity
sendMessage(
    uint256 destinationDomain,
    address destinationGateway,
    address destinationReceiver,
    bytes payload,
    uint256 deadline
) returns (bytes32 messageId, uint256 nonce)
```

It also exposes the administrator-controlled registry API:

```solidity
setSourceApplicationAuthorization(address application, bool authorized)
```

Gateway behavior:

- the constructor requires a non-zero authorization administrator;
- only the configured administrator can update source-application authorization;
- authorizing an application requires a non-zero address with deployed contract code;
- revocation remains available after a contract has lost its code;
- no-op registry updates are rejected;
- `sendMessage` accepts only currently authorized direct callers;
- the canonical wire-format version is `2`;
- the nonce starts at `1` and increments after each message;
- the destination domain cannot be `0` or the current chain ID;
- the destination gateway cannot be the zero address;
- the destination receiver cannot be the zero address;
- the deadline must be strictly greater than `block.timestamp`;
- rejected messages do not consume a nonce;
- a successful call emits `CrossChainMessage`;
- the event contains the original payload, so event payloads are public.

The source domain always comes from `block.chainid`, and the source gateway always comes from `address(this)`. Callers cannot supply either value. The event records the direct Gateway caller as `sourceSender`. When `IdentityApplicationA` calls the Gateway, this value is the application contract address rather than the originating EOA. The application must also be present in `authorizedSourceApplications` at call time.

Authorization is an admission check for future messages. Revoking an application prevents subsequent sends without changing its previous events, message IDs, or consumed nonces. Source-application revocation is independent of credential revocation: one controls whether a contract may originate new messages, while the other controls whether a credential remains active. The registry does not alter the canonical message fields, `MESSAGE_VERSION`, `MESSAGE_TYPEHASH`, or shared message vectors.

Binding `destinationGateway` makes the selected remote endpoint part of the cryptographic message identity. It does not establish that the address is deployed, belongs to the destination domain, or is trusted. The repository currently implements source-chain message production and event verification. It does not provide a remote-gateway registry, relayer, destination gateway implementation, message confirmation, destination execution, or destination-side replay protection.

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

`IdentityApplicationA.sendCrossChainMessage` forwards the destination domain, destination gateway, destination receiver, payload, and deadline to its configured `ISourceGateway`. It returns the Gateway-created message ID and nonce and does not maintain a second nonce or message encoding implementation. The Gateway observes `address(IdentityApplicationA)` as the direct `sourceSender`.

After deployment, the source-authorization administrator explicitly authorizes `IdentityApplicationA` in the Gateway registry. The deployment flow performs this transaction only after confirming that the application was created at its predicted address, preserving the application-domain value used by the generated proofs.

This transport entry point remains separate from `verifySupplier`. It does not require a proof, check stored supplier authorization, or consume a nullifier. Gateway authorization establishes which application contract may create a message; it does not authenticate the EOA calling that application or bind a proof nullifier to a message.

## Chain A Indexer and Finality Watcher

The Node.js Indexer consumes only `CrossChainMessage` logs emitted by the configured `SOURCE_GATEWAY_ADDRESS`. At startup it verifies the RPC chain ID against `CHAIN_A_DOMAIN` and confirms that the configured Gateway address contains contract bytecode. It reads one fixed Chain A head, reconciles persisted canonical history against that head, then queries logs with bounded `fromBlock` and `toBlock` ranges. One-shot indexing never extends beyond the head captured at startup.

Before persistence, each event is decoded using the current `SourceGateway` event ABI. The Indexer computes `keccak256(payload)`, reconstructs the canonical ABI-encoded message, and requires the resulting message ID to equal the indexed event value. A mismatch fails the current range. Addresses and hashes are stored as lowercase hexadecimal text, the complete payload is stored as `BYTEA`, and protocol integers use `NUMERIC(78,0)` with JavaScript `BigInt` or decimal strings.

The protocol `messageId` identifies the canonical cross-chain message. The source-event identity identifies one concrete Ethereum log occurrence and consists of:

```text
source domain
source gateway
source block hash
source transaction hash
source log index
```

PostgreSQL enforces uniqueness over those five fields. Ingestion uses conflict-aware insertion, so reading the same exact log again does not create another `source_messages` row. After a uniqueness conflict, the Indexer reads the existing row through the same transaction and verifies every immutable message and provenance field against the newly decoded event. Consistent duplicates are counted and skipped. An inconsistent duplicate fails and rolls back the complete scanned range.

The block hash is part of the identity, so the same transaction and log index under another block hash remains a distinct source occurrence. If a replacement branch emits the same protocol message, both occurrences remain available for audit: the orphaned row is `REORGED`, while the replacement occurrence begins as a new `OBSERVED` row with its own block hash. `REORGED` describes only that exact source-event occurrence; it does not revoke a credential or protocol message ID and does not represent destination execution.

### Persistent message data

The `source_messages` table stores:

- every canonical message field;
- the complete payload and its hash;
- source block number and block hash;
- source transaction hash and log index;
- the PostgreSQL observation timestamp;
- the lifecycle status;
- the time a message first entered `FINALIZING`;
- the finalization time and the fixed head used for the successful finality decision;
- the time an unfinalized occurrence was classified as `REORGED`.

The `indexed_source_blocks` table stores the number, hash, and parent hash of every scanned block under the configured source domain and Gateway scope. Eventless blocks are recorded as part of the same continuous ancestry. A scanned range commits its complete block metadata, messages, duplicate checks, and next-block cursor in one PostgreSQL transaction.

### Finality lifecycle

The independent Finality Watcher reads the Chain A head exactly once per pass and reconciles canonical block history before evaluating any message. It then evaluates every `OBSERVED` or `FINALIZING` message scoped to the configured chain domain and source Gateway inside one PostgreSQL transaction. Every candidate in the pass is evaluated against the same fixed head.

The configured policy is:

```text
headBlock >= sourceBlock + FINALITY_BLOCK_DEPTH
```

The depth counts successor blocks. At depth `2`, a source message in block `N` becomes final at head `N + 2`. Equality is sufficient. A depth of `0` immediately finalizes a message when its source block is at or below the watcher head and provides no confirmation-depth protection.

The lifecycle states are:

- `OBSERVED` records durable ingestion before the watcher evaluates the event;
- `FINALIZING` records that the event has been evaluated and still lacks the configured depth;
- `FINALIZED` records that the fixed watcher head satisfied the configured depth;
- `REORGED` preserves an orphaned `OBSERVED` or `FINALIZING` occurrence as an audit record.

An already-deep `OBSERVED` message moves directly to `FINALIZED`; its `finalizing_at` remains `NULL` because it never entered `FINALIZING`. `FINALIZED` and `REORGED` are terminal. Later watcher passes and exact-event rescans preserve their status and timestamps. Only `FINALIZED` rows are eligible for deterministic batch construction; `OBSERVED`, `FINALIZING`, and `REORGED` are excluded. Constructing a batch preserves all source lifecycle status and metadata.

This remains an operator-configured source confirmation policy and does not provide absolute consensus finality or a cryptographic finality proof.

### Canonical history and source reorganization recovery

Before either the Indexer scans a new range or the Finality Watcher advances lifecycle state, the reconciler compares the newest persisted canonical block that is visible at the fixed RPC head with the block returned by Chain A. A matching hash takes the fast path. A hash mismatch or head regression walks persisted blocks backward and compares them with the current chain until it finds the common ancestor.

Recovery from a fork is atomic under the configured source scope:

1. lock the source cursor and the persisted common ancestor;
2. lock message occurrences from the fork block onward;
3. abort if any affected occurrence is already `FINALIZED`;
4. mark affected `OBSERVED` and `FINALIZING` occurrences as `REORGED` while preserving their message data, provenance, observation time, and any `finalizing_at` timestamp;
5. delete canonical block records from the fork block onward;
6. rewind the cursor to the fork block so normal indexing can persist the replacement branch.

If a fork reaches `FINALIZED`, the recovery transaction rolls back completely. Message rows, canonical block records, and the cursor remain unchanged so an operator can investigate the finality-policy violation. If no common ancestor exists in retained history, recovery also stops for manual intervention.

When the canonical block table is empty while a cursor or message rows already exist, the reconciler fetches the historical block range through the last committed block and verifies every existing message block hash before storing the history. A mismatch or a stored range beyond the current head fails closed because safe automatic reconstruction is unavailable.

### Cursor and restart behavior

The `indexer_cursors` table scopes each cursor by Chain A domain and source Gateway. Its `next_block` value is the first block not yet committed by the Indexer. A new cursor starts at `SOURCE_GATEWAY_START_BLOCK`; an existing cursor takes precedence over the configured start block.

For each range, canonical block inserts, message inserts, duplicate consistency checks, and the cursor update execute in one PostgreSQL transaction through one `pg` client. A failed validation or query rolls back the complete range. Logs are sorted by block number and log index before insertion, and multiple messages in one block are committed together with the range cursor. A matching duplicate does not change its first `observed_at` value or current lifecycle status, and a range containing only matching duplicates still advances the cursor. Cursor updates are monotonic during normal ingestion and move backward only during atomic fork recovery.

Indexer one-shot mode reads the chain head once at startup, scans only through that fixed snapshot, and exits. Continuous mode repeatedly catches up to a new snapshot and waits for `INDEXER_POLL_INTERVAL_MS` between polls. Every new Indexer process reads the stored cursor, reconciles canonical source history, and continues without resetting to the deployment block. Events emitted while the Indexer is offline are discovered during this catch-up as long as they remain in available canonical source history. If a retry or deliberate rescan encounters an already stored event, database uniqueness prevents a duplicate row.

The Finality Watcher runs independently from the Indexer. Its one-shot mode performs one fixed-head reconciliation and finality pass, while continuous mode repeats passes with `FINALITY_POLL_INTERVAL_MS` between them. A restarted watcher queries persisted `OBSERVED` and `FINALIZING` rows again after canonical reconciliation. It does not depend on an in-memory pending-message list. The runtime assumes one active Indexer and one active Finality Watcher.

### Crash recovery

Worker memory is disposable. PostgreSQL stores the source occurrences, canonical block history, scan cursor, lifecycle status, and lifecycle timestamps needed to resume processing. Chain A remains the authoritative source history, so a restarted worker always performs canonical reconciliation before scanning or advancing finality.

Indexer range persistence is crash-safe at the transaction boundary. Canonical blocks, message occurrences, duplicate validation, and cursor advancement commit together. A failure before commit leaves none of the range durable, so a new process retries it from the unchanged cursor. A process loss after commit leaves the complete range durable, so the next process begins at the committed cursor. Database-enforced source-event identity keeps overlapping retries and repeated restarts idempotent.

Finality transitions are also transactional. `OBSERVED` and `FINALIZING` survive process loss and are evaluated by the next watcher against one new fixed head snapshot. A sufficiently deep `FINALIZING` occurrence can move directly to `FINALIZED` after restart. Existing `FINALIZED` and `REORGED` occurrences remain terminal, and the `FINALIZED`-only eligibility query returns each persisted source occurrence once.

Database errors fail the current worker pass and propagate to the process entry point. The process exits after closing its pool when possible. Recovery creates a fresh PostgreSQL pool and reads the existing durable state; there is no in-process retry manager or shutdown checkpoint. Correctness therefore does not depend on graceful termination. After a successful reorganization recovery rewinds the cursor, a newly started Indexer reads that rewound value and scans the replacement branch through the normal ingestion path.

This recovery model covers one Indexer, one Finality Watcher, and application-side PostgreSQL client recreation. It does not provide database replication, database-server failover, active-active workers, distributed leases, zero-downtime orchestration, or multi-region availability.

### Runtime configuration

| Variable | Meaning |
| --- | --- |
| `CHAIN_A_RPC_URL` | Chain A HTTP JSON-RPC endpoint |
| `CHAIN_A_DOMAIN` | Expected Chain A chain ID |
| `SOURCE_GATEWAY_ADDRESS` | Only Gateway whose events are indexed |
| `SOURCE_GATEWAY_START_BLOCK` | First block for a new cursor |
| `DATABASE_URL` | PostgreSQL connection string |
| `INDEXER_BLOCK_RANGE` | Maximum blocks queried per range; defaults to `2000` |
| `INDEXER_POLL_INTERVAL_MS` | Continuous-mode polling delay; defaults to `1000` |
| `FINALITY_BLOCK_DEPTH` | Required non-negative source confirmation depth; `0` allows immediate finalization |
| `FINALITY_POLL_INTERVAL_MS` | Continuous Finality Watcher polling delay; defaults to `1000` |
| `INDEXER_DB_SCHEMA` | PostgreSQL schema; defaults to `cross_chain_indexer` |

Apply the migrations and run a one-shot catch-up from `indexer/`:

```bash
export CHAIN_A_RPC_URL='http://127.0.0.1:4545'
export CHAIN_A_DOMAIN='10011'
export SOURCE_GATEWAY_ADDRESS='<deployed-source-gateway>'
export SOURCE_GATEWAY_START_BLOCK='<source-gateway-deployment-block>'
export DATABASE_URL='postgresql://<user>:<password>@127.0.0.1/<database>'
export FINALITY_BLOCK_DEPTH='2'
export FINALITY_POLL_INTERVAL_MS='1000'

npm run migrate
npm run catch-up
```

Run the continuous service with the same configuration:

```bash
npm start
```

Run one Finality Watcher pass or the continuous watcher with the same configuration:

```bash
npm run finality:once
npm run finality
```

## Deterministic Message Batching

The standalone `createMessageBatcher({ config, pool })` reads all currently `FINALIZED` source occurrences in the configured `chainDomain` and `sourceGateway` scope through the existing `listBatchEligibleMessages` query. Its `buildBatch({ epoch })` operation requires an explicit uint256 epoch and returns `undefined` when no finalized messages are available. This standalone builder does not filter lifecycle ownership. The persistent lifecycle described below instead seals only a particular batch's assigned occurrences. The batch epoch is independent of the identity application's policy epoch and any future validator-set epoch.

The batch representation contains:

| Field | Meaning |
| --- | --- |
| `version` | Fixed batch wire-format version `1` |
| `sourceDomain`, `sourceGateway` | One source-chain and Gateway scope |
| `epoch` | Explicit deterministic batch context |
| `messages` | Ordered canonical messages, complete payloads, and source-event provenance |
| `messageIds` | Canonical protocol message IDs in the same order |
| `batchId` | Keccak hash of the domain-separated Solidity ABI encoding |

The builder itself sorts by `sourceBlockNumber`, then `sourceLogIndex`, then normalized `sourceBlockHash`, `sourceTransactionHash`, and `messageId`, all ascending. The eligibility query uses the same field order and bytewise hexadecimal tie-breakers. Block numbers and log indices remain `BigInt`; database primary keys, timestamps, insertion order, and JavaScript object property order have no role in the protocol result.

Every input must be `FINALIZED`, belong to the batch's source scope, and carry a valid canonical message ID matching its complete protocol data and payload. The builder rejects duplicate message IDs, duplicate source occurrence identities, conflicting hashes at one source height, and conflicting global log positions. Direct calls to the pure `buildMessageBatch` function apply the same validation as the database-backed operation.

Batch encoding follows the same Solidity ABI and Ethereum Keccak conventions as canonical messages:

```text
MESSAGE_BATCH_TYPE = "MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)"
MESSAGE_BATCH_TYPEHASH = keccak256(bytes(MESSAGE_BATCH_TYPE))
batchId = keccak256(
    abi.encode(
        MESSAGE_BATCH_TYPEHASH,
        uint8(1),
        sourceDomain,
        sourceGateway,
        epoch,
        orderedMessageIds
    )
)
```

The array is ABI-encoded as a `bytes32[]` with its length and ordered contents. Protocol message IDs retain their existing canonical definition. The batch ID binds the batch version, source scope, epoch, and ordered message IDs; source block and transaction provenance are retained in `messages` for ordering and audit.

Given the same eligible source occurrences and context, reverse or shuffled input, repeated construction, and a fresh builder return the same batch. Changing the epoch or ordered message membership changes the batch ID. Database errors and malformed inputs propagate to the caller. The result includes no database IDs or observation/finalization timestamps.

Standalone batch construction reads source data and returns an immutable value. It does not persist a batch record, reserve finalized rows, rotate epochs, or change finality state. If the finalized set grows, a new standalone construction may produce different membership and a different batch ID even when the caller reuses an epoch. The persistent lifecycle freezes membership at sealing; exactly-once downstream consumption remains outside the implementation.

PostgreSQL provides durable operational state; Chain A remains the source history authority. Constructing or sealing a batch grants no Chain B authorization, validator approval, quorum certificate, or delivery guarantee. The batch feeds the off-chain Merkle commitment and subsequent PBFT vote/QC path. Relaying remains outside the current implementation.

## Merkle Message Commitment

`buildMessageMerkleTree(batch)` accepts a deterministic Message Batch. Before hashing, `validateMessageBatch` reconstructs it with the existing batch builder and checks its version, source context, epoch, message IDs, membership, canonical order, and batch ID. A stale ID, reordered batch, changed message, duplicate occurrence, non-finalized member, or empty batch raises an error. The Merkle layer performs no independent database selection and keeps the existing batch ID and ordering semantics.

Leaf and internal-node domains follow the repository's typed ABI/Keccak convention:

```text
LEAF_DOMAIN = keccak256(bytes(
    "MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)"
))
NODE_DOMAIN = keccak256(bytes(
    "MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)"
))
leaf = keccak256(abi.encode(LEAF_DOMAIN, batchId, uint256(index), messageId))
node = keccak256(abi.encode(NODE_DOMAIN, leftChild, rightChild))
```

Leaves follow the batch's canonical message order. The leaf binds its message to a particular batch and zero-based position; the batch ID already binds the source scope, epoch, and ordered protocol message IDs. Internal nodes preserve left/right order. Children and sibling hashes are never sorted. At every layer with an odd number of nodes, the last node is duplicated as its own right sibling. A single-message batch has its leaf hash as the Message Root and an empty proof path. There is no valid empty-batch root.

The immutable tree result contains `batchId`, `leafCount`, `messageRoot`, ordered `leaves`, and one entry in `proofs` for each message. Each proof contains:

| Field | Meaning |
| --- | --- |
| `batchId` | Expected deterministic batch identity |
| `messageId` | Canonical protocol message at this position |
| `index` | Non-negative safe JavaScript integer within batch bounds |
| `leafCount` | Exact message count of the expected batch |
| `siblings` | Canonical bytes32 sibling hashes, from the leaf upward |

Proof direction follows the index at each layer: even positions are left children and odd positions are right children, then the position becomes `floor(index / 2)`. The expected leaf count fixes the number of layers and the locations where self-duplication is required. Array indices and counts use safe JavaScript integer semantics; domains, epochs, nonces, block numbers, and other protocol uint256 values retain `BigInt` semantics. The leaf's index is explicitly converted to uint256 for ABI encoding.

`verifyMessageMerkleProof({ batch, message, proof, messageRoot })` receives the expected batch and root from the caller. It revalidates the batch, recomputes the supplied complete message's canonical ID, and compares its canonical fields, `FINALIZED` status, and source provenance with the member at the claimed position. It then checks the proof's batch ID, message ID, index, leaf count, exact path length, bytes32 siblings, positional left/right direction, and required odd-node duplication. The recomputed root must equal the expected Message Root. Invalid inputs return `false`.

Keeping an old message ID while changing a nonce, payload, deadline, or another protocol field fails normal verification. A proof for a different message or epoch also fails, as do wrong roots, wrong positions, tampered siblings, malformed hashes, truncated paths, and extra path elements. Source occurrences marked `REORGED` cannot enter the validated batch or satisfy its member validation.

Repeated construction, a fresh batch or Merkle builder, and permutations canonicalized by the batch builder reproduce identical leaves, roots, and proofs. These values contain no database row IDs, observation/finalization timestamps, process identifiers, or private credential attributes. Merkle computation does not write source records, eligibility, canonical block history, or batch lifecycle state.

The Message Root commits to ordered batch membership. Its expected batch, root, and member count still require an appropriate trust source; a valid proof by itself grants no Chain B authorization, Byzantine consensus, quorum certificate, or delivery guarantee. The commitment primitive supports off-chain and Solidity verification. PBFT signatures are verified separately through the QC primitive; relaying and destination execution remain unimplemented.

## Shared Merkle Compatibility

`contracts/src/MessageMerkle.sol` is a pure internal library with `computeLeaf`, `hashNode`, and `verifyProof`. It uses the same Ethereum Keccak-256 domains and `abi.encode` preimages as the off-chain implementation. It preserves left/right order, derives exact depth from the leaf count, rejects empty trees and out-of-range indices, and enforces self-duplication whenever traversal reaches an unpaired final node. A single leaf is its root and requires an empty sibling path. Invalid proofs return `false`.

`verifyProof(expectedBatchId, expectedMessageId, expectedLeafCount, expectedRoot, proof)` accepts a proof with the existing `batchId`, `messageId`, `index`, `leafCount`, and `siblings` fields. The expected context must be supplied independently from a trusted snapshot. Solidity receives canonical message IDs; the existing `MessageCodec` remains responsible for message-field hashing. The off-chain verifier additionally validates complete messages, source provenance, finalized membership, and the expected deterministic batch.

The trusted count matters independently of root/path verification. For example, the first leaf's proof in a three-leaf tree can also describe a four-leaf path with the same root, because that path does not traverse the duplicated final leaf. The library compares claimed `leafCount` with `expectedLeafCount` before traversing. Passing an untrusted proof's own count as the expected count would lose this check. The primitive does not authenticate any expected context or validate a PBFT certificate.

`test-vectors/merkle-golden-vectors.json` is the sole canonical source of shared Merkle inputs and expected outputs. Node and Foundry tests read it directly; no second hand-maintained Solidity fixture exists. Its schema records:

- a fixture schema version and descriptive protocol identifier, with no new cryptographic hash input;
- fixed leaf/node type strings and domain hashes;
- fixed public canonical-message inputs and a source context with an exact large uint256 epoch;
- batches with 1, 2, 3, 4, and 5 messages, including nontrivial high-bit-set identifiers;
- complete deterministic batches, ordered message IDs, leaf preimages and hashes, every tree level, roots, and every inclusion proof;
- a standalone high-index encoding probe and a distinct NIST SHA3-256 result to detect hash-function or width drift.

Protocol uint256 values are decimal strings, hexadecimal values are lowercase and `0x`-prefixed, and bytes32 values contain exactly 64 hexadecimal digits. Existing safe-integer proof indices and leaf counts remain JSON integers. Fixture serialization explicitly sorts keys and preserves array order; JSON serialization never enters a protocol hash.

`indexer/scripts/generate-merkle-golden-vectors.mjs` consumes the fixed inputs through the existing batch and Merkle builders. It uses no database, RPC, clock, or randomness. The developer mode emits candidate fixture contents to stdout; it never writes the canonical file. Unified verification uses `--check` to compare the regenerated bytes with the fixed file and fails on any difference. It cannot silently replace expected values after protocol drift.

Both runtimes compare domains, leaves, internal nodes, roots, and proof paths with the same fixed expected bytes. Tests cover all member positions, single-leaf and multi-level odd duplication, incorrect context/count/index/root/siblings, reordered or truncated/extended paths, and proofs from other members or vectors. They also reject a fabricated odd sibling even when supplied with a root matching the fabricated path.

The encoding tests lock exact preimages and a uint256 index exceeding uint32. For these specific all-32-byte fields, `abi.encodePacked` produces the same bytes as `abi.encode`; a test claiming they must differ would be incorrect. Narrowed or shortened index encodings do differ and are rejected by the fixed values. Ordered nodes include descending pairs so sorted-pair hashing changes expected results. Ethereum Keccak-256 is distinct from the fixture's NIST SHA3-256 comparison value.

The real lifecycle integration reads a sealed A/B/D snapshot in a fresh process and supplies only its public identifiers, trusted count/root, leaves, and proofs to `MessageMerkleTest.testRealSealedSnapshot` through a test-only environment input. Foundry verifies every member in its local EVM without deploying a test harness to either chain. The ordinary Solidity suite skips this input-dependent test; the real integration invokes it with data and requires an actual passing result, never a skip. Dynamic integration data does not overwrite the shared golden fixture.

Golden vectors establish compatibility regression boundaries. They provide no consensus, quorum certificate, trusted relayer, destination registry, replay protection, or execution authorization. No private credential data enters this fixture, and `CONSENSUS_PENDING` remains distinct from `COMMITTED`.

## Batch Lifecycle

`createBatchLifecycle({ config, pool })` manages one configured source domain and Gateway through PostgreSQL. It requires an existing Indexer cursor for that scope. The conceptual lifecycle is:

```text
BUILDING → SEALED → CONSENSUS_PENDING → COMMITTED
                                      (verified COMMIT quorum certificate)
```

A sealed batch is an immutable message commitment, and a pending batch awaits a verified COMMIT quorum certificate. Local `PREPARED` or `COMMIT_QUORUM` alone cannot change its status. `commitWithCertificate({ certificate })` is the production commit path: it independently verifies the QC against the persisted batch and the caller-configured static committee, then atomically persists the certificate and transitions to `COMMITTED`. Ordinary status updates without matching complete QC evidence fail the database guard. `COMMITTED` is terminal.

Migration `005_batch_lifecycle.sql` adds two tables:

- `message_batches` stores the operational `batch_record_id`, source scope, exact uint256 epoch, status, version, protocol `batch_id`, Message Root, message count, and transition timestamps.
- `message_batch_members` references authoritative `source_messages` rows and records each canonical message ID and its sealed position. It stores no alternative JSON message snapshot.

`batch_record_id` identifies a database record; it is distinct from the deterministic protocol `batchId`. A `BUILDING` record has no final batch ID, root, count, or canonical positions. An empty building batch is allowed, but cannot be sealed. Only `FINALIZED` occurrences in the configured scope can be assigned. A source occurrence belongs to at most one lifecycle batch, enforced by a database uniqueness constraint. Source messages retain their original status, fields, provenance, and finality timestamps.

Creation, collection, assignment, sealing, and pending transitions use transactions and lock the existing source cursor row without changing its value. A partial unique index permits only one `BUILDING` batch per scope; `(source_domain, source_gateway, epoch)` is also unique. The first creation requires an explicit `initialEpoch`. Later creation derives exactly `latestPersistedEpoch + 1`, never from process memory or a caller-selected replacement. A repeated supplied seed must match the initial persisted epoch. Uint256 overflow fails without creating a new record.

The lifecycle API exposes:

| Operation | Result |
| --- | --- |
| `getOrCreateBuilding({ initialEpoch } = {})` | Create or recover the building snapshot |
| `collectEligible({ initialEpoch } = {})` | Assign all unclaimed finalized occurrences; return `{ snapshot, assignedCount }` |
| `assignMessages({ batchRecordId, sourceMessageIds })` | Assign explicit eligible occurrence IDs with the same ownership rules; return `{ snapshot, assignedCount }` |
| `sealBatch({ batchRecordId, expectedBatchId?, expectedMessageRoot? })` | Atomically seal, or recover the identical sealed snapshot |
| `readBatch({ batchRecordId })` | Read and validate a durable snapshot |
| `markConsensusPending({ batchRecordId })` | Advance a sealed snapshot to pending; repeated calls are idempotent |
| `commitWithCertificate({ certificate })` | Verify and persist QC evidence while atomically committing its exact pending batch; equivalent retries preserve the original QC |

Snapshots contain `{ record, members, batch, tree }`. Building snapshots have `batch: null` and `tree: null`. Sealed snapshots reconstruct the existing batch representation and Merkle result, including every inclusion proof. Committed snapshots additionally contain independently verified `quorumCertificate` and require the caller's expected static committee. Protocol values remain `BigInt`; operational timestamps and record IDs do not enter any protocol hash.

Sealing runs the existing canonical builder over the assigned source occurrences, validates the resulting batch, builds its Merkle tree, and persists all canonical positions, batch ID, root, count, and `SEALED` status in one transaction. A failure before commit rolls back the entire operation and leaves a retryable building batch. Repeated sealing cannot rewrite the snapshot or move a pending batch backward.

Database guards reject sealed member insertion, deletion, reassignment, reordering, commitment changes, epoch changes, record deletion, illegal transitions, and rewritten transition timestamps. Every sealed read reconstructs canonical membership and checks count, contiguous positions, canonical order, batch ID, and Message Root. Inconsistent persisted data fails closed. Inclusion proofs are regenerated deterministically from authoritative source data rather than saved as an independent proof format.

Fresh clients and processes recover the same sealed or pending snapshot without local state. Subsequent collection creates the next epoch and assigns only unclaimed finalized occurrences; old roots and proofs remain unchanged. The integration flow seals A/B/D, restores the snapshot in fresh processes, checks its proofs with the Solidity primitive, marks it pending, then produces and finalizes Message E and assigns only E to the next epoch. Unit and isolated database tests cover retry behavior, invalid transitions, immutable snapshots, partial-seal rollback, and competing clients synchronized at explicit lock barriers.

Batch membership uniqueness provides durable assignment ownership. It does not establish exactly-once consensus, relaying, destination execution, or delivery.

## Independent Validators

The `validator/` subsystem runs one validator per Node.js process. The configured static set contains exactly four unique secp256k1-derived Ethereum addresses and four distinct HTTP endpoints. V1–V4 are verification aliases, not cryptographic identities. Each process has its own key, memory, endpoint, PostgreSQL namespace, and source RPC client. The production configuration supports separate database servers as well as isolated schemas on one server.

The committee coordinates signed PRE-PREPARE proposals through one deterministic primary per batch epoch. After accepting the same proposal, every committee member, including the primary, can persist and broadcast one signed PREPARE vote. Three distinct matching voters produce validator-local `PREPARED`, which permits COMMIT voting. Three distinct matching COMMIT voters produce a QC; independent QC verification authorizes `CONSENSUS_PENDING → COMMITTED`. There is no consensus view, validator-set epoch, or committee rotation.

### Identity and persistence

Private keys enter through `VALIDATOR_PRIVATE_KEY`. They are never included in public identity responses, validation observations, or PostgreSQL records. Verification constructs development-only keys at runtime and injects them into child-process environments without printing them. These keys must not be used for production validators.

Validator-local migrations are owned by `validator/migrations/`. Source-side QC persistence is introduced by `indexer/migrations/006_pbft_commit.sql`; both sets of migrations must be applied explicitly before runtime. Startup binds or checks one persistent identity, verifies source connectivity and Chain A context, and only then opens the HTTP endpoint. A failed prerequisite exits nonzero.

The local schema contains:

- `validator_metadata`: one immutable validator address, source domain/Gateway, finality policy, and protocol version;
- `validated_batch_bindings`: one immutable batch ID, epoch, root, count, and ordered public source-occurrence references;
- `validation_observations`: immutable `VALID`/`INVALID` observations keyed by batch ID and source-head hash, with exact head number and an operational timestamp;
- `validator_committee`: an immutable canonical array of four configured public identities;
- `pbft_pre_prepares`: one immutable accepted proposal per local validator, batch epoch, view, and protocol version, including batch ID, root, digest, primary signature, `ISSUED`/`ACCEPTED` direction, and acceptance time;
- `pre_prepare_rejections`: separate minimal public rejection evidence and stable reason categories, with no authority to reserve an accepted slot;
- `pbft_prepare_votes`: one immutable vote per local validator, batch epoch, view, protocol version, and cryptographic voter identity, bound by foreign key to the exact locally accepted proposal;
- `pbft_prepared_states`: an immutable local transition containing the accepted proposal and the first canonical set of three durable voter identities that established prepare quorum;
- `prepare_rejections`: separate operational evidence for malformed, mismatched, unknown, and conflicting PREPARE votes;
- `pbft_commit_votes`: one immutable COMMIT per local validator, epoch, view, protocol version, and voter, with an exact foreign key to local `PREPARED`;
- `pbft_commit_quorums`: immutable local `COMMIT_QUORUM` statement, first three voter identities, and QC statement digest;
- `commit_rejections`: separate public rejection evidence with no quorum weight;
- `pbft_epoch_views`: immutable batch/root binding, monotonic current view, transition intent, finality, and progress time;
- `pbft_view_change_votes`: immutable signed safety evidence per sender/epoch/target view;
- `pbft_new_views`: immutable accepted NEW_VIEW and selected proposal/quorum evidence.

Opening an existing namespace with another key, Gateway, domain, finality policy, or committee membership fails closed. Peer order and endpoint changes do not change the canonical identity array. Same-snapshot validation at the same head is idempotent. A different head adds an observation without deleting history. A changed root, epoch, or occurrence membership for an existing batch ID, or contradictory results at the same head, cannot overwrite prior state. No operational timestamp or local observation enters a message ID, batch ID, Merkle hash, proposal signature, or vote signature. Ordered, rerunnable validator migrations preserve existing identity and observations; `002_pre_prepare.sql` adds proposals, `003_prepare.sql` adds PREPARE state, and `004_commit_and_qc.sql` adds COMMIT votes and quorum state without rewriting earlier migrations.

An integrity-checked candidate that fails canonical-block or depth validation can produce a local `INVALID` observation. A malformed or corrupt snapshot cannot establish a batch binding; its request is rejected without recording its untrusted cryptographic assertions. Unavailable RPC data cannot produce `VALID` or overwrite an earlier observation. Validator operations never repair or rewrite source history.

### Independent source validation

`POST /validate-batch` accepts only a canonical `batchId` reference. The process loads the candidate from its configured source database through the existing lifecycle reconstruction and accepts only `SEALED` or `CONSENSUS_PENDING`. It independently performs:

1. RPC chain-ID and configured SourceGateway-bytecode checks;
2. one fixed latest Chain A head number/hash for the complete pass;
3. canonical block-hash comparison for every member;
4. successful transaction receipt and exact block/transaction/log occurrence checks;
5. raw topics/data decoding through the existing SourceGateway event decoder, with complete canonical message comparison;
6. exact successor-depth finality through the existing `isFinalizedByDepth` policy using that fixed head;
7. deterministic batch reconstruction and Message Root recomputation through the existing production builders;
8. a check that the fixed head's block hash still matches before persisting the local observation.

`FINALIZED` in PostgreSQL is an eligibility input, not independent source truth. A source block above the fixed head, insufficient depth, missing or changed log, wrong context, or canonical mismatch fails closed. A fork affecting finalized members is not repaired by validators. Source-layer reconciliation and operator investigation retain that responsibility. Proof verification and outbound message creation also remain separate application operations; the validator layer adds no atomic ZK-to-message binding.

### Peer transport and HTTP API

The transport uses Node's built-in HTTP implementation. Requests have a bounded JSON body and strict fields. Public endpoints expose no secrets:

| Endpoint | Responsibility |
| --- | --- |
| `GET /health` | Alive/PID information and readiness after local identity, source DB, and RPC prerequisite checks |
| `GET /identity` | Public validator identity and source policy context |
| `GET /observations` | This validator's own persisted validation history |
| `POST /handshake` | Sign a known peer's fresh bytes32 challenge in the identity-handshake domain |
| `POST /connect-peer` | Authenticate one configured peer using an independently generated challenge |
| `POST /validate-batch` | Independently validate a referenced source batch |
| `POST /pbft/primary` | Compute primary for decimal-string `epoch` and `view` |
| `POST /pbft/propose` | Validate a `batchId`, require this node to be primary, persist and broadcast its proposal |
| `POST /pbft/pre-prepare` | Authenticate an envelope, independently validate its first acceptance, and persist a local safety lock |
| `GET /pbft/pre-prepares` | Read this validator's durable issued/accepted proposals |
| `POST /pbft/prepare/cast` | Load an accepted proposal by decimal-string epoch, persist this validator's vote, and broadcast it |
| `POST /pbft/prepare` | Authenticate and persist a configured validator's matching PREPARE vote |
| `GET /pbft/prepares` | Read local vote collections, unique counts, and durable `PREPARED` state |
| `POST /pbft/commit/cast` | Load durable `PREPARED` by decimal-string epoch, persist the self COMMIT, and broadcast |
| `POST /pbft/commit` | Authenticate and persist a matching COMMIT only when this receiver is locally `PREPARED` |
| `GET /pbft/commits` | Read local COMMIT collections, durable quorum, and reconstructed QC |
| `POST /pbft/qc` | Reconstruct a canonical QC from durable local COMMIT quorum by epoch |
| `POST /pbft/qc/submit` | Independently verify a QC and atomically commit its exact source batch |

Handshake hashing is `keccak256(abi.encode(HANDSHAKE_DOMAIN, sourceDomain, sourceGateway, validatorAddress, challenge))`, with the type string `ValidatorIdentityHandshake(uint256 sourceDomain,address sourceGateway,address validator,bytes32 challenge)`. The response uses Ethereum personal-message signing of that raw digest. The requester recovers the signer and checks the expected static peer identity, source context, and challenge. Changed challenges, identities, context, signatures, and replay against a new challenge fail. No persistent handshake anti-replay ledger is needed; freshness belongs to the requester.

This handshake proves peer key control. It is not a PBFT vote, encrypted transport, or authenticated consensus session. A validation request triggers independent reads and cannot upload a trusted tree/root or grant commit authority.

### Deterministic primary and PRE-PREPARE

The static committee is sorted by unsigned address bytes, represented as equal-length lowercase hexadecimal addresses. Every validator computes `primaryIndex = (epoch + view) % 4n` using exact `BigInt` arithmetic. Epoch identifies a batch consensus instance; view identifies a leader round within that same epoch. View zero preserves the original primary selection. Configuration order, startup, discovery, and reachability have no influence. Replacement requires a verified three-of-four view-change quorum and signed NEW_VIEW.

The wire envelope contains only:

```text
messageType = "PRE_PREPARE"
protocolVersion = "2"
sourceDomain                    decimal uint256 string
sourceGateway                   Ethereum address
epoch                           decimal uint256 string
view                            decimal uint256 string
batchId                         bytes32
messageRoot                     bytes32
primaryIdentity                 Ethereum address
proposalDigest                  bytes32
signature                       65-byte Ethereum signature
```

Integers are transported as canonical decimal strings, never JSON numbers. The authoritative digest is:

```text
PRE_PREPARE_DOMAIN = keccak256(UTF8(
  "PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,address primaryIdentity)"
))

proposalDigest = keccak256(abi.encode(
  PRE_PREPARE_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, primaryIdentity
))
```

The domain identifies the PRE-PREPARE message type and is distinct from handshake, canonical source-message, batch, and Merkle domains. The primary signs the raw 32-byte digest with the existing Ethereum personal-message signing model. The resulting EIP-191 signature is recovered against the same raw digest. JSON formatting/property order, signature bytes, timestamps, endpoints, PIDs, and database record IDs are excluded from the digest.

`POST /pbft/propose` accepts only `{ "batchId": "0x..." }`. The node reads and independently verifies the candidate through the existing source-validation service, requires `CONSENSUS_PENDING`, computes the primary, and refuses to sign when it is a backup or source validation fails. Proposal fields come from that same validated snapshot. The ordinary `/validate-batch` endpoint continues to support both `SEALED` and `CONSENSUS_PENDING`; a `SEALED` snapshot cannot enter the proposal path.

A receiving node checks strict fields, version/type, source context, recomputed digest, configured committee membership, recovered signer, and deterministic primary. First acceptance then independently rechecks canonical Chain A blocks, successful receipts, raw event logs, fixed-head finality, local batch epoch, reconstructed batch ID, and Merkle root. A valid primary signature cannot authorize a wrong root, corrupt source state, or an ineligible lifecycle. The primary coordinates proposals and has no source-truth authority. PostgreSQL remains operational evidence, not authoritative cross-chain truth.

The primary persists its `ISSUED` accepted record before sending to the other three configured peers. Each delivery performs the existing peer handshake and a bounded HTTP PRE-PREPARE request, with a five-second timeout for each call. Delivery failures are reported individually; delivery responses never establish quorum. In replacement views the scheduler retries durable messages and uses certified view transitions to replace stalled primaries. Responses are unsigned `ACCEPTED`/`REJECTED` operational results, never approval votes. Invalid bodies receive HTTP 400; well-formed rejected proposals receive 422; internal database failures return 503 and are not swallowed.

The active database safety key is `(local_validator_identity, epoch, view, protocol_version)`. Transactions, a unique constraint, and immutable-row guards prevent concurrent or sequential proposals from replacing the accepted digest. A completely identical delivery returns the original record without another row. A newly authenticated signature for the same digest also preserves the original stored signature. A different authenticated digest for an already-locked epoch returns `CONFLICTING_PRE_PREPARE` before acceptance. Rejection auditing never consumes that slot. Initial acceptance always requires source validation; an authenticated duplicate returns durable prior acceptance without claiming a new source-validation observation.

Before persistence, a restart can validate and construct the same digest again. After persistence, the primary revalidates the pending candidate and reuses its stored envelope for rebroadcast. Partial delivery retries are idempotent for existing backups and produce first acceptance on previously offline backups. A fresh backup process reads the same safety lock, accepts duplicates idempotently, and still rejects conflicts. Source corruption or an unavailable RPC prevents a new proposal; validators do not repair source history or advance the batch lifecycle.

Accepted PRE-PREPARE alone carries no PREPARE vote, quorum, `COMMITTED` state, or quorum certificate. The source batch stays `CONSENSUS_PENDING`.

### PREPARE votes and local PREPARED state

`POST /pbft/prepare/cast` accepts only a decimal-string `epoch`. The validator loads its immutable accepted PRE-PREPARE and constructs the vote from that record; callers cannot provide a batch, root, proposal digest, or claimed voter. A missing accepted proposal fails closed. Both the deterministic primary and backups follow this same rule.

The canonical envelope is:

```text
messageType = "PREPARE"
protocolVersion = "2"
sourceDomain                    decimal uint256 string
sourceGateway                   Ethereum address
epoch                           decimal uint256 string
view                            decimal uint256 string
batchId                         bytes32
messageRoot                     bytes32
proposalDigest                  accepted PRE-PREPARE digest
voterIdentity                   configured validator address
prepareDigest                   bytes32
signature                       65-byte Ethereum signature
```

The authoritative digest uses the same ABI/Keccak convention as PRE-PREPARE with a separate domain:

```text
PREPARE_DOMAIN = keccak256(UTF8(
  "PBFTPrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,address voterIdentity)"
))

prepareDigest = keccak256(abi.encode(
  PREPARE_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, voterIdentity
))
```

The validator signs the raw digest with its existing Ethereum personal-message key. The receiver recomputes the digest, recovers the signer, requires `recovered signer == voterIdentity`, and checks membership in the static four-address committee. Binding the voter into the digest makes each member's vote cryptographically distinct. Binding the proposal digest, batch ID, root, epoch, and source context prevents votes from being mixed across proposals or protocol contexts. JSON serialization, timestamps, URLs, PIDs, database identifiers, and signatures do not enter the digest.

A validator can cast at most one PREPARE per epoch/view. Its lock check, signature creation, and persistence are serialized in one local transaction. It checks its durable self-vote lock before signing, persists the signed vote, and only then broadcasts to the other three peers through the existing authenticated transport and five-second HTTP bound. A crash before persistence leaves no vote. A crash after persistence reuses the same saved vote on retry. Partial delivery is safe because receivers treat an identical vote idempotently. Delivery responses are operational acknowledgements and carry no additional voting weight.

`POST /pbft/prepare` accepts only the strict signed envelope. The local accepted PRE-PREPARE must already exist, and epoch, batch ID, root, proposal digest, source context, and version must match it exactly. A valid committee signature cannot establish or replace a proposal. A vote arriving before its PRE-PREPARE is rejected and is not buffered. One voter occupies one durable `(local validator, epoch, view, protocol version, voter)` slot. Repeated delivery preserves the original row; a different vote from the same identity and epoch is rejected without replacing it. Rejection evidence remains separate from valid votes.

Prepare quorum is exactly three distinct configured voter identities for one locally accepted proposal. Request count, HTTP responses, signatures without signer recovery, and duplicate rows do not count. Vote insertion, unique-voter counting, and first creation of `PREPARED` occur in one database transaction. Concurrent second/third votes therefore cannot leave a durable three-vote collection without its matching `PREPARED` record. The first three voter identities are saved as immutable quorum evidence. A fourth matching vote is retained while the existing `PREPARED` timestamp and evidence remain unchanged.

`PREPARED` is validator-local and monotonic. One node may be prepared while another has observed only two votes. A fresh process restores the accepted proposal, every observed vote, its own double-vote lock, and existing `PREPARED` state from its isolated namespace. Receiving duplicates, temporary peer loss, or restart cannot return the node to an unprepared state.

`PREPARED` records prepare-level support and permits COMMIT voting. PREPARE processing preserves source tables and leaves the batch `CONSENSUS_PENDING`. A separately verified COMMIT certificate must authorize the lifecycle transition.

### COMMIT votes and Quorum Certificates

`POST /pbft/commit/cast` accepts only `{ "epoch": "..." }`. It reads the accepted proposal and durable local `PREPARED`, rechecks the PRE-PREPARE and PREPARE evidence, and checks the existing self-COMMIT lock before signing. The check, signature creation, vote insertion, and quorum update run under one validator-local database lock. Concurrent casts therefore reuse the same durable vote. Persistence completes before broadcasting to authenticated peers. Operational acknowledgements carry no vote weight.

The COMMIT envelope contains `messageType = "COMMIT"`, `protocolVersion = "2"`, decimal-string `sourceDomain`, `epoch`, and `view`, `sourceGateway`, `batchId`, `messageRoot`, `proposalDigest`, `committeeDigest`, `voterIdentity`, `commitDigest`, and the 65-byte `signature`. Its canonical digest is:

```text
COMMIT_DOMAIN = keccak256(UTF8(
  "PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity)"
))
commitDigest = keccak256(abi.encode(
  COMMIT_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, committeeDigest, voterIdentity
))
```

Committee binding uses the existing canonical ordering of exactly four public addresses:

```text
COMMITTEE_DOMAIN = keccak256(UTF8(
  "PBFTStaticCommittee(uint8 protocolVersion,address[4] validators)"
))
committeeDigest = keccak256(abi.encode(
  COMMITTEE_DOMAIN, uint8(1), address[4](canonicalCommittee)
))
```

Changing peer configuration order or URLs does not change this digest; replacing an identity does. There is no validator-set epoch or historical committee lookup. The receiver recomputes the COMMIT digest and recovers the Ethereum personal-message signer, then requires exact claimed identity, configured membership, committee digest, and accepted proposal context. It must itself be durably `PREPARED`. Early COMMIT is rejected as `NOT_PREPARED` and is not buffered. One signer occupies one immutable vote slot per local validator, epoch, and view. Every local COMMIT lock additionally constrains all later views to the same batch/root. Duplicate votes preserve the first row; conflicts return `CONFLICTING_COMMIT`.

One or two distinct matching COMMIT voters produce no quorum and no QC. The third durable voter atomically creates local `COMMIT_QUORUM` with the first three matching voter identities and QC statement digest. The fourth vote remains available locally without replacing that evidence. `POST /pbft/qc` reconstructs and verifies the certificate from durable votes (an optional decimal-string `view` selects historical evidence); a crash between local quorum and global submission can be recovered by requesting and submitting that QC again.

The QC envelope contains `messageType = "QUORUM_CERTIFICATE"`, the same statement fields through `committeeDigest`, `qcDigest`, and `commits`, an array of three or four complete COMMIT envelopes sorted by voter address. It carries no PREPARE history. Its statement identity excludes signatures and signer subsets:

```text
QC_DOMAIN = keccak256(UTF8(
  "PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest)"
))
qcDigest = keccak256(abi.encode(
  QC_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, committeeDigest
))
```

`verifyQuorumCertificate(certificate, { peers, expected })` is an independent off-chain primitive. It requires an externally configured static committee and expected source/batch context. It derives the deterministic primary's PRE-PREPARE digest, checks every statement field and the QC digest, and independently recomputes and verifies every COMMIT signature. Duplicate signers, unknown members, mismatched fields, malformed signatures, noncanonical ordering, or fewer than three signatures fail closed. Different valid subsets can prove the same `qcDigest`. Prepared and NEW_VIEW evidence also normalize recovered committee identities before uniqueness checks; address casing cannot add quorum weight.

### QC-authorized batch persistence

`createBatchLifecycle({ config, pool, committee })` requires the expected committee for committing or reading committed batches. It never obtains that trust anchor from a submitted certificate. `commitWithCertificate({ certificate })` locks and reconstructs the exact persisted batch, requires `CONSENSUS_PENDING` for first commitment, and verifies the certificate against its source scope, epoch, batch ID, root, deterministic proposal, and expected committee. The caller submitting a QC needs no trusted identity.

Migration `006_pbft_commit.sql` adds `batch_quorum_certificates` and `batch_quorum_certificate_signatures`. The header binds the statement; child rows retain each signer, recomputable COMMIT digest, and signature with unique signer constraints. Certificate insertion, signature insertion, and the batch's `COMMITTED` transition occur in one transaction. Database guards preserve sealed membership, enforce terminal status, reject updates without matching complete certificate evidence, and reject a certificate left without its committed batch at transaction completion. Cryptographic verification belongs to application code; SQL constraints provide structural guarantees.

The normal integration verifies the fourth COMMIT, duplicates and conflicts before global submission. Once finalized, new votes are rejected and durable self-vote/QC retries preserve the existing result. The first valid global QC remains immutable. Repeated submission of the same certificate, another valid three-signer subset, or four signatures for the same statement returns the original batch and certificate. Concurrent submissions lock the same batch and converge on that result. A conflicting or forged QC cannot replace it. Any failure before transaction completion rolls back the certificate, signatures, status, and commit timestamp together.

Every `COMMITTED` snapshot read reconstructs the immutable batch and Merkle tree, loads its stored QC evidence, and repeats independent certificate verification against the expected committee. Missing evidence, corrupted signatures, or context drift fails closed. PostgreSQL remains operational persistence and supplies no cryptographic authority by itself. Source messages, finality records, canonical blocks, cursor, membership, and existing proofs remain unchanged; later messages continue into subsequent batch epochs.

This implementation supplies COMMIT/QC authorization for a static committee. The verification infrastructure exercises the failure model below. Committee rotation, delivery queues, relaying, destination QC verification, and destination execution remain unsupported.

### Consensus safety and failure model

The committee has `n = 4`, fault bound `f = 1`, and PREPARE/COMMIT quorum `3`. Voter identities come from recovered signatures and configured committee membership. One or two signers cannot produce a valid QC. A conflicting vote adds no support to the accepted proposal and cannot cancel three matching honest votes. The primary coordinates proposal delivery; its signature alone supplies no authority over source truth or commitment.

With an honest, available deterministic primary and one unavailable non-primary validator, the remaining three processes can validate the same real batch, reach `PREPARED`, exchange COMMITs, produce a three-signature QC, and commit. Verification selects the unavailable backup dynamically from the batch epoch, stops its OS process, checks its endpoint and PID, and requires the QC signer set to contain exactly the three live identities. The restarted backup verifies the global committed QC through the existing certificate path. It does not claim PREPARE or COMMIT votes that it never cast, and no new catch-up protocol is introduced.

With an honest primary and one adversarial backup, three honest validators can commit the canonical root. A test-only adversarial builder uses a committee development key to sign deterministic conflicting contents. Valid signatures on a wrong-primary PRE-PREPARE, wrong-root PREPARE, or wrong-root COMMIT must still be rejected. A single adversarial signature, duplicate evidence, or canonical signatures reused for a conflicting statement cannot form a conflicting QC. Durable queries require at most one committed root per source scope and epoch and no conflicting persisted certificate. These scenarios do not establish progress when the primary itself is Byzantine or unresponsive.

During a bidirectional 2|2 partition, all four processes remain alive, but each side can observe only its own two PREPARE voters. Neither side reaches `PREPARED`, can legitimately cast COMMIT, or can form a QC; the batch stays pending. The test activates the partition only after all nodes have accepted PRE-PREPARE and before any PREPARE vote exists. Removing the gate changes delivery policy only. Explicit retries rebroadcast the exact saved envelopes and continue the same epoch, batch ID, root, proposal digest, committee, and deterministic primary. The database, vote locks, and process identities are not reset. Progress resumes under restored connectivity with the primary still available.

An unavailable or unresponsive primary can be replaced after a valid three-of-four view-change quorum. Until NEW_VIEW is independently verified and persisted, backups cannot impersonate the primary or promote themselves. Under restored connectivity an available replacement resumes the same safe batch/root. A 2|2 partition cannot form that quorum; arbitrary network failures do not guarantee progress.

Fault injection belongs exclusively to verification helpers. Each directed peer edge has a test proxy, so sender identity for a block rule comes from the configured edge rather than message fields. Rules block delivery without changing protocol bytes, signatures, or digests. There is no production Byzantine mode, partition administrator API, fault database table, or fault input to protocol hashing. Explicit process-stop boundaries, completed requests, durable checkpoints, and controlled retries determine the scenarios; random drops and timing-based success assumptions are unnecessary.

Every scenario uses an independent source schema with the existing migrations and a fresh set of validator namespaces. The real Indexer rescans canonical Chain A events, the real Finality Watcher establishes eligibility, and the production lifecycle creates a new pending A/B/D batch. Validators independently fetch the real source receipts and blocks. The original committed batch, QC, `REORGED` C occurrence, next-epoch Message E, cursor, and canonical history remain unchanged. Source writes within each fault instance are restricted to the authorized QC/status transition.

### View changes and primary recovery

Normal flow is `CONSENSUS_PENDING → PRE-PREPARE → PREPARE → PREPARED → COMMIT → QC → COMMITTED` in an explicit view. Failure recovery is `progress timeout → VIEW_CHANGE → three-of-four quorum → NEW_VIEW → safe proposal → consensus in the next view`.

`PBFT_VIEW_TIMEOUT_MS` defaults to 30000 and accepts a positive integer up to 2147483647. It is independent of the five-second HTTP timeout. A serialized scheduler discovers independently validated pending batches, restores durable view state on restart, and resets deadlines on new accepted proposals, votes, or NEW_VIEW. Duplicate deliveries do not extend deadlines. Timeout pauses local old-view voting and persists one signed VIEW_CHANGE for the next target. Active `current_view` and pending `target_view` are separate: failure to publish NEW_VIEW does not activate that target, and another full timeout can increment the durable target by one. Each target retains its own immutable signed intent; retries and the first replay after restart reuse it exactly. A valid higher-target NEW_VIEW with three distinct authenticated votes can activate that certified view directly. One caller or one vote cannot change the active view.

VIEW_CHANGE binds version 2, its independent `PBFTViewChange` domain, source context, epoch, target view, sender, accepted proposal digest, and prepared-certificate digest. It includes the complete accepted signed proposal when present and the highest durable Prepared Certificate when PREPARED. That certificate carries the signed PRE-PREPARE and three or four matching signed PREPARE envelopes sorted by committee identity. It is independently verified and is distinct from a final COMMIT QC.

NEW_VIEW binds version 2, its independent `PBFTNewView` domain, source context, epoch, target view, deterministic primary, selected batch/root, and the canonical array of VIEW_CHANGE digests. It includes three or four distinct authenticated VIEW_CHANGE messages. Every backup verifies all nested evidence and independently selects the proposal at the highest prepared view. Conflicts at the same highest view fail closed. Without prepared evidence, selection requires the independently validated canonical pending batch. The new primary also revalidates the immutable candidate against a fresh fixed Chain A head; the head need not equal an earlier observation.

The primary persists NEW_VIEW before broadcasting it. Acceptance atomically stores evidence and advances the active view to the quorum-certified target; current view never decreases. A pending target is retained if it is already higher, so receiving older certified recovery evidence cannot undo a later local intent. There is no administrative set-view or force-primary endpoint. Historical votes remain immutable. Prepared history and local COMMIT locks constrain subsequent views to the safe batch/root. Old-view votes cannot count toward a new-view quorum. A valid older-view QC retains finality, ends timeout processing, and prevents conflicting commitment. Equivalent certificates from later views preserve the first final certificate.

Before opening HTTP or reporting readiness, each validator completes initial pending-batch discovery, independent source validation, and local epoch registration. Discovery does not schedule timeouts, cast votes, or broadcast; existing durable views and safety evidence are retained. Startup storage failures propagate before the endpoint opens. The four-process verification captures these initialized observations as each node's baseline, then checks that explicit validation still performs independent RPC reads, remains idempotent, and leaves every other validator's baseline unchanged.

After the listener opens, the scheduler retransmits each node's latest issued NEW_VIEW independently of whether it is waiting for another view. This lets a lagging peer recover after temporary delivery loss. It drives proposal/PREPARE/COMMIT/QC in active replacement views; view-zero initiation retains explicit proposal/cast interfaces. Timeout writes compare the original active view, target and durable progress revision under the metadata lock. A superseded timer cannot sign for a fresh view or erase new progress. The revision and timeout timestamps are operational state and never enter message IDs, batch IDs, roots or signatures.

If another node commits between discovery and a pending-batch check, the existing lifecycle reader independently verifies the final QC and the local epoch is finalized. Corrupted or missing evidence still fails closed; ordinary COMMITTED convergence does not halt the scheduler. Recognizing a final QC never fabricates an accepted NEW_VIEW or forces local current view to equal the certificate's signing view. Storage or integrity failures remain fatal to scheduling and readiness.

Additional routes are `POST /pbft/view-change`, `POST /pbft/new-view`, and read-only `GET /pbft/views`. Strict nested fields, exact integers, and evidence arrays bounded by the four-member committee are required. Request size is limited to 64 KiB.

`validator/migrations/005_view_change.sql` retains old consensus rows as version-one view-zero history, including original signatures and digests, and adds view-bound locks, intents and NEW_VIEW evidence. Active consensus uses version 2; old signatures are never relabeled or counted as new-version votes. Historical version-one prepared/QC evidence uses the original encoding. `validator/migrations/006_view_recovery.sql` adds durable pending targets, intent deadlines and progress revisions, backfills existing intents, and preserves the prior migrations. `indexer/migrations/007_view_bound_qc.sql` stores QC view metadata and admits versions 1 and 2 without changing source messages, batch commitments, members or roots. Foundation identity/handshake and static committee encoding remain version 1.

Verification preserves the earlier fault cases and independently reindexes real A/B/D for primary crashes before proposal, after proposal, after two PREPAREs, after PREPARED, and after two COMMITs. It restarts a sender after VIEW_CHANGE persistence, checks exact intent recovery, rejects a correctly signed unsafe NEW_VIEW, and checks old-view replay rejection. A repeated-failure case stalls replacement-primary proposal delivery using verification-only route gates, returns the original process to maintain the fault bound, and advances through views 1 and 2. Additional real-process cases delay NEW_VIEW delivery past a timeout and stop the candidate primary before it can publish NEW_VIEW, with at most one process offline at a time. The unavailable-candidate case requires a real quorum to activate view 2. The delayed-delivery case requires the exact original NEW_VIEW to be replayed after its primary has timed out, then heals transport and requires an independently verified three-signer QC from view 2 or later. Timers continue advancing pending targets during the delivery outage, so this case does not require every node to stop at view 2. Each final QC signer must retain independently verifiable NEW_VIEW evidence for its signing view. Verification-only COMMIT delivery gates establish an explicit all-node NEW_VIEW checkpoint in cases that require everyone to enter a particular view. General finality checks instead compare the independently verified final certificate and batch/root. All cases require one durable committed root and preserve original REORGED C, Message E, source history, membership and proofs.

### Configuration

`validator/.env.example` documents one process's operator configuration. Real keys and database passwords belong only in an ignored `.env` or process environment. Required values include `VALIDATOR_PRIVATE_KEY`, listen host/port, `VALIDATOR_DATABASE_URL`/`VALIDATOR_DB_SCHEMA`, `SOURCE_DATABASE_URL`/`SOURCE_DB_SCHEMA`, Chain A RPC/domain, deployed SourceGateway, finality depth, and `VALIDATOR_PEERS` as four `{ address, url }` entries including self. The self endpoint must match the listen configuration; duplicate addresses/endpoints and malformed or incomplete sets fail early.

Source and local state may use the same PostgreSQL server, but must use distinct schemas or databases. A validator never shares writable local state with another validator. Schema identifiers are validated and queries carrying network references are parameterized. Source validation and PREPARE/COMMIT vote processing perform no source-row writes. The dedicated QC authority writes only certificate evidence and the pending batch's status/commit timestamp. Validators do not apply Indexer migrations at startup or repair source history.

Complete verification continues to load the root `.env`. Its development validators use the existing `DATABASE_URL` with four isolated schemas by default. `VALIDATOR_VERIFICATION_DATABASE_URL` optionally selects another already-prepared local database. No additional password or permanent validator-key configuration is required for this development verification flow.

### Verification and recovery

Unit tests cover configuration, independent identities, domain-separated handshakes, bounded HTTP inputs, exact large-integer finality, fixed-head source checks, raw-log mutations, and malformed snapshots. Database tests use four distinct namespaces and cover identity binding, isolation, rerunnable migration, immutable observations, conflicting snapshot rejection, and recovery through fresh pools.

The existing real integration preserves A/B/D finalization, C reorganization, sealed Solidity proofs, and E rollover, then starts V1–V4 as four real processes. Test-only RPC forwarding observers record each process's actual Chain A requests without changing their responses. Every validator must independently fetch receipts, use one latest-head snapshot per pass, reconstruct the pending batch, and persist its own observation. All directed peer pairs authenticate.

The flow stops V4 and verifies that V1/V2/V3 remain alive with unchanged state, rejects a different key opening V4's store, and starts a fresh V4 process that recovers its observation and validates idempotently. Corrupt root/block and injected `REORGED` cases use isolated copies of real source data, never the original source tables. Separate negative profiles cover insufficient RPC depth, wrong chain, and missing Gateway bytecode. The complete original source rows, cursor, canonical blocks, batch statuses, and membership are compared before and after validator operations.

PRE-PREPARE unit tests add canonical committee permutations, exact uint256 rotation, field/digest/signature mutations, lifecycle/context checks, source corruption, and persistence/broadcast crash boundaries. Database tests cover issued/accepted recovery, rerunnable migration, committee binding, concurrent duplicates/conflicts, immutable locks, and rejection isolation.

PREPARE unit tests cover its independent domain and canonical encoding, signer recovery, exact accepted-proposal matching, pre-PREPARE arrival, self-vote persistence before broadcast, durable double-vote prevention, unique-voter counting, duplicate/conflicting votes, and the one/two/three/four-vote thresholds. Database tests add concurrent duplicate delivery, concurrent second/third voters, atomic `PREPARED` creation, immutable vote/quorum rows, rejection isolation, migration reruns, and fresh-pool recovery.

PREPARE state reads hold the validator metadata row with a shared lock for the transaction, matching the exclusive lock used by vote writers. Votes and the associated `PREPARED` evidence therefore describe one consistent state. A deterministic database test pauses a read after loading two votes, starts a third-vote writer at its lock boundary, and verifies that the read sees the old complete state before the writer creates the new complete state.

The same four-process flow uses a different peer ordering on each node and verifies that all select the same actual primary. It rejects non-primary proposals, malformed signatures, unknown references, wrong epochs, and primary-signed wrong roots before the canonical proposal. A deliberately stopped backup makes the first broadcast partial at a known boundary. The primary then restarts, the backup returns, and the same stored proposal is rebroadcast. Concurrent duplicate delivery, a fresh backup restart, and correctly signed conflicts preserve each node's original record. Fresh isolated source profiles exercise `SEALED`, corrupt roots/blocks, `REORGED` members, and insufficient depth without masking failures behind existing locks. Final assertions compare the original source tables and reject an unauthorized `COMMITTED` transition. These checks do not assert Byzantine consensus completion.

After all four processes hold the canonical PRE-PREPARE, the integration stops one receiver, casts and persists the first PREPARE, restarts the voter and receiver, and rebroadcasts the same vote. Two unique voters leave every node unprepared despite repeated delivery. The third distinct vote atomically produces four independent local `PREPARED` records. A valid wrong-root vote and a later conflicting vote from the fourth validator are excluded without removing the existing three-vote state. The canonical fourth vote is retained without rewriting the earlier quorum evidence. A fresh validator process recovers its accepted proposal, four votes, self-vote lock, and `PREPARED` record. Source tables remain byte-for-byte equivalent and an unauthorized `COMMITTED` transition still fails.

COMMIT/QC unit tests cover the independent domains, exact uint256 encoding, committee permutations, recovered signer/context checks, canonical evidence ordering, valid three/four-signature certificates, equivalent subsets, and malformed or forged evidence. Validator database tests cover the durable `PREPARED` gate, concurrent self-casts signing once, duplicate and conflicting votes, quorum persistence, lost responses, and fresh-pool recovery. Source database tests cover concurrent equivalent QCs, rollback after evidence insertion, immutable committed snapshots, and corrupted-certificate rejection.

The same four processes then cast real COMMIT votes. Early casts before `PREPARED` fail. A bounded partial broadcast is retried after restarting the sender and receiver. Two voters leave the real A/B/D batch pending; the third creates independently verified local QCs. A restart before global submission reconstructs the same QC. Invalid certificates and an injected source transaction failure preserve pending state with no certificate rows. Concurrent submissions commit once. A fourth COMMIT, duplicate delivery, conflicting vote, equivalent signer subset, and another restart preserve the first global certificate. A fresh source-reader process reconstructs the committed snapshot and independently verifies its stored QC. Source history and the next-epoch Message E batch remain unchanged.

The normal integration is followed by isolated real-process crash, adversarial-backup, partition/heal, and primary-failure scenarios. Transport unit tests cover directional blocking, both partition directions, same-group delivery, healing, unchanged signed wire bytes, and stale-signature exclusion. The fault integration queries persisted signer sets, QC evidence, batch status, and distinct committed roots rather than treating delivery acknowledgements as consensus.

Normal and fault integrations share one process helper for startup, stop, restart, endpoint queries, signal handling, and the owned PID registry. Fault-scenario cleanup waits for the created validators to exit before closing transport/RPC proxies and port reservations, then closes database pools. RPC remains available while pending validator ticks finish. Recovery failures report each node's active view, pending target, progress revision, finalized state, quorum targets, signer sets, and source status before cleanup; a cleanup failure cannot replace the original recovery failure. The root script retains fallback cleanup and never targets unrelated user processes. The claimed safety/liveness boundaries are limited to the explicit static-committee scenarios described above.

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

Chain A hosts the generated Groth16 verifier, its credential adapter, `IdentityApplicationA`, and `SourceGateway` during complete verification. Chain B verifies the two-chain environment and supplies the destination domain. The destination gateway and receiver used by source messages are explicit message inputs; no destination protocol endpoint or receiver is deployed to Chain B.

## Prerequisites

Install these tools before using the repository:

- Bash;
- Foundry, including `forge`, `cast`, and `anvil`;
- Circom 2;
- Node.js 22 or later;
- npm;
- Python 3;
- PostgreSQL with a disposable or local project database.

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
psql --version
```

Foundry and Circom are system tools and are not installed by the verification scripts:

- [Foundry installation](https://getfoundry.sh/introduction/installation/)
- [Circom 2 installation](https://docs.circom.io/getting-started/installation/)

The ZK JavaScript dependencies are pinned in `zk/package.json` and `zk/package-lock.json`:

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

cd indexer
npm ci
cd ..

cd validator
npm ci
cd ..
```

The Indexer and validator packages both pin `viem` to `2.56.9` and `pg` to `8.23.1`, with lockfiles for clean installations. The validator adds no HTTP framework or new cryptographic dependency. Package preparation is an external prerequisite; verification never installs dependencies.

PostgreSQL installation and database creation remain external prerequisites. Project scripts check connectivity and apply the project migration, but they do not install or start PostgreSQL and do not create a database.

The unified verification script automatically loads local configuration from the repository-root `.env` file. Copy the structure from `.env.example`, set the local PostgreSQL password in `.env`, and keep the example file free of real credentials. The local `.env` file is excluded from source control and its values are not printed by the verification script.

The Python credential-model checker uses only the standard library, so the repository does not need a `requirements.txt` file.

## Build and Test

### Solidity

The Solidity build depends on verifier and proof-fixture source generated from the current Groth16 zkey and proof, plus the canonical message fixture generated from the shared vectors. Generate those files first:

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

### Chain A Indexer, Finality Watcher, Message Batches, Merkle Commitments, and Lifecycle

Run the Indexer unit suite after installing its packages:

```bash
cd indexer
npm test
```

Run the PostgreSQL tests against a disposable or local project database:

```bash
export DATABASE_URL='postgresql://<user>:<password>@127.0.0.1/<database>'
export INDEXER_DB_SCHEMA='cross_chain_indexer_database_test'
npm run test:database
```

The unit suite also covers batch ABI encoding, canonical ordering under input permutations, explicit epochs, membership changes, duplicate rejection, malformed messages, invalid lifecycle states, and large protocol integers. Merkle tests cover batch integrity, distinct hash domains, ordered pairs, single-leaf and odd-node behavior, deterministic roots and proofs, successful inclusion, and rejected message/context/root/path changes. PostgreSQL tests connect the existing finalized-only query to the production batcher, construct a stable tree and verify its proofs, check insertion-order independence and duplicate rescans, and verify that computation preserves all source lifecycle metadata and canonical block records.

The real Chain A integration runs through the unified repository verification flow because it needs the deployed protocol contracts and both local chains. It covers fixed-snapshot indexing, abrupt worker termination after durable commits, offline message catch-up, PostgreSQL pool recreation, repeated restarts, exact-event rescans, real `OBSERVED → FINALIZING → FINALIZED` transitions, eventless block tracking, and snapshot/revert replacement of an unfinalized branch followed by a fresh Indexer process. It then constructs and seals a batch from finalized A/B/D, excludes the reorged C occurrence, builds the Message Root, and verifies all three inclusion proofs off-chain and through the Solidity library in Foundry's local EVM. Fresh processes restore sealed and pending snapshots. A later real Message E is finalized and assigned to the next epoch while old membership, roots, and proofs remain unchanged. Changed messages and wrong roots/proofs fail, and batch operations preserve source lifecycle state.

## Complete Verification

Run the unified verification script from the repository root:

```bash
./scripts/verify.sh
```

The script uses strict error handling and performs:

1. Node.js and Indexer dependency checks without automatic installation;
2. PostgreSQL connectivity, ordered migrations, unit tests, and database transaction tests;
3. deterministic pre-commit failure injection proving that message, block, and cursor writes roll back together;
4. closed-client rejection followed by fresh-pool recovery of cursor, canonical history, and terminal lifecycle state;
5. local-chain availability and chain ID checks;
6. selection of a proof timestamp relative to the current Chain A block;
7. credential model, fixture, and state-tree configuration validation;
8. deterministic active-state construction, nullifier generation, and ZK circuit verification;
9. Solidity verifier, proof-fixture, and canonical message fixture generation;
10. Solidity formatting, build, and tests against the real generated verifier;
11. focused canonical-message, credential-verifier, and identity-application tests;
12. deployment of the generated verifier, credential adapter, source gateway, and identity application to Chain A;
13. explicit authorization of the deployed identity application by the configured Gateway administrator;
14. valid and rejected credential-proof, policy, nullifier, epoch, and revocation cases;
15. canonical type-hash and source/destination domain and gateway separation checks;
16. registry administration, unknown caller, destination, deadline, revocation, nonce, and reauthorization cases;
17. real `IdentityApplicationA → SourceGateway` message creation and event decoding;
18. abrupt Indexer termination after a durable message and cursor commit;
19. fresh PostgreSQL client recovery of the committed message, cursor, and source blocks;
20. discovery of a message emitted while the Indexer is offline;
21. repeated Indexer restarts without duplicate messages or canonical-block changes;
22. abrupt Finality Watcher termination after persisting `FINALIZING`;
23. watcher restart and exact-boundary transition to `FINALIZED` using one fixed head;
24. exclusion of `OBSERVED`, `FINALIZING`, and `REORGED` rows from future batch eligibility;
25. terminal `FINALIZED` stability across another watcher process;
26. deliberate real-block rescan that preserves one row and all lifecycle metadata;
27. independent finalization of a later message at its own depth boundary;
28. canonical metadata persistence for event-bearing and eventless source blocks;
29. real Anvil snapshot/revert branch replacement;
30. common-ancestor discovery by the Finality Watcher before lifecycle advancement;
31. atomic `REORGED` classification, canonical-history deletion, and cursor rewind;
32. new Indexer process recovery from the rewound cursor;
33. replacement-branch finalization while the orphaned occurrence remains terminal and ineligible;
34. deterministic batch unit tests for encoding, epochs, permutations, membership changes, and fail-closed inputs;
35. database-backed batch construction with only `FINALIZED` membership, duplicate-ingestion stability, and unchanged lifecycle metadata;
36. a real finalized-message batch containing Message A, B, and D while excluding old `REORGED` Message C;
37. repeated construction and fresh-builder reconstruction with identical ordered membership and batch ID;
38. batch integrity validation and deterministic Merkle leaves, ordered nodes, roots, and proofs;
39. single-leaf, odd-layer duplication, safe-index, and malformed-input cases;
40. real finalized A/B/D inclusion proofs against one Message Root;
41. rejection of changed real messages, wrong roots, wrong proofs, and old `REORGED` C;
42. fresh-builder reconstruction of identical roots and proofs with all source state preserved;
43. durable building records, exclusive finalized-occurrence assignment, and exact epoch advancement;
44. atomic sealing and immutable commitments, counts, and canonical member positions;
45. deterministic partial-seal failure injection and retry after complete rollback;
46. competing creation, collection, and sealing clients synchronized at explicit database lock barriers;
47. fresh-process recovery of identical sealed and consensus-pending snapshots;
48. rejection of premature `COMMITTED` transitions through ordinary SQL and APIs;
49. finalization of a new real Message E, assignment to the next epoch, and unchanged old inclusion proofs;
50. byte-for-byte Merkle golden fixture drift checks without overwriting fixed expected outputs;
51. Node and Solidity comparisons against the same committed domains, leaves, internal nodes, roots, and proofs;
52. shared-fixture negative cases, trusted leaf-count checks, and hash/encoding drift probes;
53. real fresh-process sealed A/B/D proofs verified in Foundry's local Solidity EVM;
54. validator identity, configuration, handshake, HTTP, and independent source-validation unit tests;
55. validator-owned migrations and four isolated identity-bound state-store tests;
56. four real validator processes, distinct public identities/PIDs, and all directed peer handshakes;
57. each validator's recorded real RPC receipt/block requests and fixed-head finality checks;
58. immutable local observations and same-head idempotent validation of the real pending A/B/D batch;
59. wrong-reference/root/block, `REORGED` injection, insufficient depth, wrong chain/Gateway, and wrong-key rejection;
60. fresh V4 recovery with V1/V2/V3 unaffected and complete original source-state preservation;
61. canonical committee ordering, exact deterministic primary rotation, and domain-separated proposal signatures;
62. durable issued/accepted epoch slots, concurrent duplicates/conflicts, rejection isolation, and migration retries;
63. a real primary-signed A/B/D PRE-PREPARE with independent backup RPC reconstruction;
64. wrong-primary/signature/epoch/reference/root/lifecycle/source rejection and unchanged source state;
65. controlled partial broadcast, fresh primary/backup recovery, and idempotent retry of the stored proposal;
66. four matching isolated PRE-PREPARE records with the batch still pending;
67. domain-separated PREPARE encoding, signatures, accepted-proposal binding, and durable self-vote locks;
68. one/two/three/four unique-voter thresholds, duplicate exclusion, and atomic local `PREPARED` creation;
69. wrong signer/context/epoch/batch/root/proposal rejection and conflicting-voter lock preservation;
70. a controlled partial PREPARE broadcast followed by voter/receiver restart and idempotent recovery;
71. four isolated durable vote collections and `PREPARED` records with source state unchanged;
72. continued rejection of `COMMITTED` without COMMIT votes, commit quorum, or a quorum certificate.
73. COMMIT and static-committee ABI domains, signer recovery, and exact source/proposal binding;
74. durable `PREPARED` prerequisites, one self-COMMIT per epoch/view, and concurrent casts signing once;
75. one/two/three/four distinct COMMIT counts with duplicate/conflict exclusion;
76. canonical three/four-signature QC construction and independent verification;
77. rejection of insufficient, duplicate, unknown, tampered, wrong-context, and wrong-committee evidence;
78. atomic QC/signature persistence with the real pending batch's `COMMITTED` transition;
79. deterministic transaction rollback and concurrent same/equivalent certificate retries;
80. immutable first certificate after a fourth vote and another valid signer subset;
81. fresh validator and source-reader recovery of COMMIT locks, quorum, and verified committed snapshots;
82. unchanged source history, membership, root, proofs, and next-epoch Message E after commitment.
83. deterministic directional peer proxies, symmetric cross-group blocking, and byte-preserving healing;
84. an explicit database read/write barrier preventing mixed PREPARE and PREPARED snapshots;
85. independently migrated and reindexed real A/B/D batches for each fault instance;
86. one dynamically selected non-primary process offline while exactly three live identities form QC and commit;
87. offline backup restart and independent committed-certificate verification without fabricated history;
88. cryptographically valid Byzantine conflicting messages and forged QCs excluded from honest quorum weight;
89. durable proof of at most one committed root per source scope/epoch and no conflicting persisted QC;
90. four live processes in a 2|2 partition with exactly two voters each, no PREPARED, no QC, and pending batch state;
91. explicit healing and retries of saved votes completing the same epoch, root, proposal, primary, and process identities;
92. primary process failure preserving safety before certified replacement;
93. unchanged original source history, REORGED C, committed QC, immutable membership, and next-epoch Message E;
94. exact view-bound signatures and deterministic primary rotation;
95. independently verified prepared certificates, VIEW_CHANGE quorum, and safe NEW_VIEW selection;
96. real primary crashes before proposal, after proposal, partial PREPARE, PREPARED, and partial COMMIT;
97. restart recovery of persisted VIEW_CHANGE, NEW_VIEW, current view, and historical locks;
98. unsafe new-primary proposal and old/future-view vote rejection;
99. repeated primary failure/stall through views 1 and 2 without changing batch identity;
100. preserved historical version-one evidence and at most one committed root across views;
101. obsolete fixture schema rebuild, repeated rebuilds and rollback without source mutation;
102. normalized signer uniqueness including checksummed/uppercase duplicates;
103. superseded timeout suppression using an explicit database concurrency barrier;
104. durable target escalation with an unpublished candidate primary and certified higher-view activation;
105. exact lost NEW_VIEW replay after timeout, followed by a three-signer view-2-or-later QC with retained signing-view evidence;
106. fourth-vote checks before finality and explicit view-entry checkpoints where required;
107. validator-before-RPC shutdown ordering, cleanup failure propagation, and recovery diagnostics before resource cleanup.

`DATABASE_URL` is required and should point to a database intended for local verification. The flow uses project-owned schemas and tables; it does not drop a database or reset the `public` schema. It does not install PostgreSQL, create a database, install npm packages, or generate an Indexer lockfile.

If neither configured RPC endpoint is running, the script starts both chains through `scripts/start-chains.sh` and stops the processes it created when verification ends. If both chains already exist with the expected chain IDs, the script reuses them and leaves them running.

The validator integration applies existing migrations explicitly, chooses temporary local ports, injects runtime development keys, and cleans up its own processes and proxies. It preserves the complete normal consensus flow, then runs four isolated fault instances with fresh source/validator namespaces and real Chain A reconstruction. Test-owned namespaces are reset only during scenario preparation. The seven mutable negative-fixture tables are transactionally recreated from current source definitions and copied with explicit column lists; leftover older schemas cannot retain obsolete QC columns or checks. Fixture rebuild failures roll back, and production source data and triggers are unchanged. Healing and restart recovery retain their durable state. No production validator store is reset.

All stdout and stderr are displayed in the terminal and written to:

```text
verification.log
```

Each run replaces the previous `verification.log`. A successful run ends with:

```text
VERIFICATION PASSED
PBFT View Change
```

### Expected error output

Complete verification intentionally executes negative cases, so a passing log can contain:

```text
Error: execution reverted: InvalidDestinationDomain
Error: execution reverted: InvalidDestinationGateway
Error: execution reverted: InvalidDestinationReceiver
Error: execution reverted: InvalidDeadline
Error: execution reverted: UnauthorizedAuthorizationAdmin
Error: execution reverted: InvalidSourceApplication
Error: execution reverted: UnauthorizedSourceApplication
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
EXPECTED FAILURE: closed PostgreSQL client rejected a new operation
```

These messages demonstrate that the contracts reject unauthorized source applications, invalid destinations and deadlines, the circuit rejects invalid witnesses, a proof cannot be reused with a tampered public input, the identity application enforces policy, freshness, context-bound replay protection, state-root authority, and revocation, and a closed PostgreSQL client cannot be treated as a successful operation. Each expected failure is followed by `Verified rejection`, `EXPECTED FAILURE`, or `Verified expected ... rejection`. Complete verification succeeds only when the script exits with code `0` and the log ends with `VERIFICATION PASSED`.

The on-chain negative cases normally return `false` and are reported as `Verified expected on-chain rejection`. A successful result for any modified proof or public policy value fails the complete verification.

## Repository Layout

```text
Cross-Chain/
├── .env.example
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
│   │   ├── MessageMerkle.sol
│   │   └── SourceGateway.sol
│   └── test/
│       ├── CredentialVerifier.t.sol
│       ├── IdentityApplicationA.t.sol
│       ├── MessageMerkle.t.sol
│       ├── mocks/
│       │   ├── MockCredentialVerifier.sol
│       │   ├── MockSourceApplication.sol
│       │   └── MockSourceGateway.sol
│       └── SourceGateway.t.sol
├── indexer/
│   ├── migrations/
│   │   ├── 001_chain_a_indexer.sql
│   │   ├── 002_idempotent_event_ingestion.sql
│   │   ├── 003_finality_watcher.sql
│   │   ├── 004_source_reorg_detection.sql
│   │   ├── 005_batch_lifecycle.sql
│   │   ├── 006_pbft_commit.sql
│   │   └── 007_view_bound_qc.sql
│   ├── scripts/
│   │   └── generate-merkle-golden-vectors.mjs
│   ├── src/
│   │   ├── batch-lifecycle-policy.mjs
│   │   ├── batch-lifecycle.mjs
│   │   ├── canonical-block.mjs
│   │   ├── canonical-message.mjs
│   │   ├── check-database.mjs
│   │   ├── config.mjs
│   │   ├── db.mjs
│   │   ├── finality-policy.mjs
│   │   ├── finality-watcher.mjs
│   │   ├── indexer.mjs
│   │   ├── main.mjs
│   │   ├── message-batch.mjs
│   │   ├── message-merkle.mjs
│   │   ├── migrate.mjs
│   │   ├── reorg-detector.mjs
│   │   ├── source-event-identity.mjs
│   │   └── source-gateway-event.mjs
│   ├── test/
│   │   ├── batch-lifecycle-policy.test.mjs
│   │   ├── batch-lifecycle.database.test.mjs
│   │   ├── canonical-block.test.mjs
│   │   ├── canonical-message.test.mjs
│   │   ├── config.test.mjs
│   │   ├── database.test.mjs
│   │   ├── finality-policy.test.mjs
│   │   ├── finality-watcher.test.mjs
│   │   ├── helpers/
│   │   │   └── read-batch-lifecycle.mjs
│   │   ├── indexer.test.mjs
│   │   ├── integration.test.mjs
│   │   ├── message-batch.test.mjs
│   │   ├── message-merkle.test.mjs
│   │   ├── message-merkle-golden.test.mjs
│   │   ├── reorg-detector.test.mjs
│   │   └── source-event-identity.test.mjs
│   ├── package.json
│   └── package-lock.json
├── scripts/
│   ├── build-canonical-message-vector.mjs
│   ├── deploy-verifier.sh
│   ├── start-chains.sh
│   └── verify.sh
├── test-vectors/
│   ├── canonical-messages.json
│   ├── merkle-golden-vectors.json
│   └── nullifiers.json
├── validator/
│   ├── .env.example
│   ├── migrations/
│   │   ├── 001_validator_foundation.sql
│   │   ├── 002_pre_prepare.sql
│   │   ├── 003_prepare.sql
│   │   ├── 004_commit_and_qc.sql
│   │   ├── 005_view_change.sql
│   │   └── 006_view_recovery.sql
│   ├── src/
│   │   ├── committee.mjs
│   │   ├── commit.mjs
│   │   ├── commit-service.mjs
│   │   ├── config.mjs
│   │   ├── db.mjs
│   │   ├── handshake.mjs
│   │   ├── identity.mjs
│   │   ├── main.mjs
│   │   ├── migrate.mjs
│   │   ├── pre-prepare.mjs
│   │   ├── pre-prepare-service.mjs
│   │   ├── prepare.mjs
│   │   ├── prepare-service.mjs
│   │   ├── quorum-certificate.mjs
│   │   ├── server.mjs
│   │   ├── source-validation.mjs
│   │   ├── protocol.mjs
│   │   ├── prepared-certificate.mjs
│   │   ├── view-change.mjs
│   │   ├── view-change-service.mjs
│   │   └── consensus-runtime.mjs
│   ├── test/
│   │   ├── view-change.test.mjs
│   │   ├── commit.test.mjs
│   │   ├── config.test.mjs
│   │   ├── database.test.mjs
│   │   ├── handshake.test.mjs
│   │   ├── fault-transport.test.mjs
│   │   ├── pre-prepare.test.mjs
│   │   ├── prepare.test.mjs
│   │   ├── server.test.mjs
│   │   ├── source-validation.test.mjs
│   │   └── helpers/
│   │       ├── commit-fixtures.mjs
│   │       ├── fault-transport.mjs
│   │       ├── fault-scenarios.mjs
│   │       ├── fixtures.mjs
│   │       ├── four-process.mjs
│   │       ├── process-cluster.mjs
│   │       └── view-change-scenarios.mjs
│   ├── package.json
│   └── package-lock.json
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
- `SourceGateway` admits only explicitly authorized application contracts and records the direct application caller as `sourceSender`.
- Source-application authorization is administered by one immutable address. The local deployment uses an explicit development account; production use requires an appropriate governance and key-management design.
- Registry authorization does not authenticate the EOA calling an authorized application. Each application remains responsible for its own caller and business-policy checks.
- Gateway revocation affects future message creation only. It does not invalidate previously emitted messages or alter historical message IDs.
- `IdentityApplicationA` can call `SourceGateway`, while mandatory ZK-gated message creation and proof-to-message nullifier binding remain unimplemented.
- The Indexer validates and persists source events, but it does not establish that a particular message was produced atomically with a ZK proof.
- `OBSERVED` records the current Chain A view at ingestion time. `FINALIZED` means only that the configured source-block depth was reached at the recorded watcher head; it provides no validator-approval or delivery guarantee.
- Canonical block hashes and parent hashes are tracked for every scanned block, including blocks without source events. The Indexer and Finality Watcher reconcile this history before their respective work.
- An unfinalized orphan is retained as terminal `REORGED` data and is never batch eligible. A replacement occurrence has its own block-hash identity and lifecycle.
- A fork that reaches a `FINALIZED` occurrence fails closed and requires operator investigation; configured block depth therefore remains a policy choice with real reorganization risk.
- Transactional block, message, cursor, reorganization, and finality writes support single-node worker restart recovery after graceful or abrupt process loss. Database-enforced source-event uniqueness makes exact-log retries and rescans idempotent without overwriting first-observation data or lifecycle status.
- PostgreSQL client errors fail the active pass. Recovery requires a fresh client or worker process connected to the same durable database; the project does not manage PostgreSQL server availability, replication, or automatic failover.
- The runtime assumes one active Indexer and one active Finality Watcher. Multi-instance coordination, distributed locking, active-active failover, and zero-downtime orchestration remain unimplemented.
- The current message binds its protocol type, source domain, source gateway, source sender, destination domain, destination gateway, destination receiver, nonce, payload hash, and deadline.
- A committed destination gateway is caller-selected. `SourceGateway` does not validate remote deployment, domain ownership, or trust, and no remote-gateway registry exists.
- The batcher consumes only the existing `FINALIZED` eligibility boundary. `REORGED` occurrences remain terminal and are excluded from every batch.
- A deterministic batch ID binds its source scope, epoch, and ordered canonical message IDs. The Merkle Message Root and proofs additionally bind message membership to canonical batch positions through distinct leaf and internal-node hash domains.
- Off-chain inclusion verification requires the caller's expected batch and root. A valid proof establishes membership within that commitment and supplies no consensus result, quorum certificate, Chain B authorization, or cross-chain acceptance.
- Batch and Merkle computation preserve source lifecycle state and use only existing public message data and provenance. They introduce no private credential attributes.
- PostgreSQL remains operational persistence. Batch and Merkle construction do not independently establish canonical-chain consensus or validator authority.
- Persistent batch assignment, sealing, and epoch advancement preserve source lifecycle state. Validator-local `PREPARED` permits COMMIT voting. Only an independently verified QC authorizes the atomic `CONSENSUS_PENDING → COMMITTED` transition.
- The Solidity Merkle primitive requires independently trusted expected context, including member count, and does not replace canonical message-field validation or authenticate a relayer. Shared golden vectors lock compatibility and grant no destination permissions.
- Four independent validator processes may share one source RPC provider; independent checking does not eliminate that provider's trust assumptions or produce a cryptographic source-finality proof.
- Validator-local observations are separate from source persistence and are never consensus votes. One validator or four local `VALID` results cannot commit a batch.
- Peer handshake signatures prove configured identity control in a distinct domain and cannot serve as PREPARE/COMMIT signatures. Source mismatches fail closed and do not trigger source DB repairs.
- Signed PRE-PREPARE proposals use a separate canonical domain and authenticate the deterministic primary, but signature validity cannot replace independent source validation. One accepted digest per local identity/epoch/view is durable across restart; accepted proposals do not authorize `COMMITTED`.
- Signed PREPARE votes use another canonical domain, bind the exact accepted proposal and voter identity, and count once per configured validator. Three matching voters produce durable local `PREPARED` state; duplicates and conflicts cannot add quorum weight or replace prior votes.
- COMMIT votes bind the static committee and exact accepted proposal. One or two voters cannot commit; three distinct valid COMMIT signatures are required. QC submitters need no trusted identity, and persisted evidence is cryptographically reverified on committed reads.
- The failure model retains progress with one unavailable non-primary and an honest available primary. A single conflicting backup cannot supply a conflicting QC. A 2|2 partition preserves safety and pauses progress until explicit retries restore delivery; connectivity changes do not reset vote locks or select a new primary.
- Primary failure or withholding triggers progress timeouts; replacement still requires three valid VIEW_CHANGE votes and an available deterministic new primary. Process availability is not commit authority. PostgreSQL never substitutes for independent source and signature verification.
- The repository does not provide validator epoch/rotation, Delivery Queue, Transaction Manager, destination gateway integration or destination QC verification, exactly-once downstream batch consumption, relaying, destination execution, Application B, a cryptographic finality proof, multi-worker coordination, or a production cross-chain security model.
- ZK authorization remains local to `IdentityApplicationA` on Chain A and is not propagated across chains.

Before using real assets, permissions, or production networks, the protocol requires a production trusted setup or verifiable ceremony, issuer authentication, production credential-state publication and governance, message relay, and a destination-chain execution security design.
