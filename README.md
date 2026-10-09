# Cross-Chain Protocol

This repository is a prototype for canonical cross-chain source messaging, zero-knowledge credential authorization with revocation and replay protection, persistent idempotent source-event indexing, configurable source-block finality tracking, source-chain reorganization recovery, restart-safe single-node workers, deterministic message batching, off-chain Merkle message commitments, and a persistent batch lifecycle. It provides a source-chain gateway, a two-chain local environment, a user-held credential model, credential proofs that can be verified locally or on Chain A, an identity application that can create canonical outbound messages through the gateway, a PostgreSQL-backed Indexer, an independent Finality Watcher, a batch builder for finalized source messages, and durable sealed Message Roots with reproducible inclusion proofs.

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
- assign finalized source occurrences to one durable lifecycle batch each;
- persist a single `BUILDING` batch per source scope and derive subsequent epochs from durable history;
- atomically seal canonical membership, batch identity, message count, and Message Root;
- restore immutable `SEALED` and `CONSENSUS_PENDING` snapshots and inclusion proofs after process restarts;
- allocate later finalized messages to the next epoch without changing old sealed commitments;
- preserve finality state and timestamps across duplicate event ingestion;
- recover the Indexer from a persisted next-block cursor after graceful or abrupt process loss;
- preserve `OBSERVED`, `FINALIZING`, `FINALIZED`, and `REORGED` lifecycle data across worker restarts;
- recreate a failed or closed PostgreSQL client and continue from durable database state.

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
```

`IdentityApplicationA` can call `SourceGateway`, but proof verification and message creation remain separate application entry points. A successful credential proof does not automatically emit a message, and sending a message does not consume a ZK nullifier. The Indexer persists emitted source events, and the Finality Watcher advances their database lifecycle; neither component adds proof-to-message binding. The generated Groth16 verifier, its credential adapter, `SourceGateway`, and `IdentityApplicationA` are deployed to Chain A during verification.

The Indexer and Finality Watcher are disposable worker processes. Their durable operational progress lives in PostgreSQL, and every new process reconciles that state with Chain A before continuing.

The batch lifecycle assigns finalized source occurrences to durable batch records. Sealing reuses the deterministic batch and Merkle builders to persist an immutable snapshot, and reading it reconstructs its inclusion proofs. Batch operations preserve source lifecycle state. `COMMITTED` is reserved for future PBFT quorum authorization; consensus and destination delivery are outside the current implementation.

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

PostgreSQL provides durable operational state; Chain A remains the source history authority. Constructing or sealing a batch grants no Chain B authorization, validator approval, quorum certificate, or delivery guarantee. The batch feeds the off-chain Merkle commitment described below. Consensus and relaying remain outside the current implementation.

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

The Message Root commits to ordered batch membership. Its expected batch and root still require an appropriate trust source; a valid proof by itself grants no Chain B authorization, Byzantine consensus, quorum certificate, or delivery guarantee. Current verification is off-chain only. Solidity Merkle verification, shared Solidity/off-chain golden vectors, PBFT, relaying, and destination execution remain unimplemented.

## Batch Lifecycle

`createBatchLifecycle({ config, pool })` manages one configured source domain and Gateway through PostgreSQL. It requires an existing Indexer cursor for that scope. The conceptual lifecycle is:

```text
BUILDING → SEALED → CONSENSUS_PENDING → COMMITTED
                                      (reserved for future PBFT quorum authorization)
```

Current operations stop at `CONSENSUS_PENDING`. A sealed batch is an immutable message commitment, and a pending batch is awaiting consensus; neither status represents validator agreement. The `COMMITTED` state is representable for future integration, but ordinary SQL inserts and transitions cannot create it. There is no production commit API, generic transition API, CLI override, or bypass flag. A future 3-of-4 PBFT quorum authorization mechanism must establish that transition.

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

Snapshots contain `{ record, members, batch, tree }`. Building snapshots have `batch: null` and `tree: null`. Sealed snapshots reconstruct the existing batch representation and Merkle result, including every inclusion proof. Protocol values remain `BigInt`; operational timestamps and record IDs do not enter any protocol hash.

Sealing runs the existing canonical builder over the assigned source occurrences, validates the resulting batch, builds its Merkle tree, and persists all canonical positions, batch ID, root, count, and `SEALED` status in one transaction. A failure before commit rolls back the entire operation and leaves a retryable building batch. Repeated sealing cannot rewrite the snapshot or move a pending batch backward.

Database guards reject sealed member insertion, deletion, reassignment, reordering, commitment changes, epoch changes, record deletion, illegal transitions, and rewritten transition timestamps. Every sealed read reconstructs canonical membership and checks count, contiguous positions, canonical order, batch ID, and Message Root. Inconsistent persisted data fails closed. Inclusion proofs are regenerated deterministically from authoritative source data rather than saved as an independent proof format.

Fresh clients and processes recover the same sealed or pending snapshot without local state. Subsequent collection creates the next epoch and assigns only unclaimed finalized occurrences; old roots and proofs remain unchanged. The integration flow seals A/B/D, restores the snapshot in fresh processes, marks it pending, then produces and finalizes Message E and assigns only E to the next epoch. Unit and isolated database tests cover retry behavior, invalid transitions, immutable snapshots, partial-seal rollback, and competing clients synchronized at explicit lock barriers.

Batch membership uniqueness provides durable assignment ownership. It does not establish exactly-once consensus, relaying, destination execution, or delivery.

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
```

The Indexer pins `viem` to `2.56.9` and `pg` to `8.23.1`. Its dependency tree is recorded in `indexer/package-lock.json`, so clean installations should use `npm ci`.

PostgreSQL installation and database creation remain external prerequisites. Project scripts check connectivity and apply the project migration, but they do not install or start PostgreSQL and do not create a database.

The unified verification script automatically loads local configuration from the repository-root `.env` file. Copy the structure from `.env.example`, set the local PostgreSQL password in `.env`, and keep the example file free of real credentials. The local `.env` file is excluded from source control and its values are not printed by the verification script.

The Python validator uses only the standard library, so the repository does not need a `requirements.txt` file.

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

The real Chain A integration runs through the unified repository verification flow because it needs the deployed protocol contracts and both local chains. It covers fixed-snapshot indexing, abrupt worker termination after durable commits, offline message catch-up, PostgreSQL pool recreation, repeated restarts, exact-event rescans, real `OBSERVED → FINALIZING → FINALIZED` transitions, eventless block tracking, and snapshot/revert replacement of an unfinalized branch followed by a fresh Indexer process. It then constructs and seals a batch from finalized A/B/D, excludes the reorged C occurrence, builds the Message Root, and verifies all three inclusion proofs. Fresh processes restore sealed and pending snapshots. A later real Message E is finalized and assigned to the next epoch while old membership, roots, and proofs remain unchanged. Changed messages and wrong roots/proofs fail, and batch operations preserve source lifecycle state.

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
49. finalization of a new real Message E, assignment to the next epoch, and unchanged old inclusion proofs.

`DATABASE_URL` is required and should point to a database intended for local verification. The flow uses project-owned schemas and tables; it does not drop a database or reset the `public` schema. It does not install PostgreSQL, create a database, install npm packages, or generate an Indexer lockfile.

If neither configured RPC endpoint is running, the script starts both chains through `scripts/start-chains.sh` and stops the processes it created when verification ends. If both chains already exist with the expected chain IDs, the script reuses them and leaves them running.

All stdout and stderr are displayed in the terminal and written to:

```text
verification.log
```

Each run replaces the previous `verification.log`. A successful run ends with:

```text
VERIFICATION PASSED
Batch Lifecycle
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
│   │   └── SourceGateway.sol
│   └── test/
│       ├── CredentialVerifier.t.sol
│       ├── IdentityApplicationA.t.sol
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
│   │   └── 005_batch_lifecycle.sql
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
- Persistent batch assignment, sealing, and epoch advancement preserve source lifecycle state. `CONSENSUS_PENDING` is the current authorization boundary; future PBFT quorum verification must authorize `COMMITTED`.
- The repository does not provide Solidity/Destination Gateway Merkle verification, shared Solidity/off-chain Merkle golden vectors, exactly-once downstream batch consumption, relaying, PBFT validation, destination gateway implementation or execution, Application B, a cryptographic finality proof, multi-worker coordination, or a production cross-chain security model.
- ZK authorization remains local to `IdentityApplicationA` on Chain A and is not propagated across chains.

Before using real assets, permissions, or production networks, the protocol requires a production trusted setup or verifiable ceremony, issuer authentication, production credential-state publication and governance, message relay, and a destination-chain execution security design.
