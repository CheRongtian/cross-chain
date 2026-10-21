# Cross-Chain Protocol

This repository implements a Solidity-based cross-chain messaging prototype from exact-intent zero-knowledge authorization on Chain A to atomic application execution on Chain B. It includes canonical source messages, persistent indexing and fixed-head finality/reorganization handling, deterministic bounded batches, ordered Merkle commitments, four-member PBFT committees with historical rotation and view recovery, a durable delivery queue, leased Relayer workers, and a persistent EIP-1559 Transaction Manager with retries, replacement, RPC failover and crash recovery. Private credential witnesses stay with the prover. Groth16 proofs are verified on Chain A; only public business intent and consensus/membership evidence cross the destination boundary.

On Chain B, DestinationGateway binds the existing PBFTCertificateVerifier, MerkleInclusionVerifier and MessageDomainVerifier immutably and inherits MessageReplayProtection. Anyone may submit evidence; Relayer identity and PostgreSQL grant no execution authority. The Gateway authenticates the QC, ordered membership and complete message, consumes its canonical ID, and calls the exact executable destinationReceiver through ICrossChainReceiver. ApplicationB accepts only its immutable Gateway and interprets a canonical supplier-grant payload. Receiver failure rolls back replay and business effects together. The independent components and test-only boundary harnesses remain available for regression coverage.

## Local quick start

Prepare the existing development dependencies/build artifacts first. Native Prometheus and Grafana must also already be installed; optional `PROMETHEUS_BIN`, `GRAFANA_BIN` and `GRAFANA_HOME` in ignored `.env` select their installed locations. `GRAFANA_BIN` identifies the unified `grafana` executable supporting `grafana server`; `GRAFANA_HOME` contains `conf/defaults.ini`. No launcher installs tools or performs a new trusted setup. Grafana plugin preinstallation and public-key downloads are disabled using the [official configuration options](https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/). Missing reusable WASM, zkey or compiled verifier artifacts are reported with the existing `./scripts/verify.sh` preparation entry.

```bash
./scripts/start.sh
```

`start.sh` starts a complete persistent local stack, waits for readiness, automatically prepares one real confirmed cross-chain message for the Explorer, prints its URLs and the message link, and returns. No additional message-generation or demonstration command is required. It owns fresh Anvil chains (`10011`/`2001`), new PostgreSQL schemas, four independent validators, continuous Indexer/Finality workers, production batch/PBFT scheduling, delivery projection, two leased Relayers with the persistent Transaction Manager, the read-only API/Explorer, Prometheus and the existing Grafana dashboard. Default browser endpoints are Explorer `http://127.0.0.1:8080/`, Prometheus `http://127.0.0.1:9090/` and Grafana `http://127.0.0.1:3000/d/cross-chain-protocol`. Grafana is loopback-only with anonymous Viewer access. A second start reuses the same healthy owned stack and existing confirmed message after checking its current API evidence, without sending another transaction. An unrelated occupied port causes a clear failure; it is never attached to or terminated. Use `./scripts/stop.sh` to shut down only this owned stack.

Local startup, deployment, demo and observation orchestration live in `indexer/scripts/local/`. An explicitly IPC-spawned wrapper in `validator/scripts/local-validator.mjs` runs the unchanged production validator in the same process and provides owner-only fault controls. These scripts call existing protocol components in `indexer/src/` and `validator/src/`; protocol components never import this script layer. Ordinary `validator/src/main.mjs` startup has no fault controls. Grafana provisioning is read only by the deployment scripts, with the existing protocol/Grafana isolation checks retained.

`DATABASE_URL` in `.env` selects an existing PostgreSQL database in which the launcher creates unique namespaces. Leave it empty to use an owned temporary cluster with the already installed PostgreSQL tools. No personal password is copied into runtime configuration, manifests or results. The local stack supplies its own actual deployed addresses, source scope and validator history to children; no verification-log address copying is needed. The local signer accounts are public Anvil development accounts and must never be funded or used outside local development.

On a fresh stack, startup creates a synthetic credential and legitimate authority-published active root, proves the current twelve-signal statement for one exact forwarding intent, and submits it through Application A. Existing workers carry that same message through OBSERVED, FINALIZING, FINALIZED, sealing, real PBFT PRE-PREPARE/PREPARE/COMMIT/QC, READY projection, durable signed/broadcast transport and canonical Chain B confirmation. Controlled local successor mining follows actual persisted source/transaction evidence. Startup reports the message as ready only after matching Gateway execution, exactly one `VerifiedSupplierGranted` event, replay consumption, `isVerifiedSupplier(supplier) == true` and the Explorer's live confirmed evidence agree. The supplier is public business input, with no claim of private-subject EVM address ownership. An initialization failure returns a nonzero exit code; a newly created failed stack is cleaned up. Startup never injects validator faults.

The shared normal-message path inspects actual destination calldata/events/state, API list/detail, the real Explorer client/view-model/text renderer, served assets and live metrics. High-entropy private identifiers and complete circuit field encodings must remain absent. Exact credential expiry and membership witnesses stay prover-local; the public `authorizationValidUntil` is an earlier authorization bound. Public issuer/role policy, commitments, roots, nullifier and forwarding intent remain public protocol evidence. This checks the implemented data path without claiming browser screenshot or visual-render verification.

Full verification automatically includes both the `byzantine-validator` and `validator-crash` scenarios. They run only in verification's owned isolated stack, through the shared internal implementation; no separate public demonstration entry is needed. Each creates an independent credential, twelve-signal proof, authorized source message and supplier intent. The local scheduler acknowledges a pause before message creation, then seals the target batch and deterministically selects the first canonical non-primary for its actual epoch/view. The committee remains four members with `f=1` and quorum three; no registry or quorum is changed. Concurrent demonstrations are rejected.

In `byzantine-validator`, the selected validator stays alive and signs/sends deterministic conflicting-root PREPARE and COMMIT evidence inside its own process using its own actual identity key and the existing protocol digest/broadcast implementation. The controller independently authenticates those signatures. All three honest processes must persist the precise `WRONG_ROOT` rejection. Read-only inspection of the entire protected epoch checks that the conflict obtains no PREPARED state, COMMIT quorum, QC, committed batch or READY authority. Exactly three honest canonical voters produce the final QC; the faulty member contributes no canonical vote.

In `validator-crash`, the supervisor cross-checks its child registry, manifest, OS process identity and live validator identity before abruptly terminating the selected non-primary with SIGKILL, while the batch is still SEALED and before any own target vote. Only that designated peer's unavailability is tolerated; failures of any honest peer remain fatal. The remaining three real processes prepare and commit the canonical batch in view zero. The target remains offline through destination confirmation and the actual supplier grant. It is then restarted with the same identity, schema and configuration, independently verifies the committed QC and returns to readiness without casting historical votes. Both demonstrations require four healthy validators and all observation targets restored before returning success.

Both paths continue through the existing queue, leased Relayers and persistent Transaction Manager to exactly one canonical Gateway execution and one Application B grant. Logs print the actual target identity/PID, roots, honest signer identities, QC and Explorer message URL. Prior committed message, batch, QC, delivery and signed-transaction evidence must remain unchanged. No public fault-administration routes, fault metadata tables, replacement proof keys or custom consensus implementation are introduced. These controlled single-fault local scenarios exercise this prototype's implemented recovery contract; they do not establish a production BFT security guarantee or arbitrary multi-fault tolerance.

Owned process identities, public deployment/endpoint manifests, component logs, latest `demo-result.json`, per-message `demo-<messageId>.json` summaries and private prover material live under ignored `.run/local/<run-id>/`. Private files use owner-only permissions. A startup failure cleans up only its own processes; `stop.sh` also checks stale ownership records and leaves unrelated processes and external PostgreSQL running. Stopping removes an owned temporary PostgreSQL cluster; external-database namespaces and other runtime evidence are retained. Restarting after stop creates a fresh stack. Proving artifacts are copied into each run so a later full verification rebuild does not replace the active stack's keys.

Full verification remains one command:

```bash
./scripts/verify.sh
```

It overwrites root `verification.log` and retains the existing regressions/fuzz campaigns and final authorization-expiry gate. `[clean bootstrap happy-path and privacy demonstration]` / `[clean-stack privacy demonstration]` start an independently owned PostgreSQL cluster and whole stack on fresh ports, then run two distinct happy paths and check actual privacy surfaces. That group also exercises the same initial-message preparation used by startup and checks reuse of its current confirmed API evidence. The immediately following `[byzantine and validator crash demonstrations]` reuse that exact owned stack for two fresh fault messages, check durable rejection/quorum/authority and destination evidence, restore readiness and clean up the owned resources. `BYZANTINE / VALIDATOR CRASH DEMONSTRATIONS PASSED` is printed only after both scenarios and cleanup succeed. Verification never reuses a manually running product stack. Required native Prometheus/Grafana binaries cannot be silently skipped. Runtime evidence is retained under `.run/verification/<run-id>/`; it never rewrites `.run/local/active.json`.

The current implementation can:

- produce deterministic message identifiers that can be reproduced across implementations;
- emit complete canonical message data from a source-chain gateway;
- run and verify two independent local Anvil chains;
- describe private credentials, issuer trust, roles, expiry, and active or revoked lifecycle state;
- build deterministic Poseidon Merkle roots for active credentials;
- commit to credential fields and prove issuer, role, expiry, and active-state membership in one circuit;
- derive a deterministic Poseidon nullifier from the private credential identifier and a public application, epoch, and action context;
- verify a valid proof and reject an invalid witness, a credential expired at the proven timestamp, wrong role, untrusted issuer, or tampered public input;
- generate a Solidity verifier from the active Groth16 proving key and verify the same proof on Chain A;
- enforce a fixed issuer, the `VERIFIED_SUPPLIER` role, proof freshness, and the current credential-state root in `IdentityApplicationA`;
- keep credential expiry private while binding a per-proof public `authorizationValidUntil` and requiring execution strictly before it;
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
- recover from a temporary PostgreSQL server outage using the same persistent storage, original consensus evidence and canonical destination-chain reconciliation;
- run four independent validator processes with distinct secp256k1 identities and isolated state;
- authenticate configured peer identities with source-bound challenge-response signatures;
- independently verify canonical source blocks, receipts, raw event logs, and fixed-head finality;
- reconstruct each candidate's batch ID and Message Root using the existing protocol implementations;
- preserve validator-local validation observations across fresh-process restarts without granting commit authority;
- select a deterministic primary from the canonically ordered committee resolved from immutable history for each batch's pinned validator epoch;
- sign domain-separated PRE-PREPARE proposals only after independent validation of a pending batch;
- independently authenticate and validate proposals on backups, retain one immutable proposal per epoch/view, and recover it after process loss;
- retry partial proposal delivery without changing the primary or replacing accepted state;
- create a domain-separated PREPARE vote only from a locally accepted PRE-PREPARE;
- count one durable vote per committee identity and form validator-local `PREPARED` state at three matching votes;
- recover self-vote locks, remote votes, and monotonic `PREPARED` state after process loss without committing the batch;
- persist and broadcast COMMIT only after durable local `PREPARED`, with one vote per validator and epoch/view;
- bind the pinned validator epoch and four-member committee digest into each current v3 COMMIT and QC;
- construct and independently verify a QC carrying three or four distinct matching COMMIT signatures;
- atomically persist an immutable QC and commit the corresponding pending batch;
- verify persisted certificates when reading `COMMITTED` batches and recover the same result after restart.
- continue the same consensus instance through explicit durable-message retries after connectivity returns;
- exercise deterministic process and transport faults while preserving quorum identity, immutable vote locks, and source history.
- strictly reverify COMMITTED batches and materialize one immutable READY delivery job per sealed message position;
- recover complete portable message, batch, Merkle and historical QC evidence after worker restart;
- serialize concurrent queue projection and roll back interrupted batches without partial or duplicate jobs.
- independently verify READY packages at submission time and transport their exact historical QC evidence through leased Relayer A/B workers;
- encode complete delivery evidence with a deterministic versioned ABI envelope and send it to the canonical destination gateway with zero value;
- retain immutable historical direct-submission records and skip those jobs on a normal fresh-process rerun;
- atomically reserve persistent nonces and retain one immutable locally signed type-2 attempt per logical delivery;
- persist raw transaction bytes and their derived hash before sending to Chain B;
- track canonical destination receipts to configured depth with distinct CONFIRMED and REVERTED outcomes, retain historical observations and recover the original intent after positively proven destination reorganization.
- configure one current trusted remote source-gateway identity per exact `uint256` source domain on Chain B;
- append canonical four-validator committees with a three-validator quorum to immutable Chain B history and resolve each exact validator epoch without fallback;
- verify existing v1/v2/v3 PBFT certificate bytes read-only on Chain B against trusted expected context and exact historical authority;
- verify ordered message-ID inclusion on Chain B against a canonical full-membership batch commitment and an independently authenticated Message Root;
- validate full message identity, current remote-source trust, explicit destination intent, supported message version and strict destination expiry through the stateless `MessageDomainVerifier`;
- compose QC, Merkle and full-message verification in `DestinationGateway.execute(bytes)`, consume the authenticated message ID and dispatch its payload atomically;
- execute the Application B supplier-grant example only through its configured Gateway, with business errors rolling back message consumption;
- query one message's persisted lifecycle through a read-only API and built-in Explorer;
- expose process-local Prometheus operational metrics without granting the observability surface any protocol authority;
- provide a provisionable Grafana operational dashboard for throughput, latency, component health, unresolved delivery backlog, source reorgs and failure/retry activity.

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
                                                   IdentityApplicationA policy + exact intent
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
                                              4 active validators from immutable history
                                              pinned validatorEpoch + committeeDigest
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
                                                               │
                                                               v
                                              strict evidence verification
                                                               │
                                                               v
                                              Delivery Queue: one READY job/message
                                                               │
                                                               v
                                              Relayer A / Relayer B
                                              per-job lease + fencing
                                              verify + versioned ABI envelope
                                                               │
                                                               v
                                              Persistent Transaction Manager
                                              intent + nonce + fees + signed bytes
                                                               │
                                                               v
                                              Destination RPC Pool
                                              ordered same-chain access paths
                                              primary → healthy fallback
                                                               │
                                                               v
                                              Chain B execute(bytes) broadcast
                                                               │
                                                               v
                                              DestinationGateway: QC → Merkle → message/domain
                                                               │
                                                               v
                                              consume messageId → ICrossChainReceiver
                                              Application B supplier-grant example
                                              atomic rollback on receiver failure
                                                               │
                                                               v
                                              canonical receipt + configured depth
                                              CONFIRMED / REVERTED

Chain A source domain + SourceGateway identity ──> Chain B RemoteGatewayRegistry
                                                    current on-chain trust configuration
```

`IdentityApplicationA.forwardAuthorizedMessage` verifies a credential proof bound to the exact forwarding intent, consumes its nullifier and calls `SourceGateway` in one transaction. The separate `verifySupplier` function records commitment-level credential verification and provides no forwarding capability. The Indexer and validators independently revalidate public canonical source events without inspecting private credentials or re-running the credential circuit. The generated Groth16 verifier, its adapter, Gateway and application are deployed to Chain A during verification.

The Indexer and Finality Watcher are disposable worker processes. Their durable operational progress lives in PostgreSQL, and every new process reconciles that state with Chain A before continuing.

The batch lifecycle assigns finalized source occurrences to durable batch records. Sealing reuses the deterministic batch and Merkle builders to persist an immutable snapshot, and reading it reconstructs its inclusion proofs. A verified QC authorizes `CONSENSUS_PENDING → COMMITTED`. The Delivery Queue consumes that exact committed evidence without changing source messages, finality data or consensus state. READY denotes materialized evidence. Relayer A/B submit verified packages through destination RPC without changing READY or source state; a returned transaction hash establishes neither destination acceptance nor execution.

The same commitment primitive is implemented in JavaScript and Solidity. Shared committed vectors constrain both runtimes, and complete verification passes a reconstructed real sealed batch into Foundry's local EVM. It additionally deploys a stateless Chain B inclusion verifier and checks every actual committed member after authenticating the exact QC context/root. DestinationGateway composes those same components and invokes the authenticated application after replay consumption.

Destination validation composes separate boundaries using the identical root and message ID:

```text
Historical PBFT QC → authenticated Message Root → ordered Merkle inclusion
    → authenticated messageId → full message/domain/expiry validation
    → internal exactly-once consumption
    → production DestinationGateway receiver call → Application B supplier grant
```

The remote source identity is resolved through Chain B's current `RemoteGatewayRegistry`. The message cannot supply its own source authority. Full-message verification supplies no consensus or membership of its own, and a historical EOA transport receipt supplies no protocol acceptance. A successful production DestinationGateway transaction commits its complete atomic execution.

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

### Message integrity

Canonical identifiers bind the source and destination domains, Gateway/application identities, nonce, payload commitment and deadline. Equivalent input objects, property insertion order, operational timestamps, source provenance, database IDs and later lifecycle metadata do not redefine a message. Protocol integers remain exact `uint256` values across JavaScript BigInt/string representations and Solidity.

Once a message is included in a committed Message Root, changing an authenticated field changes its canonical ID and Merkle leaf, preventing reuse of the original membership proof under the original root. A payload candidate retaining its old hash or ID fails canonical validation. Recomputing a valid replacement hash/ID still does not replace the committed member: production Merkle/package verification rejects its old proof and root. PostgreSQL provides operational durability and sealed-membership guards; canonical identity, ordered Merkle commitments and authenticated PBFT roots provide the cryptographic integrity boundary.

A mutation can also equal a different existing member, such as changing nonce 1 to 2 in a batch containing both. It still cannot reuse the original position's proof. Rebuilding a batch with that ID twice must fail the duplicate-membership check; the existing member remains valid with its own original proof. The integrity regressions cover both duplicate replacements and genuinely new IDs without assuming every mutation constructs a valid replacement batch.

Deterministic security regressions call the production message/hash, batch, Merkle and package helpers. Read-only `test-vectors/merkle-golden-vectors.json` and `test-vectors/destination-transport.json` supply fixed expected IDs, roots, proofs and transport bytes, with Solidity checks against the same evidence. Adjacent full-width domain mutations, same-length payload mutations (including the 4096-byte boundary), stale IDs and freshly recomputed IDs are checked explicitly. These selected regressions are not a formal proof or an exhaustive randomized campaign.

The existing `./scripts/verify.sh` includes `[message integrity invariants]` and preserves all prior verification groups. Existing database regressions check immutable canonical evidence at SEALED, CONSENSUS_PENDING and COMMITTED. The retained real source-to-destination scenario records one identity through source emission, persistence/finality, sealing, PBFT commitment, portable encoding and actual Gateway-authenticated destination decoding. Negative probes mutate only in-memory candidates, compare source/batch/QC/READY/transaction and destination-state snapshots, and reverify the original message/proof/root/QC afterward. Public payload hashes and original/mutated IDs are printed as evidence in root `verification.log`; fixed expected vectors are never rewritten to make a check pass.

Verification distinguishes protocol rejection from execution failure. ZK negative cases require an explicit verifier `false` or a generated circuit assertion with a template location; input, file, WASM and other execution errors fail the run. Root and credential deployment checks share the same strict revert matcher, preserving stdout/stderr and rejecting error names/selectors that appear only in unrelated diagnostics. `[verification rejection assertion regressions]` checks these ZK failure boundaries before proving; retained source-policy fixtures exercise both shared Shell entry forms.

### Cross-chain safety

Destination execution requires the complete authorization chain. Source finality makes an exact canonical occurrence eligible for batching; a validator quorum must commit its sealed batch root; the message must prove ordered membership in that root; the QC must authenticate against the historical validator set; and the complete message must bind a currently trusted source and the exact local destination. A self-consistent Merkle tree alone grants no execution authority.

Chain B does not directly query Chain A finality. That responsibility belongs to the source finality pipeline and the validators' independent checks of canonical blocks, receipts, raw source logs and configured successor depth. Under the four-member, one-fault, three-signature quorum model, an OBSERVED, FINALIZING or REORGED occurrence cannot acquire canonical batch membership, a committed QC-backed READY package or an authorized destination execution. Deterministic local verification uses the configured successor depth of two and exact mined blocks, without timing-based sleeps or fabricated QCs for unfinalized occurrences.

The deterministic cross-chain safety coverage establishes seven boundaries:

- Unfinalized occurrences are excluded by production batch selection and cannot propagate into PBFT/QC, READY or destination business effects.
- BUILDING, SEALED and CONSENSUS_PENDING batches cannot create portable delivery authority. Only the production QC-authorized COMMITTED transition makes the same members deliverable.
- A message with a corrupted membership path cannot execute under an otherwise valid root/QC.
- Two individually valid committee signatures remain below the required three-of-four quorum and cannot authorize execution.
- An authenticated message ID can execute at most once, including byte-identical packages sent by different callers or independent Relayer processes.
- Self-consistently rehashed messages for another destination domain or Gateway cannot execute locally; full-width destination values retain their exact identity.
- A known source domain paired with an untrusted Gateway, or an unmapped source domain, is rejected even when test-local QC/Merkle evidence is otherwise valid.

Isolated Foundry cases compose the production registries, certificate/Merkle/domain verifiers, Gateway replay storage and ApplicationB. A shared valid package first succeeds through the complete production execution path, then test-owned EVM state is restored before a single authority boundary is broken. Test-only committee signing scalars remain inside the existing Solidity fixture. Negative cases assert precise errors, unchanged replay/business state and zero emitted logs for both controlled submitters. Original valid evidence executes after rejection; rehashed policy-negative messages have their own distinct, unconsumed IDs. These fixtures do not ask the live validator cluster to authorize altered messages or roots.

The receiver is authenticated message intent, without an ApplicationB-only allowlist. An authorized message may name another valid receiver; substituting the receiver in an existing commitment is rejected, while self-consistent zero-address or code-free targets fail the existing destination checks. No new receiver routing policy is introduced.

Relayers are transport actors, not authorization authorities. PostgreSQL provides operational durability, not cross-chain authorization; a returned transaction hash or database CONFIRMED marker cannot replace canonical Gateway state and events. Production verification authenticates the evidence before replay consumption, and the receiver callback commits atomically with that consumption. Invalid QC, membership, source or destination evidence cannot burn the message ID, modify ApplicationB or emit a business success event. Replay rejection preserves the first successful execution.

The existing `./scripts/verify.sh` includes `[cross-chain safety invariants]` alongside every retained regression group. Database cases check exact target membership, QC and READY/package absence. The existing real source-reorg scenario checks OBSERVED and FINALIZING boundaries with live validators, preserves terminal REORGED exclusion, and later executes the canonical replacement. A fresh real batch is checked at SEALED and CONSENSUS_PENDING before its genuine PBFT commitment and successful production Gateway/ApplicationB execution. The retained two-process duplicate-delivery race checks two canonical receipts from distinct senders, one exact replay rejection, and exactly one correlated business success event. All evidence goes to root `verification.log`; these deterministic checks are not a formal proof or a randomized/stateful campaign.

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

Binding `destinationGateway` makes the selected remote endpoint part of the cryptographic message identity. It does not establish that the address is deployed, belongs to the destination domain, or is trusted. The repository implements source-chain message production and event verification, while Chain B stores explicit remote source-gateway trust separately. Relayer A/B still submit to the canonical destination gateway address; the registry is not a transaction destination and does not provide destination message verification, execution or replay protection.

### RemoteGatewayRegistry

`contracts/src/RemoteGatewayRegistry.sol` maintains the authoritative Chain B mapping from each exact `uint256` source domain to one currently trusted, nonzero remote Ethereum address. The configured immutable registry administrator can add, replace or remove a mapping; Relayers have no registry authority. The local verification operator is distinct from the Relayer signer. Actual changes emit `RemoteGatewayUpdated` with the domain and previous/new gateway values. Contract storage is the current authority, while events provide operational configuration history. Repeated writes and removal of an unknown domain revert.

The zero address represents an unknown source domain. `trustedRemoteGateway` returns that value for an unconfigured domain, `isTrustedRemoteGateway` performs an exact domain-and-address comparison, and `requireTrustedRemoteGateway` fails closed with distinct errors for an unknown domain and a known-domain gateway mismatch. There is no wildcard or default gateway.

A registered gateway is an address identity on its source chain and is not required to contain bytecode on Chain B. The registry does not attempt cross-chain code introspection. Its storage is trusted configuration used by MessageDomainVerifier and DestinationGateway; it does not authenticate a message, delivery package, Merkle proof, QC, validator set, relayer or application call by itself.

The registry stores one currently trusted gateway per source domain. Replacing a mapping immediately makes the previous address non-current. Historical remote-gateway epochs and grace periods are not represented.

### ValidatorSetRegistry

`contracts/src/ValidatorSetRegistry.sol` is Chain B's trusted historical validator-set authority. Its immutable `registryAdmin` is the configured trusted operator. Only that operator can call `registerValidatorSet(uint256 validatorEpoch, address[4] validators)`. The contract sorts the four public Ethereum identities by unsigned address value, rejects zero and duplicate addresses, derives the existing PBFT committee digest, and stores quorum `3`. The registration API has no caller-selected quorum or digest.

The initial validator epoch may be any exact `uint256`, including zero. Every subsequent epoch must equal the previous epoch plus one; duplicates, historical rewrites, retroactive epochs, gaps and overflow revert. The committee, quorum and digest of a registered epoch cannot be updated or removed. `ValidatorSetRegistered` emits the exact canonical public configuration. Storage supplies authority to consumers.

`IValidatorSetRegistry.getValidatorSet(validatorEpoch)` returns `(address[4] validators, uint8 quorum, bytes32 committeeDigest)` for the exact historical epoch. Unknown epochs revert with `UnknownValidatorEpoch`; there is no initial, nearest or latest fallback. `hasValidatorSet` reports existence and `isValidator` checks membership in that exact epoch, also reverting for an unknown epoch. `hasValidatorHistory` distinguishes an empty registry from a valid initial epoch zero. Initial/latest getters revert before initialization. `latestValidatorEpoch` records append progress, while `initialValidatorEpoch` preserves the immutable authority anchor already used by the off-chain legacy v1/v2 resolver. The registry does not decide destination legacy-QC eligibility.

The digest remains byte-for-byte compatible with `validator/src/committee.mjs`:

```text
committeeTypeHash = keccak256("PBFTStaticCommittee(uint8 protocolVersion,address[4] validators)")
committeeDigest   = keccak256(abi.encode(committeeTypeHash, uint8(1), canonicalValidators))
```

The committee encoding version remains `1`, independently of PBFT evidence version `3`. This existing digest binds the canonical identities; validator epoch and quorum are represented by the registry record. Reusing the same committee under a later epoch produces the same digest. Changing a member changes it. `test-vectors/validator-sets.json` freezes public identities, canonical ordering, quorum and expected digests shared by Solidity and JavaScript tests. Expected values are checked against the existing implementation and never regenerated by deployment.

The development identity directory contains V1–V5. Validator epoch `7` holds V1/V2/V3/V4; epoch `8` holds V2/V3/V4/V5. Both contain exactly four members. After rotation, V1 remains a historical epoch-7 member and is excluded from epoch 8; V5 is excluded from epoch 7. Batch epoch remains an independent message-batch sequence. Off-chain activation boundaries continue to schedule committees for batches and are not stored by this registry.

The registry is configured from trusted public history before consensus evidence is examined. Relayers, DeliveryPackages, PostgreSQL records and RPC endpoints cannot register or supply committee authority. `scripts/deploy-validator-set-registry.sh` requires an explicit operator key, checks Chain B ID `2001`, appends the configured history and compares full ABI-encoded records with the off-chain expected members, quorum and digest. The root verification flow supplies public development history and reuses its existing Chain B registry operator. It also compares actual resolved history and historical QC epoch/digest bindings during the existing five-process rotation scenario.

Remote-gateway trust and historical validator authority are separate contracts. `ValidatorSetRegistry` provides no QC parsing, COMMIT/signature acceptance, EIP-191 handling, Merkle inclusion acceptance, destination message validation, replay protection or application execution.

### PBFTCertificateVerifier

`contracts/src/PBFTCertificateVerifier.sol` binds one deployed `ValidatorSetRegistry` immutably. `verifyCertificate(bytes certificate, ExpectedContext expected)` returns `true` or reverts with a specific custom error. It has no administrator, mutable consensus state, events, replay state or application callback. It supports EVM static calls.

The certificate bytes are the existing relayer QC tuple: `uint8,bytes,bytes32,(address voterIdentity,bytes32 commitDigest,bytes signature)[]`. The parser bounds evidence to three or four entries before allocation, validates canonical ABI offsets, address widths, version-dependent statement length, 65-byte signature lengths and zero padding, and rejects truncated, oversized or trailing data. Canonical certificates occupy 1,184–1,504 bytes. It preserves all existing message, batch, Merkle, COMMIT, QC and delivery encodings.

The caller must supply trusted `protocolVersion`, `sourceDomain`, `sourceGateway`, `batchEpoch`, `viewNumber`, `batchId`, `messageRoot` and `authorityEpoch`. Solidity reserves `view`, so the contract identifier is `viewNumber`; the JavaScript contract adapter maps the protocol's original `view` to this key. ABI types and positions, JSON fields, signed type strings and frozen evidence remain unchanged. A self-selected valid certificate cannot establish those expectations. For v3, the signed `validatorEpoch` must equal the expected authority epoch; the registry resolves that exact record without a latest/nearest fallback. The verifier derives committee digest and the canonical PRE-PREPARE proposal digest from registry authority and the signed context, including the deterministic primary. Batch epoch and view retain their full `uint256` width, including primary selection when their mathematical sum exceeds `uint256`.

Legacy eligibility is explicit: the trusted caller must expect v1 or v2, and `authorityEpoch` must equal the registry's immutable initial epoch. v1 has no signed view and requires expected `viewNumber` zero. v1/v2 contain no signed validator epoch; the authority anchor is caller/registry metadata and is never inserted into historical digest bytes. The current protocol has no universal pre-rotation batch cutoff for legacy evidence. A caller expecting v3 rejects a legacy certificate. Registering later committees does not revoke genuine old evidence or grant a future member authority over it. DestinationGateway constructs source/batch/root expectations from one decoded snapshot. Existing QC metadata selects its original version schema and signed v3 authority; legacy authority comes from the immutable initial registry epoch. The existing verifier authenticates their exact agreement and signatures.

Each COMMIT uses the original type-tagged ABI digest and signs the raw 32-byte digest through EIP-191 personal-sign (`\x19Ethereum Signed Message:\n32`). v3 appends `validatorEpoch` after `voterIdentity` in COMMIT and at the end of the QC statement. Recovery accepts exactly 65-byte signatures with `v` in `0/1/27/28`, nonzero `r/s` strictly below the secp256k1 order, and nonzero recovered identities. Existing viem/noble recovery accepts high-s, so the contract preserves that behavior. Raw-digest signing, double prefixing, compact signatures and other recovery IDs are rejected. Every recovered identity must match the claimed voter, belong to the exact historical committee and appear in strict ascending address order. Duplicates, including alternate signature bytes from the same identity, cannot add quorum weight. All four entries are checked when four are supplied.

`test-vectors/pbft-certificates.json` freezes public v1/v2/v3 statements, proposal/COMMIT/QC digests, signing digests, signature bytes, recovered identities and exact transport bytes. An independent reference encoder creates the initial artifact; normal verification only checks it and never overwrites it. JavaScript and Foundry consume the same artifact, including full-width context, legacy authority, high-s/v normalization and invalid evidence cases. The existing real rotation scenario also sends its actual epoch-7 and epoch-8 QCs to the deployed Chain B verifier and rechecks the old QC after V1 stops.

Certificate verification authenticates a batch commitment under trusted context. It does not establish remote-gateway trust, source finality, canonical message semantics, Merkle inclusion, deadlines, destination routing, replay prevention or Application B execution. DestinationGateway composes these independent boundaries before application execution.

### MerkleInclusionVerifier

`contracts/src/MerkleInclusionVerifier.sol` is a pure, stateless Chain B facade over the existing `MessageMerkle` library. It has no administrator, registry dependency, events, replay state or callback. `verifyInclusion(expectedBatch, expectedRoot, messageId, position, orderedMessageIds, proof)` returns `true` or reverts with a specific custom error. `expectedBatch` contains only canonical batch fields: `version`, `sourceDomain`, `sourceGateway`, `epoch` and `batchId`. The proof retains the existing `batchId`, `messageId`, `index`, `leafCount` and `siblings` metadata.

`MessageBatchCodec` recomputes the original typed ABI/Keccak batch commitment from version 1 and the full nonempty, unique, ordered ID list. Supplied membership cannot replace the trusted expected batch ID. The verifier derives count from that list, checks `orderedMessageIds[position] == messageId`, and requires the proof's batch/message/index/count metadata to agree. Positions stay `uint256`; an out-of-range position is rejected before array access. The shared Merkle kernel reconstructs the typed leaf, derives exact depth, preserves left/right order, enforces self-duplication at every unpaired level and compares the final node with the expected root. A single leaf requires an empty path.

The caller must first authenticate the exact source scope, batch epoch/ID and Message Root through `PBFTCertificateVerifier`, then use the identical context/root for inclusion. The Merkle verifier does not call or replace the QC verifier. A valid standalone path under a self-selected root grants no QC authorization. DestinationGateway verifies the QC first and passes the same decoded batch context and authenticated root to inclusion verification.

Full ordered membership costs O(N) calldata. Duplicate checking sorts one O(N) scratch copy in O(N log N), without changing the committed order; the batch ID is hashed once and one O(log N) proof path is folded. The primitive preserves its original encoding. Product construction and DestinationGateway execution cap membership at 128; payload and raw-package limits are documented below.

This verifier accepts canonical message IDs only. It does not reconstruct `CrossChainMessage` fields, enforce message version/domain/routing/deadline policy, prevent replay or execute Application B. Batch encoding version 1 is distinct from message-version and QC-version policy.

### MessageDomainVerifier

`contracts/src/MessageDomainVerifier.sol` reuses `MessageCodec.CanonicalMessage` and its original typed ABI/Keccak encoding. `verifyMessage(message, payload, expectedMessageId, expectedDestinationGateway)` is view-only and returns `true` or a precise custom-error revert. The caller must pass the same message ID already authenticated by Merkle inclusion under the verified QC root, and obtain the expected Gateway from independent destination policy. The input structure contains `version`, `sourceDomain`, `sourceGateway`, `sourceSender`, `destinationDomain`, `destinationGateway`, `destinationReceiver`, `nonce`, `payloadHash` and `deadline`; raw payload is supplied separately and its Keccak hash must match the committed `payloadHash`.

The SourceGateway and destination verifier share the existing message version constant `2`. The verifier rejects every other uint8 version, even with a self-consistent recomputed ID. Message version is independent of batch encoding version, relayer transport version and QC version. `computeMessageId(message, payload)` is an encoding-parity helper without acceptance policy; being able to encode an unsupported version grants no permission.

The constructor binds a nonzero code-bearing remote registry with the expected getter/pair semantics and an explicit nonzero local protocol domain. Chain B verification uses domain `2001`; deployment checks network chain ID separately. The contract reads the registry's current exact `sourceDomain → sourceGateway` record on every verification, preserving unknown-domain, mismatched-address, replacement and removal semantics. It performs no remote Gateway bytecode check on Chain B and adds no historical Gateway authority or sender allowlist. Replacing remote trust can reject an unchanged old message at this policy boundary without changing its historical ID, QC or Merkle proof.

The message destination domain must match the configured local domain and differ from its source domain, as required by SourceGateway. Its Gateway must be nonzero and equal the trusted caller's expected target; it is not bound to the verifier's own address. The receiver must be nonzero and remains exactly ID-bound, with no code-presence requirement, receiver registry or business-permission inference. Sender, nonce, raw payload/hash and deadline are bound through the unchanged canonical identity. Nonces do not become destination replay state, and existing empty-payload semantics remain supported.

Destination verification independently requires `block.timestamp < deadline`, matching SourceGateway: the instant equal to the deadline is already expired. QC agreement and membership authenticate historical intent but cannot extend freshness. Expiry leaves source history, committed evidence and READY packages unchanged. Domain verification is stateless; repeated checks before expiry can succeed. Exactly-once acceptance is supplied separately by internal replay consumption; invoking this verifier never consumes an ID. No receiver call, ETH transfer, Application B update or destination role grant occurs.

Unified verification reuses existing canonical vectors, then composes QC, inclusion and full-message checks for real historical A/B/D and rotated Message E. It compares original IDs across SourceGateway, Indexer, destination encoding and recovered delivery packages. It verifies cross-domain/Gateway rejection, field mutations and correctly rehashed receiver/payload/domain variants that the original root does not authorize. A comparison verifier configured for domain `3001` runs on the existing Chain B solely to exercise domain separation; no third chain is started. After transport workers stop, temporary remote-trust replacement and destination-time advancement run within a reversible Chain B snapshot. Authentic expired messages retain valid QC/Merkle evidence but fail deadline policy. Historical durable source/package data is not rewritten.

### Destination replay protection

`contracts/src/MessageReplayProtection.sol` is a minimal abstract storage component. It exposes `isMessageExecuted(bytes32 messageId)` as a public view query and `_consumeMessage(bytes32 messageId)` for internal use by the inheriting contract. Every full-width canonical ID starts unconsumed. The first successful consumption sets it to `true`; every later consumption reverts with `MessageAlreadyExecuted(messageId)`, including delivery by a different account. Duplicate delivery never silently reports a new acceptance.

The key is the canonical message ID, independent of nonce alone, batch position, QC/proof representation, delivery metadata, sender account or destination transaction hash. Same payloads with distinct canonical IDs, the same nonce in distinct source domains and out-of-order delivery remain independent. There is no public arbitrary-consume production endpoint, external replay registry, administrator, reset, deletion, replay window or pruning. Consumed IDs remain recorded for the lifetime of that contract's storage, regardless of deadlines, source trust replacement or validator rotation. No new zero-ID meaning is introduced; the caller's existing canonical verification determines valid message identity.

DestinationGateway validates the QC, ordered membership and original full message first, consumes the authenticated ID second, and enters application code last. Consumption is set before a callback, so nested acceptance of the same message sees it as consumed. If downstream execution fails, the failure must propagate: the whole EVM transaction, including the mapping write and any nested writes, rolls back. The same message may then be retried. The primitive supplies no global reentrancy lock. The production Gateway rejects same-message reentry and permits a different independently valid message to execute during a callback.

Relayers provide at-least-once transport, and duplicate retries after crashes remain possible. The internal on-chain guard supplies exactly-once consumption within one deployed destination state domain. Worker leases, transaction nonces, receipts and PostgreSQL flags do not provide this authority. Destination-chain reorganization follows canonical EVM storage: removing a successful acceptance block also removes its state update. The Transaction Manager's bounded receipt passes revalidate previously terminal destination observations and reconcile positively proven replacement history. Source credential/nullifier replay and destination message replay protect different identities and remain separate.

Production replay state belongs to DestinationGateway. `AuthenticatedMessageReplayHarness` lives under `contracts/test/mocks/` and composes the existing QC, Merkle and message-domain verifiers in one transaction before internal consumption. Expected batch context is supplied by the verification fixture, and the expected destination Gateway is bound independently at deployment. Its test ABI remains isolated from the production execute(bytes) transport. It exposes no unchecked raw consumption. The separate unit harness does expose raw consumption solely to test the primitive; it is not deployed as destination authority.

An isolated replay-regression scenario deploys test-owned replay and receiver contracts on the existing Chain B; the complete flow also deploys the production Gateway and Application B. It reuses actual A/B/D and rotated Message E: A is consumed once and rejected from both original and alternate submitters while unchanged upstream evidence remains valid; B remains unconsumed after invalid QC, Merkle, domain and downstream failure, then succeeds on retry; D exercises callback-visible state, exact same-message reentry rejection, outer rollback and retry. E stays unconsumed until controlled expiry, when valid QC/Merkle evidence cannot bypass the deadline or burn its ID. Consumed A/B/D remain recorded through the reversible registry/time scenario. Existing source history, packages, roots, signatures, Relayer target and production transaction manager are unchanged.

`ReplayTestReceiver` observes only test callback behavior; its address is passed separately for atomicity checks and does not replace the canonical destination receiver. The alternate submitter uses a separate public local development identity outside the five-validator directory; Anvil fixture funding does not consume the production Tx Manager account's nonce or transfer ETH from it. These replay fixtures implement no application supplier grant, production ETH transfer or automatic production destination state change. The production submission ABI, execution event and practical package bounds are defined by DestinationGateway and its shared delivery policy.

### Destination supplier application

`contracts/src/ApplicationB.sol` records `VERIFIED_SUPPLIER` as a simple address-keyed boolean on Chain B. `isVerifiedSupplier(address)` reports the current business state. Its only mutation path is the nonpayable `ICrossChainReceiver.handleCrossChainMessage(bytes32 messageId, bytes payload)` entry. The constructor binds one immutable, nonzero `destinationGateway`; it does not require code at construction or offer a Gateway setter. Calls are authorized by the exact `msg.sender` address. Direct users, Relayers, Tx Manager signers and other contracts have no permission, including a contract with identical Gateway bytecode. `tx.origin` grants no authority.

The Gateway performs protocol authentication and replay consumption; the application only interprets the authenticated business intent. It has no QC/Merkle verifier, source registry, deadline check, credential proof input or second message replay mapping. The receiver address is Application B; the destination Gateway is a separate verification/execution authority. DestinationGateway calls this exact receiver after validating the package and consuming the message ID. Application errors propagate and roll back both replay consumption and business effects atomically.

The supplier command has exactly this ABI:

```solidity
abi.encode(uint8(1), uint8(1), supplier)
//             version   action  address
```

The payload is exactly 96 bytes: three canonical ABI words for `uint8 version`, `uint8 action` and `address supplier`. Version `1` and action `GRANT_VERIFIED_SUPPLIER = 1` are the only supported values. Short, empty, packed, wrapped or trailing-byte payloads and dirty scalar/address padding revert with `InvalidBusinessPayload`. Unsupported canonical versions/actions and zero suppliers have precise business errors. The command namespace is independent of message version `2`, Source A forwarding action `3`, credential roles and QC/transport versions.

The explicit supplier comes from the payload; it is not derived from a credential subject, source sender, receiver, Relayer or transaction caller. Source proof authorization can bind this payload as exact public forwarding intent, without proving EVM ownership of its supplier address. Private credentials, Groth16 proofs and witness material are not sent to Application B. No additional supplier authorization hash is introduced. Indexer, validators and transport continue treating application payload as opaque bytes.

An initial valid grant changes only the intended supplier from `false` to `true` and emits `VerifiedSupplierGranted(bytes32 indexed messageId, address indexed supplier)`. The message ID provides event correlation, not application replay authority. A later grant for the same supplier reverts with `AlreadyVerifiedSupplier(supplier)`, even with a different message ID. This is a redundant business transition, separate from Gateway message replay. Other suppliers remain independent. There is no administrator grant, owner bypass, revocation, enumerable directory, token/payment logic or upgrade/governance framework.

`test-vectors/application-b-commands.json` independently freezes two command payloads and their exact expected ABI bytes. Solidity tests and the verification JS encoder compare against these bytes without regenerating them. These commands define canonical business payloads; historical A/B/D/E messages retain their original arbitrary payloads, identities and proofs. No old payload is reinterpreted as a supplier grant.

An isolated application-boundary scenario deploys a separate instance of the production application contract on Chain B (`2001`) and binds it to a clearly identified `MockDestinationGateway` test caller. A second instance with identical code proves address-specific authorization. The mock only forwards the exact receiver call and intentionally performs no protocol validation or replay mutation. Direct EOA/Relayer-like calls and the untrusted contract must fail with unchanged state and no grant event; the trusted caller must change the exact supplier state and emit its correlated event. Malformed, unsupported, zero-supplier and redundant commands fail, while the second supplier can be granted independently. Fixtures use public local development identities without consuming the production Tx Manager account's nonce.

This isolated application test uses correlation labels rather than claiming real source-authenticated messages. It does not connect the real Relayer, consume replay state or replace any existing destination target. A separate production flow composes QC → Merkle → message-domain → replay → Application B through real source authorization, consensus, Relayer and Tx Manager execution, as documented below. Application B events are not yet indexed into a destination database.

### DestinationGateway execution

`contracts/src/DestinationGateway.sol` is the production destination trust boundary. Its only submission entry is nonpayable `execute(bytes packageBytes)`. There is no raw-package fallback, Relayer allowlist, admin execution bypass, mutable verifier pointer, arbitrary-call entry or ETH forwarding. Constructor dependencies are nonzero, code-bearing and immutable. Existing registry authority and verifier APIs remain authoritative; the Gateway copies no validator or remote-gateway registry state.

```text
Credential → fresh exact-intent ZK authorization → IdentityApplicationA → SourceGateway
  → Indexer → fixed-head finality → bounded batch / ordered Merkle root
  → real PBFT QC → COMMITTED → durable READY delivery package
  → untrusted Relayer → persistent Transaction Manager → Chain B execute(bytes)
  → QC → Merkle → full message/domain → consume messageId → ApplicationB
  → VERIFIED_SUPPLIER
```

The Gateway checks canonical envelope encoding and bounds first, decodes one coherent package snapshot, and calls the existing `verifyCertificate`, `verifyInclusion` and `verifyMessage` APIs. Certificate statement metadata uses the existing QC codec; the existing verifier remains responsible for all signatures and historical authority. Batch/root/source expectations come from that same snapshot. v3 resolves its signed exact validator epoch; legitimate v1/v2 retain immutable initial-authority eligibility without a new batch cutoff. Merkle membership and complete message reconstruction must authenticate the identical message ID. DestinationGateway passes its own `address(this)` as the expected target, so a valid package for another Gateway cannot execute here.

After all protocol checks, the authenticated receiver must have bytecode. The Gateway consumes the message ID and invokes exactly `ICrossChainReceiver(destinationReceiver).handleCrossChainMessage(messageId,payload)` with zero value. Receiver failure propagates and rolls the entire transaction back, including replay storage and all success events. Same-message reentry fails at the consumed ID; a different independently valid message may execute during a callback. A successful callback is followed by `CrossChainMessageExecuted(messageId,sourceDomain,destinationReceiver,batchId)`. ApplicationB emits its separate `VerifiedSupplierGranted` business event in that same transaction.

Relayer transport can be repeated; on-chain successful execution is exactly once per canonical message ID within the canonical Gateway deployment state. Replay and business status are separate: a different valid message granting the same supplier can fail with `AlreadyVerifiedSupplier`, leaving that new ID unconsumed. A canonical reverted Tx Manager receipt is terminal `REVERTED`; deterministic business rejection is not retried indefinitely. Both successful and reverted terminal observations remain subject to destination canonicality revalidation. A later reorganization can invalidate their current outcome without erasing the historical receipt.

### Submission convention and practical bounds

The inner ABI remains exactly transport version 1 (`CrossChainDeliveryPackage`). Message, batch, full ordered membership, Merkle and v1/v2/v3 QC encodings are unchanged. Production calldata is one standard ABI function wrapper around those exact bytes:

```text
execute(bytes)
  selector + offset + length + unchanged canonical transport-v1 envelope
```

The package digest still hashes only the original inner envelope. `encodeDestinationSubmission` preserves its original raw encoding; `encodeGatewaySubmission` adds the sole production wrapper. Normal new Tx Manager intents sign the wrapped bytes. Existing raw-envelope persisted intents are recognized only by exact equality against their independently re-derived original encoding, retaining their nonce, target, signed attempts, hashes and receipts. No migration or historical transaction rewrite is used. A historical transaction sent to an EOA is never reclassified as a business execution.

The committed policy is `test-vectors/delivery-policy.json`, mirrored by `DeliveryPolicy.sol` with cross-language checks:

| Boundary | Maximum |
| --- | ---: |
| Source and destination message payload | 4,096 bytes |
| Ordered batch membership | 128 messages |
| Merkle depth | 7 |
| Raw inner package | 11,232 bytes |
| Wrapped Gateway calldata | 11,300 bytes |

The package bound follows the actual ABI: `320 + 64 + 224 + 4544 + 4288 + 256 + 1536 = 11232`. These terms cover the envelope head, domain, at most 192 bytes of full-width delivery-job identity, message bytes with the maximum payload, full batch membership, seven siblings, and the existing maximum 1,504-byte four-signature QC. Canonical ABI padding is included. Limits do not enter any message, batch, Merkle or QC hash. Domain, nonce, batch epoch, view and validator epoch retain uint256 semantics.

128 members keep full membership calldata and the existing O(N log N) duplicate check bounded while allowing substantially larger batches than the small compatibility fixtures. The current local Chain B configuration records a 30,000,000 block gas limit. A maximum-size composed Solidity test checks that budget; its result is determined by the user's verification run. Production transactions retain real `eth_estimateGas` and existing fee/replacement semantics, without a fixed gas override. Arbitrary receiver logic can still revert or exhaust gas; no payload cap guarantees arbitrary application success.

SourceGateway rejects oversized payloads before nonce allocation or event emission. The source application's transaction also rolls back its nullifier on failure. Lifecycle collection takes the first canonical unassigned messages up to remaining capacity; overflow stays eligible for the next batch and is not marked assigned. Explicit assignment fails atomically above capacity. Relayer preflight and the Gateway enforce matching bounds; on-chain checks remain authoritative. Historical sealed/committed snapshots and frozen fixtures are never rewritten.

`test-vectors/destination-transport.json` freezes complete inner bytes, outer calldata, selector, target, zero value, package digest and the original signed QC for cross-language parity. It uses the existing opaque-payload compatibility fixture; no historical payload becomes a supplier command. Normal verification only reads it. Its explicit offline authoring helper uses exclusive file creation and is not called by `verify.sh`.

### Real source-to-destination verification

The sole root entry, `./scripts/verify.sh`, deploys the production Gateway on Chain B (`2001`) using the existing registries and verifier contracts, then deploys ApplicationB with that exact Gateway authority. The isolated mock-caller application checks remain separate regressions; no mock or replay harness is authority in the production positive flow.

After preserving historical A/B/C/D/E and rotation/recovery checks, the existing validator cluster processes fresh exact-intent-authorized business messages. The real source Indexer observes each event and the Finality Watcher advances it before normal batch sealing, PBFT commitment and READY projection. Production Relayer/Tx Manager components sign, persist and broadcast the exact zero-value Gateway transaction, and canonical confirmation is followed by direct replay/business-state reads and exact event correlation. Supplier identity comes solely from the authenticated command and differs from the private subject, executor, validator, deployer and transport identities.

A second distinct valid message is prepared while the supplier is still unverified, then delivered after the first grant. Its original gas estimate and signed bytes are retained; the ordinary Tx Manager observes the actual `AlreadyVerifiedSupplier` transaction as `REVERTED`, with no replay consumption. Fresh normal recovery/rerun must create no new intent, nonce or signed attempt. Controlled alternate callers replay the successful package and exercise precise failed boundaries without using the exclusive Tx Manager EOA. A separate real authenticated EOA-receiver message must fail the executable-receiver check. Temporary source-trust/time tests restore only their owned Chain B snapshot. PostgreSQL records no supplier-authority state, and no destination application indexer is introduced.

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
    2,
    credentialIdField,
    applicationDomain,
    policyEpoch,
    actionContext,
    forwardIntentDigestHi,
    forwardIntentDigestLo
)
```

The leading `2` is the nullifier version. `applicationDomain` retains its existing deployed-application and chain namespace:

```text
keccak256(
    abi.encode(
        keccak256("cross-chain:identity-application-domain:v1"),
        chainId,
        applicationAddress
    )
) mod BN254_SCALAR_FIELD
```

`policyEpoch` starts at `1` and advances by one; it is independent of validator epochs. Action `1` is standalone supplier verification, with both intent limbs constrained to zero. Action `3` authorizes one exact forwarding intent. The same credential, application, epoch, action and intent produce the same nullifier, so that authorization can be consumed once. Distinct intents have distinct authorization contexts. Definitions and relations are in `zk/nullifier.json` and `test-vectors/nullifiers.json`.

### Circuit statement

`zk/circuits/CredentialAuthorization.circom` proves that:

- the prover knows private credential fields matching the public `credentialCommitment`;
- the private `issuer` equals the public policy value `trustedIssuer`;
- the private `role` equals the public policy value `requiredRole`;
- `currentTimestamp < authorizationValidUntil <= expiry`;
- `currentTimestamp`, `authorizationValidUntil` and private `expiry` all fit in uint64;
- the active leaf derived from `credentialCommitment` belongs to the public `credentialStateRoot`.
- the public `nullifier` binds the private `credentialId`, application, epoch, action and both forwarding digest limbs;
- each forwarding limb fits in uint128; standalone verification constrains both to zero.

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
forwardIntentDigestHi
forwardIntentDigestLo
authorizationValidUntil
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
    uint256[12] publicSignals
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
[9] forwardIntentDigestHi
[10] forwardIntentDigestLo
[11] authorizationValidUntil
```

Proof coordinates are converted with snarkjs `groth16.exportSolidityCallData`, including the required G2 coordinate ordering. The same generated calldata is used by Forge tests and Chain A integration verification.

The Solidity verifier establishes that a Groth16 proof is valid for the supplied public signals. It does not decide which issuer is trusted, which role an application should require, or whether a caller may send a cross-chain message.

`currentTimestamp` is a public input bound by the proof. The credential adapter passes it to the generated verifier without applying wall-clock policy. `IdentityApplicationA` performs the corresponding comparison against `block.timestamp`.

Credential expiry, authorization execution deadline and proof freshness are distinct. The circuit proves `currentTimestamp < authorizationValidUntil <= expiry`; Application A requires `block.timestamp < authorizationValidUntil`, independently of `currentTimestamp <= block.timestamp` and `block.timestamp - currentTimestamp <= maxProofAge`. Consequently, a successful authorization executes strictly before private credential expiry. Equality with the authorization deadline is rejected as `AuthorizationExpired`. Future and stale proofs retain their separate errors and policy checks.

`authorizationValidUntil` is a prover-selected, per-proof public deadline. It is not a public credential-expiry field: observers learn the bound `expiry >= authorizationValidUntil`. Exact expiry remains a private witness, although a prover's deadline selection can disclose information about it. Equality with private expiry is allowed, so a credential with only one second remaining can still produce a valid proof and execute before that deadline. There is no fixed one-hour circuit buffer. The development proof helper defaults to a two-hour authorization window chosen independently of `maxProofAge`; callers can explicitly select another deadline, including a shorter near-expiry window. The helper does not silently publish or clamp the deadline to private expiry.

The authorization statement contains twelve public signals; the original eleven meanings and positions are unchanged and the new deadline is appended at index 11. Previous eleven-signal proofs are incompatible. The existing root workflow rebuilds the circuit, R1CS/WASM, development proving/verification keys, generated Solidity verifier and proof fixtures together, then deploys the new verifier, adapter and Application A and authorizes that exact application in SourceGateway. Verifier references are immutable, so old deployments do not automatically acquire the new statement. No legacy-verifier authorization fallback or fictitious nullifier migration is provided. Historical source messages, message IDs, batches, Merkle roots, QCs, transport and destination execution remain unchanged and require no re-proving or rewrite.

### ZK security regression boundaries

The single `./scripts/verify.sh` workflow includes `[ZK security invariants]` checks across the actual circuit, off-chain Groth16, generated Solidity verifier/adapter, and deployed Application A/SourceGateway. Deterministic credential inputs and the existing development proving flow supply real positive baselines; no mock verifier substitutes for cryptographic acceptance.

- Credential binding checks cover substituted private subject/credential ID/expiry, another credential's membership path, A's proof claiming B's commitment, and legitimate independent A/B credentials.
- Issuer and role checks distinguish an invalid witness from a cryptographically valid alternate-issuer or `AUDITOR` proof rejected by the application's current policy, including exact-intent forwarding.
- Circuit time cases cover the shortest valid window, deadline equality with private expiry, deadline equality/before proof time, deadlines beyond private expiry, uint64 overflow/field-wrap candidates and credentials expired at proof time. Genuine valid proofs separately exercise future/stale timestamp policy and authorization-deadline rejection.
- Revocation rotates the real active-state root through its authority. A previously admissible, unused forwarding context with the correct current epoch/action remains cryptographically valid but is rejected under the new root. B remains usable; consumed nullifiers, original proofs and previously emitted source evidence are retained.
- All twelve public signals are mutated independently while retaining the original valid proof. Off-chain and Solidity checks require explicit `false`; unexpected exceptions fail verification. Shared snarkjs calldata preserves G2 coordinate order. A genuine historical eleven-signal proof is first checked against its captured historical key and then rejected by the upgraded verifier under a complete, well-formed twelve-signal statement. Destination domain/Gateway/receiver, payload, message deadline and executor mutations also exercise exact-intent rejection.
- Exact and independently regenerated proofs cannot consume the same standalone or forwarding nullifier twice. Changing only `authorizationValidUntil` creates no new replay identity. Separate legal application domains, policy epochs, actions and forwarding intents retain their own valid contexts.

Application-level negative cases compare consumed nullifiers, credential status, current root, policy epoch, Gateway nonce and authorization/source events. Ordinary rejection cases submit real reverting transactions after matching the precise simulated custom error; the deliberately unowned executor is checked through a read-only simulation. Owned EVM snapshots isolate these checks and restore their state before the retained lifecycle/E2E verification continues. Witness calculation errors, RPC failures, malformed artifacts and unexpected EVM errors cannot credit a security rejection.

The execution-time regression runs after the retained full E2E checks and restores its own snapshot even when an assertion fails. It preserves the former boundary exactly: `proofTimestamp = expiry - 1`, `authorizationValidUntil = expiry`, execution at expiry. The proof must remain cryptographically valid; the actual transaction must fail precisely as `AuthorizationExpired`, with nullifier unused, unchanged authorization/root/epoch/nonce and zero new source or authorization events. Both standalone and forwarding paths include exact mined-time controls for success one second before the deadline and rejection at/one second after it. Results await the user's regenerated artifacts and complete verification run; these deterministic regressions are not a formal proof or a randomized/stateful campaign.

### Identity application on Chain A

`contracts/src/IdentityApplicationA.sol` consumes the stable `CredentialVerifier` interface and owns the business policy. Its deployment configuration contains:

- the credential verifier address;
- the source gateway address;
- one trusted issuer field value;
- the required role, fixed to the existing `VERIFIED_SUPPLIER = 1` encoding;
- a non-zero maximum proof age;
- a non-zero credential-state authority;
- a non-zero initial credential-state root.

`verifySupplier` accepts proof coordinates and the twelve-field public-input struct, with the standalone action and zero intent limbs. It checks issuer, role, freshness, authorization deadline, current root, revocation, application domain, policy epoch and nullifier replay before verification. A successful verification atomically sets:

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

`IdentityApplicationA.forwardAuthorizedMessage` accepts proof coordinates, public inputs and a request with destination domain, Gateway, receiver, payload and deadline. It computes an intent using the actual source chain, own address, immutable source Gateway, message version `2`, action `3`, request fields and `msg.sender` as authorized executor. Payload hashing is performed by the contract.

Its independent type separator is:

```text
ForwardAuthorizationIntent(uint8 protocolVersion,uint256 action,uint256 sourceDomain,address application,address sourceGateway,uint256 destinationDomain,address destinationGateway,address destinationReceiver,bytes32 payloadHash,uint256 deadline,address authorizedExecutor)
```

The digest is Keccak-256 of the Ethereum ABI encoding of the type hash followed by those fields. Its full 256 bits become `hi = uint256(digest) >> 128` and `lo = uint256(digest) & (2**128 - 1)`. Each limb is range-constrained and participates in the circuit's Poseidon nullifier derivation. No field reduction is applied to this digest. Fixed ABI words, original eleven signal positions and limb cases in `test-vectors/forward-authorizations.json` are preserved; current JavaScript/Solidity mapping checks append the authorization deadline without rewriting those frozen words. `authorizationValidUntil` is bound by the proof and is absent from both the forwarding digest and nullifier preimage.

The application requires matching public limbs, applies all credential checks, verifies Groth16, consumes the nullifier, then forwards the exact request. A failed Gateway call rolls the consumption back. `AuthorizedMessageForwarded` links intent digest, nullifier and message ID without private fields. Another executor or altered intent cannot use that proof to authorize its call.

After deployment, the source-authorization administrator explicitly authorizes `IdentityApplicationA` in the Gateway registry. The deployment flow performs this transaction only after confirming that the application was created at its predicted address, preserving the application-domain value used by the generated proofs.

There is no production no-proof forwarding entry point. Standalone supplier status permits no arbitrary subsequent messages. The Gateway remains credential-unaware and owns the canonical source nonce; the intent does not predict it. The final public message retains its version-2 encoding and message-ID algorithm. Its ID includes the Gateway nonce and is distinct from the authorization digest.

The executor is the authorized submitter of that operation. This binding establishes no EVM identity for the private subject and automatically grants no destination role. Private witnesses stay with the prover; Groth16 proofs are verified on Chain A and are absent from messages, batches, QCs and delivery packages. Validators/QCs authenticate canonical public source events and batches under the trusted-application model. DestinationGateway independently authenticates that public evidence, enforces message policy and replay protection, and calls the message's exact receiver on Chain B.

Exact proof-to-message binding applies to the current `IdentityApplicationA.forwardAuthorizedMessage` path. SourceGateway itself remains credential-unaware, and other authorized applications are responsible for their own admission policy. Retained historical messages, compatibility fixtures and signed transactions are not rewritten or retroactively claimed to have used this exact-intent flow.

Unified verification generates fresh intent-bound proofs using the deployed application's current root, epoch and block time, reusing one WASM/zkey. Real A/B/C/D/E messages use the protected production entry point. Mutations reuse a valid proof, and source reorg/finality, consensus, delivery and transaction recovery checks retain their original boundaries.

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

The independent Finality Watcher captures one fixed Chain A head per pass and reconciles canonical block history before evaluating any message. It then evaluates `OBSERVED` or `FINALIZING` messages in the configured chain domain and source Gateway whose source block is at or below that captured head, inside one PostgreSQL transaction. Every candidate uses the same fixed head. Separate current-head reads used to confirm a suspected source rollback do not move this evaluation snapshot.

The configured policy is:

```text
headBlock >= sourceBlock + FINALITY_BLOCK_DEPTH
```

The depth counts successor blocks. At depth `2`, a source message in block `N` becomes final at head `N + 2`. Equality is sufficient. A depth of `0` immediately finalizes a message when its source block is at or below the watcher head and provides no confirmation-depth protection.

Production deployments may configure any valid non-negative uint256 depth for their source-chain policy. The repository's deterministic full-verification fixture uses a fixed successor depth of `2`; that fixture constraint does not restrict the production loader or change finality semantics.

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

1. lock the source cursor, recheck the observed cursor, indexed head and probe, and lock the persisted common ancestor;
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

The Finality Watcher runs independently from the Indexer, and one active instance of each may run concurrently. Its one-shot mode captures one Chain A head `H` for reconciliation and finality evaluation, while continuous mode repeats passes with `FINALITY_POLL_INTERVAL_MS` between them. Each pass queries only persisted `OBSERVED` and `FINALIZING` occurrences at or below `H`. An Indexer may commit blocks and messages above that snapshot while the watcher is running; a matching canonical snapshot prefix preserves those blocks, messages, and the advanced cursor. Newer occurrences remain available for a later watcher snapshot. A restarted watcher uses the same durable queries and does not depend on an in-memory pending-message list.

A stored indexed head above `H` does not by itself establish a source reorganization. The reconciler obtains separate current-head evidence to distinguish a stale caller snapshot from an actual chain rollback; this does not change `H` for scanning, block-depth calculations, or lifecycle decisions. Only verified canonical divergence or a confirmed rollback triggers destructive recovery. A confirmed rollback retains the still-canonical suffix through its actual head, even when that head is above the caller's older snapshot. Before mutation, the existing cursor-locked transaction checks the observed cursor, indexed head, probe, and common ancestor. If another worker has changed that recovery premise, reconciliation rechecks the same fixed snapshot. Source RPC calls remain outside the write transaction.

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

The standalone `createMessageBatcher({ config, pool })` selects at most the first 128 canonically ordered `FINALIZED` source occurrences in the configured `chainDomain` and `sourceGateway` scope through the existing `listBatchEligibleMessages` query. Its `buildBatch({ epoch })` operation requires an explicit uint256 epoch and returns `undefined` when no finalized messages are available. This standalone builder does not filter lifecycle ownership. The persistent lifecycle described below instead seals only a particular batch's assigned occurrences. The batch epoch is independent of the identity application's policy epoch and the validator-set epoch.

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

Standalone batch construction reads source data and returns an immutable value. It does not persist a batch record, reserve finalized rows, rotate epochs, or change finality state. If the finalized set grows, a new standalone construction may produce different membership and a different batch ID even when the caller reuses an epoch. The persistent lifecycle freezes membership at sealing; batch construction itself supplies no destination replay authority. Successful message consumption is enforced separately by DestinationGateway.

PostgreSQL provides durable operational state; Chain A remains the source history authority. Constructing or sealing a batch grants no Chain B authorization, validator approval, quorum certificate, or delivery guarantee. The batch feeds the off-chain Merkle commitment and subsequent PBFT vote/QC path. Relayer A/B transport independently verified committed packages through the Persistent Transaction Manager; DestinationGateway then verifies the QC, inclusion and full message before replay consumption and receiver execution.

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

The Message Root commits to ordered batch membership. Its expected batch and root still require an appropriate trust source; a valid proof by itself grants no Chain B authorization, Byzantine consensus, quorum certificate, or delivery guarantee. `MerkleInclusionVerifier` binds the count to the full canonical ordered list and expected batch ID. PBFT signatures are verified separately through the QC primitive. The same authenticated member ID is then checked against full fields and current destination policy by `MessageDomainVerifier`. Relayer A/B carry existing evidence unchanged; DestinationGateway composes those verifiers with message-ID replay protection and atomic receiver execution.

## Shared Merkle Compatibility

`contracts/src/MessageMerkle.sol` is a pure internal library with `computeLeaf`, `hashNode`, `verifyProof` and `requireProof`. Both verification interfaces share one kernel; `verifyProof` retains its boolean semantics and `requireProof` provides precise custom errors. It uses the same Ethereum Keccak-256 domains and `abi.encode` preimages as the off-chain implementation. It preserves left/right order, derives exact depth from the leaf count, rejects empty trees and out-of-range indices, and enforces self-duplication whenever traversal reaches an unpaired final node. A single leaf is its root and requires an empty sibling path. Invalid proofs return `false` through the boolean API.

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

Unified verification also checks the existing fixed 1/2/3/4/5-leaf vectors through the deployed Chain B facade: canonical batch IDs, leaf/node hashes, every member position and precise-error negative cases. The existing five-validator rotation scenario first authenticates the actual old A/B/D QC and rotated Message E QC, then verifies every inclusion under the same trusted expectations. It rechecks unchanged old proofs after rotation and V1 shutdown, exercises actual odd/single-leaf paths and rejects an old QC for a different root even when a standalone Merkle path under that root is valid. Dynamic evidence never overwrites the frozen fixture.

## Batch Lifecycle

`createBatchLifecycle({ config, pool })` manages one configured source domain and Gateway through PostgreSQL. It requires an existing Indexer cursor for that scope. The conceptual lifecycle is:

```text
BUILDING → SEALED → CONSENSUS_PENDING → COMMITTED
                                      (verified COMMIT quorum certificate)
```

A sealed batch is an immutable message commitment, and a pending batch awaits a verified COMMIT quorum certificate. Local `PREPARED` or `COMMIT_QUORUM` alone cannot change its status. `commitWithCertificate({ certificate })` independently verifies the QC against the persisted batch and trusted validator history, then atomically persists the certificate and transitions to `COMMITTED`. Current v3 batches pin a validator epoch and committee digest before consensus; QC verification resolves that exact historical committee and checks the pinned binding. Legacy v1/v2 evidence retains its original initial-committee authority without inventing signed epoch fields. Ordinary status updates without matching complete QC evidence fail the database guard. `COMMITTED` is terminal.

Migration `005_batch_lifecycle.sql` adds two tables:

- `message_batches` stores the operational `batch_record_id`, source scope, exact uint256 epoch, status, version, protocol `batch_id`, Message Root, message count, and transition timestamps.
- `message_batch_members` references authoritative `source_messages` rows and records each canonical message ID and its sealed position. It stores no alternative JSON message snapshot.

`batch_record_id` identifies a database record; it is distinct from the deterministic protocol `batchId`. A `BUILDING` record has no final batch ID, root, count, or canonical positions. An empty building batch is allowed, but cannot be sealed. Only `FINALIZED` occurrences in the configured scope can be assigned. A source occurrence belongs to at most one lifecycle batch, enforced by a database uniqueness constraint. Source messages retain their original status, fields, provenance, and finality timestamps.

Creation, collection, assignment, sealing, and pending transitions use transactions and lock the existing source cursor row without changing its value. A partial unique index permits only one `BUILDING` batch per scope; `(source_domain, source_gateway, epoch)` is also unique. The first creation requires an explicit `initialEpoch`. Later creation derives exactly `latestPersistedEpoch + 1`, never from process memory or a caller-selected replacement. A repeated supplied seed must match the initial persisted epoch. Uint256 overflow fails without creating a new record.

The lifecycle API exposes:

| Operation | Result |
| --- | --- |
| `getOrCreateBuilding({ initialEpoch } = {})` | Create or recover the building snapshot |
| `collectEligible({ initialEpoch } = {})` | Assign the next canonical unclaimed finalized occurrences up to remaining capacity; return `{ snapshot, assignedCount }` |
| `assignMessages({ batchRecordId, sourceMessageIds })` | Assign explicit eligible occurrence IDs with the same ownership rules; return `{ snapshot, assignedCount }` |
| `sealBatch({ batchRecordId, expectedBatchId?, expectedMessageRoot? })` | Atomically seal, or recover the identical sealed snapshot |
| `readBatch({ batchRecordId })` | Read and validate a durable snapshot |
| `markConsensusPending({ batchRecordId })` | Advance a sealed snapshot to pending; repeated calls are idempotent |
| `commitWithCertificate({ certificate })` | Verify and persist QC evidence while atomically committing its exact pending batch; equivalent retries preserve the original QC |

Collection counts the current BUILDING membership before selecting candidates. SQL filters the configured source scope, `FINALIZED` status and absence from any lifecycle batch, then applies the existing canonical order and a limit equal to remaining capacity. Only the needed unassigned candidate rows and their payloads are returned to the application. A full BUILDING batch performs no candidate query, returns zero assignments and stays unsealed. Overflow remains FINALIZED and unassigned for the next batch; historical rows are retained. This bounds candidate materialization, without claiming constant database execution cost.

Explicit assignment loads only the requested database IDs and checks their scope, status, canonical message and ownership in request order. Duplicate requests and existing members of the same batch are idempotent; another batch's ownership remains an explicit conflict. An oversized request or any later failure rolls back all assignments in that transaction. Collection reuses its selected rows inside the same lifecycle transaction, with no public trusted-row parameter. The standalone `listBatchEligibleMessages(scope)` API continues returning the full canonical FINALIZED list, including assigned history; its standalone batcher semantics are unchanged.

Snapshots contain `{ record, members, batch, tree }`. Building snapshots have `batch: null` and `tree: null`. Sealed snapshots reconstruct the existing batch representation and Merkle result, including every inclusion proof. Current v3 consensus snapshots also carry the immutable `consensusBinding`: protocol version, validator epoch and committee digest. Committed snapshots additionally contain an independently verified `quorumCertificate`. Readers resolve the committee from trusted immutable history and compare it with the batch binding; historical v1/v2 reads preserve their initial/static authority semantics. Protocol values remain `BigInt`; operational timestamps and record IDs do not enter any protocol hash.

Sealing runs the existing canonical builder over the assigned source occurrences, validates the resulting batch, builds its Merkle tree, and persists all canonical positions, batch ID, root, count, and `SEALED` status in one transaction. A failure before commit rolls back the entire operation and leaves a retryable building batch. Repeated sealing cannot rewrite the snapshot or move a pending batch backward.

Database guards reject sealed member insertion, deletion, reassignment, reordering, commitment changes, epoch changes, record deletion, illegal transitions, and rewritten transition timestamps. Every sealed read reconstructs canonical membership and checks count, contiguous positions, canonical order, batch ID, and Message Root. Inconsistent persisted data fails closed. Inclusion proofs are regenerated deterministically from authoritative source data rather than saved as an independent proof format.

Fresh clients and processes recover the same sealed or pending snapshot without local state. Subsequent collection creates the next epoch and assigns only unclaimed finalized occurrences; old roots and proofs remain unchanged. The integration flow seals A/B/D, restores the snapshot in fresh processes, checks its proofs with the Solidity primitive, marks it pending, then produces and finalizes Message E and assigns only E to the next epoch. Unit and isolated database tests cover retry behavior, invalid transitions, immutable snapshots, partial-seal rollback, and competing clients synchronized at explicit lock barriers.

Batch membership uniqueness provides durable assignment ownership. It does not establish exactly-once consensus, relaying, destination execution, or delivery.

## Validator Epochs and Rotation

Three exact integer concepts remain independent:

| Field | Meaning |
| --- | --- |
| `epoch` (batch epoch) | Deterministic batch sequence |
| `validatorEpoch` | Historical committee version authorizing consensus |
| `view` | Primary round inside the same batch instance |

For example, batch epoch 23 can use validator epoch 7 in views 0, 1, and 2. A committee can serve many consecutive batches. The next committee activates at an explicitly configured batch boundary, never through a timeout or peer discovery.

Public operator history contains `validatorEpoch`, `activationBatchEpoch`, exactly four nonzero unique public addresses, and its derived `committeeDigest`. A supplied digest is checked; otherwise it is computed using the existing Ethereum ABI/Keccak committee encoding. Members are sorted by unsigned address bytes. URLs and private keys never enter history or its digest. Consecutive validator epochs and strictly increasing activation boundaries are mandatory. Input ordering does not change the canonical history.

`validator/config/validator-set-history.example.json` illustrates initial V1/V2/V3/V4 followed by V2/V3/V4/V5. These are public development identities; production operators must publish their own public history and configure an endpoint for every member. Each runtime process still receives only its own private key. A successful handshake proves key control, independently of membership in any particular epoch.

The resolver selects the greatest activation boundary not exceeding the batch epoch. Each validator stores the same public history in its own identity-bound namespace. Existing entries cannot be updated or deleted. Restart with conflicting or omitted history fails closed; a new entry may only extend history and cannot change an already-started consensus instance. A fresh V5 store never copies V1 state or invents historical observations or votes.

The source lifecycle's operator-owned `pinConsensus` operation, or `markConsensusPending` when supplied trusted history, atomically stores `batch_consensus_bindings`. The validator independently compares that public epoch/digest with its own resolver before admitting pending source data, and persists its local immutable binding. An unbound pending candidate cannot enter new PBFT consensus. Sealed batches can still be independently source-validated without granting consensus authority. All views, prepared evidence, votes, broadcasts, primary selection, and final QC use the pinned committee; rotation cannot alter the message ID, batch ID, member ordering, leaf, root, or proof.

New signed evidence uses PBFT protocol version 3. PRE-PREPARE, PREPARE, COMMIT, VIEW_CHANGE, NEW_VIEW, prepared evidence and QC bind both `validatorEpoch` and `committeeDigest`. Removed V1 cannot contribute to the new epoch; future V5 cannot contribute to the old epoch. Duplicate addresses, mixed epochs, unknown history and mismatched digests are rejected. Five historical identities never change the per-epoch `n = 4`, `f = 1`, quorum `3`.

Historical QC verification resolves the QC's exact epoch and checks it against the trusted activation schedule and expected immutable batch context. It never substitutes the latest committee. Previously committed batches and their first QCs remain unchanged; no new committee re-signing is needed. The read-only `/pbft/qc/verify` endpoint verifies portable certificate evidence without local voting participation or a running historical signer. It does not independently prove source execution; committed lifecycle reads additionally reconstruct the source batch and verify its root and QC.

Legacy version 1 and 2 evidence retains its original type strings, ABI bytes, digests and signatures. Source migration reserves existing pending/committed instances with their legacy protocol marker; their validator epoch stays absent rather than being invented. Such evidence did not sign a validator epoch and is verified against the explicitly configured initial committee. No migration invents epoch-bound signatures. Existing v2 in-flight instances retain their original protocol and committee rather than mixing formats within a batch.

`validator/migrations/007_validator_epochs.sql` adds immutable local history and epoch-bound state. `indexer/migrations/008_validator_epochs.sql` adds source consensus bindings and QC epoch metadata. Existing migrations remain unchanged. The migration entry points record applied filenames transactionally and execute only unapplied files; this prevents old version constraints from being reapplied over v3 evidence. Existing installations first run the earlier idempotent migrations and then record the new migration without deleting historical data.

Rotation authorization currently belongs to the trusted deployment/operator configuration boundary. QC signatures prove a quorum of the specified historical committee signed; they do not prove that decentralized governance selected that committee. There is no runtime force-rotation endpoint, validator election, staking or slashing.

The unified integration reindexes real A/B/D and Message E into a verification-owned source namespace, starts five independent identities/PIDs/endpoints/stores, commits A/B/D under validator epoch 7, and commits the next Message E batch under epoch 8. V1 remains online while its new-epoch votes are rejected; V5 cannot add weight to historical epoch 7. A rotated-primary process crash requires view recovery with only epoch-8 members and a final three-signature QC that includes V5. Old and new certificates are then independently verified, including after V1 stops. Original source history, REORGED C, cursor, proofs, and existing committed QC are preserved.

That same rotation scenario compares its actual resolved epoch-7/8 committees with Chain B `ValidatorSetRegistry` storage before consensus and after rotation/V1 shutdown. It checks exact canonical identities, quorum and digest, and resolves the existing historical QC epoch/digest to the already registered authority. It then verifies both actual QCs through `PBFTCertificateVerifier` using persisted batch context, rechecks old evidence after V1 stops, and rejects root/epoch/signature/quorum/duplicate/nonmember mutations. Signed certificate and delivery bytes remain unchanged; these read-only checks grant no destination execution permission.

## Independent Validators

The `validator/` subsystem runs one validator per Node.js process. Each validator epoch contains exactly four unique secp256k1-derived Ethereum addresses. The endpoint directory can also contain historical and upcoming members. V1–V4 are verification aliases, not cryptographic identities. Each process has its own key, memory, endpoint, PostgreSQL namespace, and source RPC client. The production configuration supports separate database servers as well as isolated schemas on one server.

The committee coordinates signed PRE-PREPARE proposals through one deterministic primary per batch epoch. After accepting the same proposal, every committee member, including the primary, can persist and broadcast one signed PREPARE vote. Three distinct matching voters produce validator-local `PREPARED`, which permits COMMIT voting. Three distinct matching COMMIT voters produce a QC; independent QC verification authorizes `CONSENSUS_PENDING → COMMITTED`. Each consensus instance pins one validator epoch and committee digest; view changes rotate the primary within that same historical committee.

### Identity and persistence

Private keys enter through `VALIDATOR_PRIVATE_KEY`. They are never included in public identity responses, validation observations, or PostgreSQL records. Verification constructs development-only keys at runtime and injects them into child-process environments without printing them. These keys must not be used for production validators.

Validator-local migrations are owned by `validator/migrations/`. Source-side QC persistence is introduced by `indexer/migrations/006_pbft_commit.sql`; both sets of migrations must be applied explicitly before runtime. Startup binds or checks one persistent identity, verifies source connectivity and Chain A context, and only then opens the HTTP endpoint. A failed prerequisite exits nonzero.

The local schema contains:

- `validator_metadata`: one immutable validator address, source domain/Gateway, finality policy, and protocol version;
- `validated_batch_bindings`: one immutable batch ID, epoch, root, count, and ordered public source-occurrence references;
- `validation_observations`: immutable `VALID`/`INVALID` observations keyed by batch ID and source-head hash, with exact head number and an operational timestamp;
- `validator_committee`: the immutable initial four-member trust anchor for legacy evidence;
- `validator_set_history`: append-only public validator epochs, activation batch boundaries, canonical member arrays, and committee digests;
- `pbft_pre_prepares`: one immutable accepted proposal per local validator, batch epoch, view, and protocol version, including batch ID, root, digest, primary signature, `ISSUED`/`ACCEPTED` direction, and acceptance time;
- `pre_prepare_rejections`: separate minimal public rejection evidence and stable reason categories, with no authority to reserve an accepted slot;
- `pbft_prepare_votes`: one immutable vote per local validator, batch epoch, view, protocol version, and cryptographic voter identity, bound by foreign key to the exact locally accepted proposal;
- `pbft_prepared_states`: an immutable local transition containing the accepted proposal and the first canonical set of three durable voter identities that established prepare quorum;
- `prepare_rejections`: separate operational evidence for malformed, mismatched, unknown, and conflicting PREPARE votes;
- `pbft_commit_votes`: one immutable COMMIT per local validator, epoch, view, protocol version, and voter, with an exact foreign key to local `PREPARED`;
- `pbft_commit_quorums`: immutable local `COMMIT_QUORUM` statement, first three voter identities, and QC statement digest;
- `commit_rejections`: separate public rejection evidence with no quorum weight;
- `pbft_epoch_views`: immutable batch/root/protocol/validator-epoch/committee binding, monotonic current view, transition intent, finality, and progress time;
- `pbft_view_change_votes`: immutable signed safety evidence per sender/epoch/target view;
- `pbft_new_views`: immutable accepted NEW_VIEW and selected proposal/quorum evidence.

Opening an existing namespace with another key, Gateway, domain, finality policy, or conflicting historical committee configuration fails closed. A valid future history entry can be appended without rewriting any existing entry. Peer order and endpoint changes do not change the canonical identity array. Same-snapshot validation at the same head is idempotent. A different head adds an observation without deleting history. A changed root, epoch, or occurrence membership for an existing batch ID, or contradictory results at the same head, cannot overwrite prior state. No operational timestamp or local observation enters a message ID, batch ID, Merkle hash, proposal signature, or vote signature. Ordered, rerunnable validator migrations preserve existing identity and observations; `002_pre_prepare.sql` adds proposals, `003_prepare.sql` adds PREPARE state, and `004_commit_and_qc.sql` adds COMMIT votes and quorum state without rewriting earlier migrations.

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

`FINALIZED` in PostgreSQL is an eligibility input, not independent source truth. A source block above the fixed head, insufficient depth, missing or changed log, wrong context, or canonical mismatch fails closed. A fork affecting finalized members is not repaired by validators. Source-layer reconciliation and operator investigation retain that responsibility. Application A establishes proof-to-message binding atomically at the source; validators authenticate the resulting event without re-verifying private credential evidence.

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
| `GET /validator-sets` | Read canonical trusted public validator history |
| `POST /pbft/qc/verify` | Read-only portable historical QC signature/context verification |
| `POST /pbft/qc/submit` | Independently verify a QC and atomically commit its exact source batch |

Handshake hashing is `keccak256(abi.encode(HANDSHAKE_DOMAIN, sourceDomain, sourceGateway, validatorAddress, challenge))`, with the type string `ValidatorIdentityHandshake(uint256 sourceDomain,address sourceGateway,address validator,bytes32 challenge)`. The response uses Ethereum personal-message signing of that raw digest. The requester recovers the signer and checks the configured peer identity, source context, and challenge. Changed challenges, identities, context, signatures, and replay against a new challenge fail. No persistent handshake anti-replay ledger is needed; freshness belongs to the requester.

This handshake proves peer key control. It is not a PBFT vote, encrypted transport, or authenticated consensus session. A validation request triggers independent reads and cannot upload a trusted tree/root or grant commit authority.

### Deterministic primary and PRE-PREPARE

The pinned historical committee is sorted by unsigned address bytes, represented as equal-length lowercase hexadecimal addresses. Every validator computes `primaryIndex = (epoch + view) % 4n` using exact `BigInt` arithmetic. Epoch identifies a batch consensus instance; view identifies a leader round within that same epoch. View zero preserves the original primary selection. Configuration order, startup, discovery, and reachability have no influence. Replacement requires a verified three-of-four view-change quorum and signed NEW_VIEW.

The wire envelope contains only:

```text
messageType = "PRE_PREPARE"
protocolVersion = "3"
sourceDomain                    decimal uint256 string
sourceGateway                   Ethereum address
epoch                           decimal uint256 string
view                            decimal uint256 string
validatorEpoch                  independent decimal uint256 string
committeeDigest                 pinned historical committee digest
batchId                         bytes32
messageRoot                     bytes32
primaryIdentity                 Ethereum address
proposalDigest                  bytes32
signature                       65-byte Ethereum signature
```

Integers are transported as canonical decimal strings, never JSON numbers. The authoritative digest is:

```text
PRE_PREPARE_DOMAIN = keccak256(UTF8(
  "PBFTPrePrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,address primaryIdentity,uint256 validatorEpoch,bytes32 committeeDigest)"
))

proposalDigest = keccak256(abi.encode(
  PRE_PREPARE_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, primaryIdentity, uint256(validatorEpoch), committeeDigest
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
protocolVersion = "3"
sourceDomain                    decimal uint256 string
sourceGateway                   Ethereum address
epoch                           decimal uint256 string
view                            decimal uint256 string
validatorEpoch                  independent decimal uint256 string
committeeDigest                 pinned historical committee digest
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
  "PBFTPrepare(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,address voterIdentity,uint256 validatorEpoch,bytes32 committeeDigest)"
))

prepareDigest = keccak256(abi.encode(
  PREPARE_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, voterIdentity, uint256(validatorEpoch), committeeDigest
))
```

The validator signs the raw digest with its existing Ethereum personal-message key. The receiver recomputes the digest, recovers the signer, requires `recovered signer == voterIdentity`, and checks membership in the pinned historical four-address committee. Binding the voter into the digest makes each member's vote cryptographically distinct. Binding the proposal digest, batch ID, root, epoch, and source context prevents votes from being mixed across proposals or protocol contexts. JSON serialization, timestamps, URLs, PIDs, database identifiers, and signatures do not enter the digest.

A validator can cast at most one PREPARE per epoch/view. Its lock check, signature creation, and persistence are serialized in one local transaction. It checks its durable self-vote lock before signing, persists the signed vote, and only then broadcasts to the other three peers through the existing authenticated transport and five-second HTTP bound. A crash before persistence leaves no vote. A crash after persistence reuses the same saved vote on retry. Partial delivery is safe because receivers treat an identical vote idempotently. Delivery responses are operational acknowledgements and carry no additional voting weight.

`POST /pbft/prepare` accepts only the strict signed envelope. The local accepted PRE-PREPARE must already exist, and epoch, batch ID, root, proposal digest, source context, and version must match it exactly. A valid committee signature cannot establish or replace a proposal. A vote arriving before its PRE-PREPARE is rejected and is not buffered. One voter occupies one durable `(local validator, epoch, view, protocol version, voter)` slot. Repeated delivery preserves the original row; a different vote from the same identity and epoch is rejected without replacing it. Rejection evidence remains separate from valid votes.

Prepare quorum is exactly three distinct configured voter identities for one locally accepted proposal. Request count, HTTP responses, signatures without signer recovery, and duplicate rows do not count. Vote insertion, unique-voter counting, and first creation of `PREPARED` occur in one database transaction. Concurrent second/third votes therefore cannot leave a durable three-vote collection without its matching `PREPARED` record. The first three voter identities are saved as immutable quorum evidence. A fourth matching vote is retained while the existing `PREPARED` timestamp and evidence remain unchanged.

`PREPARED` is validator-local and monotonic. One node may be prepared while another has observed only two votes. A fresh process restores the accepted proposal, every observed vote, its own double-vote lock, and existing `PREPARED` state from its isolated namespace. Receiving duplicates, temporary peer loss, or restart cannot return the node to an unprepared state.

`PREPARED` records prepare-level support and permits COMMIT voting. PREPARE processing preserves source tables and leaves the batch `CONSENSUS_PENDING`. A separately verified COMMIT certificate must authorize the lifecycle transition.

### COMMIT votes and Quorum Certificates

`POST /pbft/commit/cast` accepts only `{ "epoch": "..." }`. It reads the accepted proposal and durable local `PREPARED`, rechecks the PRE-PREPARE and PREPARE evidence, and checks the existing self-COMMIT lock before signing. The check, signature creation, vote insertion, and quorum update run under one validator-local database lock. Concurrent casts therefore reuse the same durable vote. Persistence completes before broadcasting to authenticated peers. Operational acknowledgements carry no vote weight.

The COMMIT envelope contains `messageType = "COMMIT"`, `protocolVersion = "3"`, decimal-string `sourceDomain`, `epoch`, `validatorEpoch`, and `view`, `sourceGateway`, `batchId`, `messageRoot`, `proposalDigest`, `committeeDigest`, `voterIdentity`, `commitDigest`, and the 65-byte `signature`. Its canonical digest is:

```text
COMMIT_DOMAIN = keccak256(UTF8(
  "PBFTCommit(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,address voterIdentity,uint256 validatorEpoch)"
))
commitDigest = keccak256(abi.encode(
  COMMIT_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, committeeDigest, voterIdentity, uint256(validatorEpoch)
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

Changing peer configuration order or URLs does not change this digest; replacing an identity does. Every current vote also binds its validator epoch. Membership is resolved from trusted historical configuration for that exact batch and epoch. The receiver recomputes the COMMIT digest and recovers the Ethereum personal-message signer, then requires exact claimed identity, configured membership, committee digest, and accepted proposal context. It must itself be durably `PREPARED`. Early COMMIT is rejected as `NOT_PREPARED` and is not buffered. One signer occupies one immutable vote slot per local validator, epoch, and view. Every local COMMIT lock additionally constrains all later views to the same batch/root. Duplicate votes preserve the first row; conflicts return `CONFLICTING_COMMIT`.

One or two distinct matching COMMIT voters produce no quorum and no QC. The third durable voter atomically creates local `COMMIT_QUORUM` with the first three matching voter identities and QC statement digest. The fourth vote remains available locally without replacing that evidence. `POST /pbft/qc` reconstructs and verifies the certificate from durable votes (an optional decimal-string `view` selects historical evidence); a crash between local quorum and global submission can be recovered by requesting and submitting that QC again.

The QC envelope contains `messageType = "QUORUM_CERTIFICATE"`, the same statement fields through `committeeDigest`, `qcDigest`, and `commits`, an array of three or four complete COMMIT envelopes sorted by voter address. It carries no PREPARE history. Its statement identity excludes signatures and signer subsets:

```text
QC_DOMAIN = keccak256(UTF8(
  "PBFTQuorumCertificate(uint8 protocolVersion,uint256 sourceDomain,address sourceGateway,uint256 epoch,uint256 view,bytes32 batchId,bytes32 messageRoot,bytes32 proposalDigest,bytes32 committeeDigest,uint256 validatorEpoch)"
))
qcDigest = keccak256(abi.encode(
  QC_DOMAIN, uint8(protocolVersion), uint256(sourceDomain), sourceGateway,
  uint256(epoch), uint256(view), batchId, messageRoot, proposalDigest, committeeDigest, uint256(validatorEpoch)
))
```

`verifyQuorumCertificate(certificate, { peers, validatorSets, expected })` is an independent off-chain primitive. It requires an externally trusted immutable validator-set resolver and expected source/batch context. It derives the deterministic primary's PRE-PREPARE digest, checks every statement field and the QC digest, and independently recomputes and verifies every COMMIT signature. Duplicate signers, unknown members, mismatched fields, malformed signatures, noncanonical ordering, or fewer than three signatures fail closed. Different valid subsets can prove the same `qcDigest`. Prepared and NEW_VIEW evidence also normalize recovered committee identities before uniqueness checks; address casing cannot add quorum weight.

### QC-authorized batch persistence

`createBatchLifecycle({ config, pool, validatorSets })` uses externally trusted immutable validator history for current v3 commitment and committed reads. It never obtains that trust anchor from a submitted certificate. `commitWithCertificate({ certificate })` locks and reconstructs the exact persisted batch, requires `CONSENSUS_PENDING` for first commitment, and verifies the certificate against its source scope, batch epoch, batch ID, root, deterministic proposal and pinned validator epoch/committee digest. Historical v1/v2 certificates retain the explicitly configured initial/static committee; they are not relabeled as v3 evidence. The caller submitting a QC needs no trusted identity.

Migration `006_pbft_commit.sql` adds `batch_quorum_certificates` and `batch_quorum_certificate_signatures`. The header binds the statement; child rows retain each signer, recomputable COMMIT digest, and signature with unique signer constraints. Certificate insertion, signature insertion, and the batch's `COMMITTED` transition occur in one transaction. Database guards preserve sealed membership, enforce terminal status, reject updates without matching complete certificate evidence, and reject a certificate left without its committed batch at transaction completion. Cryptographic verification belongs to application code; SQL constraints provide structural guarantees.

The normal integration verifies the fourth COMMIT, duplicates and conflicts before global submission. Once finalized, new votes are rejected and durable self-vote/QC retries preserve the existing result. The first valid global QC remains immutable. Repeated submission of the same certificate, another valid three-signer subset, or four signatures for the same statement returns the original batch and certificate. Concurrent submissions lock the same batch and converge on that result. A conflicting or forged QC cannot replace it. Any failure before transaction completion rolls back the certificate, signatures, status, and commit timestamp together.

Every `COMMITTED` snapshot read reconstructs the immutable batch and Merkle tree, loads its stored QC evidence, and repeats independent certificate verification against the expected committee. Missing evidence, corrupted signatures, or context drift fails closed. PostgreSQL remains operational persistence and supplies no cryptographic authority by itself. Source messages, finality records, canonical blocks, cursor, membership, and existing proofs remain unchanged; later messages continue into subsequent batch epochs.

This implementation supplies COMMIT/QC authorization for each exact historical four-member committee. The Delivery Queue consumes canonical committed certificates. The verification infrastructure exercises the failure model below. Chain B's production DestinationGateway combines historical registry/QC authority, ordered inclusion, full message policy and replay protection before dispatching the authenticated payload.

### Consensus safety and failure model

PBFT safety applies to one exact source scope (`sourceDomain`, `sourceGateway`) and consensus/batch `epoch`. This epoch is independent of `validatorEpoch`, which selects a historical committee, and `view`, which selects a primary round within the same batch instance. One committee can authorize many different batches. A committed batch's root cannot be replaced through conflicting proposals, vote retries or view changes that violate its durable safe-value binding.

Quorum weight counts distinct authenticated committee identities matching the exact fields of their protocol version: source, batch, root, consensus epoch and the version's signed view/committee binding. Version 3 also signs the validator-set epoch; legacy evidence keeps its original fields without inventing a view or validator epoch. Duplicate network messages do not add weight. Two matching identities plus repeated copies remain below quorum; a third distinct matching identity is required for PREPARED and COMMIT quorum. A later fourth matching vote does not replace the first canonical QC. A genuine signature for another consensus epoch or historical authority cannot be mixed into the target round, including adjacent `uint256` epochs above JavaScript's safe-integer range.

Each validator keeps its own identity/source-bound durable state. Reloading that store preserves proposal bindings, safe roots, vote uniqueness and first-quorum evidence. Read-only epoch-bound QC verification uses its pinned immutable validator set, without substituting current online nodes. The off-chain path checks the trusted activation schedule; the Solidity verifier resolves the exact historical epoch through ValidatorSetRegistry and checks its expected context. Legacy QCs retain their original initial-committee authority anchor. Rotation preserves old certificates and signatures: V1 remains valid for epoch-7 history after removal, while epoch-8-only V5 cannot retroactively authorize epoch 7. The same actual historical/current certificates are checked off-chain and through the production Solidity verifier after the old member stops.

The safety model assumes at most one Byzantine validator in a four-member committee. A Byzantine member may sign conflicting contents with its own legitimate key; it still contributes at most one distinct identity and cannot independently obtain PREPARE quorum, COMMIT quorum or a QC. Independent validator locks and exact-context authentication enforce these constraints in addition to database uniqueness. PostgreSQL does not act as a central vote counter or grant cryptographic authority, and an offline process never lowers quorum to two of three.

`./scripts/verify.sh` includes `[pbft safety invariants]`. Production codec/QC tests establish valid evidence before isolated negative probes. Durable tests use four independent stores and genuine self-vote cast paths, compare exact target state before/after wrong-epoch input, exercise the count sequence `0, 1, 2, 2, 2, 3, 4`, and reopen pools to recheck locks and duplicate idempotency. The retained cross-view regression rechecks its certified safe value and original QC after reload. The existing real non-primary Byzantine scenario retries conflicting votes after R1 has committed and every participant has durably finalized it, then requires unchanged roots, QCs, signer sets and zero conflicting delivery authority. These are deterministic regression checks, not a formal proof or a randomized consensus campaign. Existing partition, process-failure, view-change, rotation and destination-verification coverage remains in the full verification flow.

The committee has `n = 4`, fault bound `f = 1`, and PREPARE/COMMIT quorum `3`. Voter identities come from recovered signatures and configured committee membership. One or two signers cannot produce a valid QC. A conflicting vote adds no support to the accepted proposal and cannot cancel three matching honest votes. The primary coordinates proposal delivery; its signature alone supplies no authority over source truth or commitment.

With an honest, available deterministic primary and one unavailable non-primary validator, the remaining three processes can validate the same real batch, reach `PREPARED`, exchange COMMITs, produce a three-signature QC, and commit. Verification selects the unavailable backup dynamically from the batch epoch, stops its OS process, checks its endpoint and PID, and requires the QC signer set to contain exactly the three live identities. The restarted backup verifies the global committed QC through the existing certificate path. It does not claim PREPARE or COMMIT votes that it never cast, and no new catch-up protocol is introduced.

With an honest primary and one adversarial backup, three honest validators can commit the canonical root. A test-only adversarial builder uses a committee development key to sign deterministic conflicting contents. Valid signatures on a wrong-primary PRE-PREPARE, wrong-root PREPARE, or wrong-root COMMIT must still be rejected. A single adversarial signature, duplicate evidence, or canonical signatures reused for a conflicting statement cannot form a conflicting QC. Durable queries require at most one committed root per source scope and epoch and no conflicting persisted certificate. These scenarios do not establish progress when the primary itself is Byzantine or unresponsive.

During a bidirectional 2|2 partition, all four processes remain alive, but each side can observe only its own two PREPARE voters. Neither side reaches `PREPARED`, can legitimately cast COMMIT, or can form a QC; the batch stays pending. The test activates the partition only after all nodes have accepted PRE-PREPARE and before any PREPARE vote exists. Removing the gate changes delivery policy only. Explicit retries rebroadcast the exact saved envelopes and continue the same epoch, batch ID, root, proposal digest, committee, and deterministic primary. The database, vote locks, and process identities are not reset. Progress resumes under restored connectivity with the primary still available.

An unavailable or unresponsive primary can be replaced after a valid three-of-four view-change quorum. Until NEW_VIEW is independently verified and persisted, backups cannot impersonate the primary or promote themselves. Under restored connectivity an available replacement resumes the same safe batch/root. A 2|2 partition cannot form that quorum; arbitrary network failures do not guarantee progress.

Fault injection belongs exclusively to verification helpers. Each directed peer edge has a test proxy, so sender identity for a block rule comes from the configured edge rather than message fields. Rules block delivery without changing protocol bytes, signatures, or digests. There is no production Byzantine mode, partition administrator API, fault database table, or fault input to protocol hashing. Explicit process-stop boundaries, completed requests, durable checkpoints, and controlled retries determine the scenarios; random drops and timing-based success assumptions are unnecessary.

Every scenario uses an independent source schema with the existing migrations and a fresh set of validator namespaces. The real Indexer rescans canonical Chain A events, the real Finality Watcher establishes eligibility, and the production lifecycle creates a new pending A/B/D batch. Validators independently fetch the real source receipts and blocks. The original committed batch, QC, `REORGED` C occurrence, next-epoch Message E, cursor, and canonical history remain unchanged. Source writes within each fault instance are restricted to the authorized QC/status transition.

### View changes and primary recovery

Normal flow is `CONSENSUS_PENDING → PRE-PREPARE → PREPARE → PREPARED → COMMIT → QC → COMMITTED` in an explicit view. Failure recovery is `progress timeout → VIEW_CHANGE → three-of-four quorum → NEW_VIEW → safe proposal → consensus in the next view`.

`PBFT_VIEW_TIMEOUT_MS` defaults to 30000 and accepts a positive integer up to 2147483647. It is the base consensus timeout, independent of the five-second HTTP timeout. The active round uses `min(base * 2^current_view, 2147483647)` milliseconds; while waiting for NEW_VIEW, the pending round uses `target_view` instead. Scheduler and locked database timeout checks share this policy. The growing window gives restored peers time to converge and vote before signing another higher target. It derives from durable views and timestamps, survives restart, and handles uint256 views without unbounded exponentiation. A serialized scheduler discovers independently validated pending batches, restores durable view state on restart, and resets deadlines on new accepted proposals, votes, or NEW_VIEW. Duplicate deliveries do not extend deadlines. Timeout pauses local old-view voting and persists one signed VIEW_CHANGE for the next target. Active `current_view` and pending `target_view` are separate: failure to publish NEW_VIEW does not activate that target, and another full timeout can increment the durable target by one. Each target retains its own immutable signed intent; retries and the first replay after restart reuse it exactly. A valid higher-target NEW_VIEW with three distinct authenticated votes can activate that certified view directly. One caller or one vote cannot change the active view.

VIEW_CHANGE binds version 3, its pinned validator epoch and committee digest, its independent `PBFTViewChange` domain, source context, epoch, target view, sender, accepted proposal digest, and prepared-certificate digest. It includes the complete accepted signed proposal when present and the highest durable Prepared Certificate when PREPARED. That certificate carries the signed PRE-PREPARE and three or four matching signed PREPARE envelopes sorted by committee identity. It is independently verified and is distinct from a final COMMIT QC.

NEW_VIEW binds version 3, its pinned validator epoch and committee digest, its independent `PBFTNewView` domain, source context, epoch, target view, deterministic primary, selected batch/root, and the canonical array of VIEW_CHANGE digests. It includes three or four distinct authenticated VIEW_CHANGE messages. Every backup verifies all nested evidence and independently selects the proposal at the highest prepared view. Conflicts at the same highest view fail closed. Without prepared evidence, selection requires the independently validated canonical pending batch. The new primary also revalidates the immutable candidate against a fresh fixed Chain A head; the head need not equal an earlier observation.

The primary persists NEW_VIEW before broadcasting it. Acceptance atomically stores evidence and advances the active view to the quorum-certified target; current view never decreases. A pending target is retained if it is already higher, so receiving older certified recovery evidence cannot undo a later local intent. There is no administrative set-view or force-primary endpoint. Historical votes remain immutable. Prepared history and local COMMIT locks constrain subsequent views to the safe batch/root. Old-view votes cannot count toward a new-view quorum. A valid older-view QC retains finality, ends timeout processing, and prevents conflicting commitment. Equivalent certificates from later views preserve the first final certificate.

Before opening HTTP or reporting readiness, each validator completes initial pending-batch discovery, independent source validation, and local epoch registration. Discovery does not schedule timeouts, cast votes, or broadcast; existing durable views and safety evidence are retained. Startup storage failures propagate before the endpoint opens. The four-process verification captures these initialized observations as each node's baseline, then checks that explicit validation still performs independent RPC reads, remains idempotent, and leaves every other validator's baseline unchanged.

After the listener opens, the scheduler retransmits each node's latest issued NEW_VIEW independently of whether it is waiting for another view. This lets a lagging peer recover after temporary delivery loss. It rereads durable state after replay and establishment so concurrent HTTP acceptance cannot leave scheduling based on an obsolete view or progress timestamp. A newly established active view proceeds directly to proposal/PREPARE/COMMIT work in that same pass. It drives proposal/PREPARE/COMMIT/QC in active replacement views; view-zero initiation retains explicit proposal/cast interfaces. Timeout writes compare the original active view, target and durable progress revision under the metadata lock. A superseded timer cannot sign for a fresh view or erase new progress. The revision and timeout timestamps are operational state and never enter message IDs, batch IDs, roots or signatures.

If another node commits between discovery and a pending-batch check, the existing lifecycle reader independently verifies the final QC and the local epoch is finalized. Corrupted or missing evidence still fails closed; ordinary COMMITTED convergence does not halt the scheduler. Recognizing a final QC never fabricates an accepted NEW_VIEW or forces local current view to equal the certificate's signing view. Storage or integrity failures remain fatal to scheduling and readiness.

Additional routes are `POST /pbft/view-change`, `POST /pbft/new-view`, and read-only `GET /pbft/views`. Strict nested fields, exact integers, and evidence arrays bounded by the four-member committee are required. Request size is limited to 64 KiB.

`validator/migrations/005_view_change.sql` retains old consensus rows as version-one view-zero history, including original signatures and digests, and adds view-bound locks, intents and NEW_VIEW evidence. New consensus uses version 3. Existing v2 in-flight instances retain their original encoding and initial committee; v1/v2 signatures are never relabeled as epoch-bound v3 evidence. Historical version-one prepared/QC evidence uses the original encoding. `validator/migrations/006_view_recovery.sql` adds durable pending targets, intent deadlines and progress revisions, backfills existing intents, and preserves the prior migrations. `indexer/migrations/007_view_bound_qc.sql` stores QC view metadata and admits versions 1 and 2 without changing source messages, batch commitments, members or roots. Identity/handshake and the existing `PBFTStaticCommittee` digest encoding remain version 1; that codec version does not imply one fixed committee across validator epochs.

Verification preserves the earlier fault cases and independently reindexes real A/B/D for primary crashes before proposal, after proposal, after two PREPAREs, after PREPARED, and after two COMMITs. It restarts a sender after VIEW_CHANGE persistence, checks exact intent recovery, rejects a correctly signed unsafe NEW_VIEW, and checks old-view replay rejection. A repeated-failure case stalls replacement-primary proposal delivery using verification-only route gates, returns the original process to maintain the fault bound, and advances through views 1 and 2. Additional real-process cases delay NEW_VIEW delivery past a timeout and stop the candidate primary before it can publish NEW_VIEW, with at most one process offline at a time. The unavailable-candidate case requires a real quorum to activate view 2. The delayed-delivery case requires the exact original NEW_VIEW to be replayed after its primary has timed out, then heals transport and requires an independently verified three-signer QC from view 2 or later. Timers continue advancing pending targets during the delivery outage, so this case does not require every node to stop at view 2. Each final QC signer must retain independently verifiable NEW_VIEW evidence for its signing view. Verification-only COMMIT delivery gates establish an explicit all-node NEW_VIEW checkpoint in cases that require everyone to enter a particular view. General finality checks instead compare the independently verified final certificate and batch/root. All cases require one durable committed root and preserve original REORGED C, Message E, source history, membership and proofs.

### Configuration

`validator/.env.example` documents one process's operator configuration. Real keys and database passwords belong only in an ignored `.env` or process environment. Required values include `VALIDATOR_PRIVATE_KEY`, listen host/port, `VALIDATOR_DATABASE_URL`/`VALIDATOR_DB_SCHEMA`, `SOURCE_DATABASE_URL`/`SOURCE_DB_SCHEMA`, Chain A RPC/domain, deployed SourceGateway, finality depth, and `VALIDATOR_PEERS` as an endpoint directory of `{ address, url }` entries including self and every configured historical member. Exactly one of `VALIDATOR_SET_HISTORY_FILE` or `VALIDATOR_SET_HISTORY` supplies public operator history. The self endpoint must match the listen configuration; duplicate addresses/endpoints and malformed or incomplete sets fail early.

Source and local state may use the same PostgreSQL server, but must use distinct schemas or databases. A validator never shares writable local state with another validator. Schema identifiers are validated and queries carrying network references are parameterized. Source validation and PREPARE/COMMIT vote processing perform no source-row writes. The dedicated QC authority writes only certificate evidence and the pending batch's status/commit timestamp. Validators do not apply Indexer migrations at startup or repair source history.

Complete verification continues to load the root `.env`. Its development validators use the existing `DATABASE_URL` with isolated schemas for four normal validators and five rotation identities. `VALIDATOR_VERIFICATION_DATABASE_URL` optionally selects another already-prepared local database. No additional password or permanent validator-key configuration is required for this development verification flow.

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

Normal and fault integrations share one process helper for startup, stop, restart, endpoint queries, signal handling, and the owned PID registry. Fault-scenario cleanup waits for the created validators to exit before closing transport/RPC proxies and port reservations, then closes database pools. RPC remains available while pending validator ticks finish. Recovery failures report each node's active view, pending target, progress revision, finalized state, quorum targets, signer sets, and source status before cleanup; a cleanup failure cannot replace the original recovery failure. The root script retains fallback cleanup and never targets unrelated user processes. The claimed safety/liveness boundaries are limited to the explicit four-members-per-epoch scenarios described above.

## Committed Message Delivery Queue

The queue subsystem lives in `indexer/src/delivery/` and shares the source operational database and existing `pg`/`viem` dependencies. It materializes one immutable READY job for every sealed message position in a cryptographically verified COMMITTED batch. BUILDING, SEALED and CONSENSUS_PENDING batches are ineligible. PostgreSQL status strings and QC row presence alone are insufficient: the projector reuses the strict committed lifecycle reader inside the same transaction as queue persistence, reconstructs canonical membership and the Merkle tree, recomputes message and batch identities, and verifies the persisted historical QC.

### Portable delivery evidence

`buildDeliveryPackages(snapshot, { validatorSets })` constructs destination-neutral protocol artifacts. `verifyDeliveryPackage(package, { validatorSets, sourceDomain, sourceGateway })` independently checks their message, batch, proof, root, historical committee and signatures without database access, a READY marker, private keys or chain RPC. Optional expected source fields constrain the package to a caller's configured source scope. Trusted public validator history comes from the caller, never from the package itself.

Each package contains:

- `deliveryJobId`: deterministic operational identity;
- `message`: the complete canonical message, including source sender, destination domain/Gateway/receiver, exact payload bytes, payload hash, nonce, deadline and message ID;
- `batchVersion`, `batchEpoch`, `batchId`, and ordered `batchMessageIds`;
- `messageIndex`, `leafCount`, `messageRoot`, and `merkleProof` with its batch/message IDs, index, leaf count and ordered siblings;
- `validatorEpoch`, `committeeDigest`, and the complete canonical `quorumCertificate`.

Ordered batch message IDs let a fresh consumer recompute the existing batch commitment and authenticate the exact leaf count through the QC-bound batch ID. They are taken from immutable sealed membership, never resorted for delivery. Source and portable verification share the original Merkle algorithm, domains and ABI encoding, including ordered left/right nodes, odd-node duplication and single-leaf proofs. The queue persists each sibling path and rejects a corrupted path rather than silently substituting a regenerated one. Payload stays opaque and deadlines are preserved even when expired; queue construction performs no business interpretation or automatic job deletion.

All protocol uint256 fields serialize as decimal strings; byte values use canonical `0x` hex. Array indices and leaf counts are bounded exact safe integers. Portable batch ID validation commits to ordered message IDs; source occurrence provenance and finality are additionally checked by the strict source lifecycle path, not established by the portable artifact alone.

### Identity, persistence and atomic projection

The job identity is the canonical composite `sourceDomain:sourceGateway:batchId:messageIndex`. It is operational idempotency data and introduces no additional hash or consensus domain. Timestamps never affect identity. Message ID, batch ID, Merkle Root and QC remain unchanged.

`indexer/migrations/009_delivery_queue.sql` adds `delivery_batches` and `delivery_jobs`. One delivery batch references the immutable source batch and its canonical QC, retaining batch scope, epoch/version, root, leaf count, QC protocol, validator epoch, committee digest, QC digest and materialization time. Jobs reference immutable source members and retain position, message ID, explicit source/destination fields, proof siblings, READY state and creation time. Complete message bytes and QC signatures are reconstructed from the referenced canonical source tables; identical signatures are not copied for every message.

Unique `(batch_record_id, message_index)` membership enforces one job per sealed position. Foreign keys and insert guards check source/QC relationships. Immutable guards reject queue evidence updates and deletions. Deferred constraint triggers require the entire projection to contain exactly the canonical number of positions before COMMIT. SQL protects structural persistence; application-level cryptographic checks remain mandatory.

`createDeliveryProjector({ config, pool }).materializeBatch({ batchRecordId })` locks the existing source batch, strictly revalidates it and all packages, and persists the complete projection in one transaction. A failure rolls back the delivery batch and every job. Concurrent projectors serialize on the same batch row. Retrying an existing projection strictly verifies its complete stored contents and preserves its original jobs and timestamps; partial or conflicting data fails closed and is never patched into place.

Within one package-construction pass, batch identity, ordered membership, root and historical QC are validated once, and all member proofs are derived from one ordered tree. Each member still undergoes canonical message, position and identity checks. The projector retains this verified construction only for its current transaction's writes and stored-row readback; the strict source lifecycle read remains an independent evidence check. Stored paths and source-member references must match the verified construction, including later members of the same batch. A reconstructed correct path never replaces a corrupted stored path.

`projectCommittedBatches()` finds COMMITTED batches without a delivery projection through bounded, explicitly ordered database queries. It uses durable eligibility rather than a queue cursor or in-memory restart position. Failure before commit leaves no partial jobs; loss of the worker's report after commit leaves the canonical jobs discoverable without duplication. The `delivery:once` npm entry invokes this database-only worker against an already migrated schema. Configuration uses `DATABASE_URL`, `INDEXER_DB_SCHEMA`, `CHAIN_A_DOMAIN`, `SOURCE_GATEWAY_ADDRESS` and exactly one existing validator-history source. It requires no validator private key or destination RPC configuration.

### Strict queue reads and historical committees

`createDeliveryRepository({ config, pool })` exposes:

| API | Behavior |
| --- | --- |
| `listReadyDeliveryJobs({ limit })` | Non-destructive strict listing, ordered by batch epoch, message index and job ID; default 100, maximum 1000 |
| `getDeliveryJob(deliveryJobId)` | Read verified operational metadata for one job |
| `getDeliveryPackage(deliveryJobId)` | Reconstruct and verify the complete portable package |
| `getDeliveryEntries(deliveryJobIds)` | Strict combined `{ job, package }` reads for at most 1000 requested IDs, preserving caller order and verifying each distinct batch projection once within the call |

Reads reject mismatched job identity, membership, destination fields, proof paths, roots, QC references or validator-epoch metadata. They also reverify underlying source message integrity and QC cryptography. Queue persistence is an operational projection and does not become cross-chain authority.

READY selection uses the same operation-local grouping as bulk queue reads. It returns only the selected identities and does not lease other members merely because their batch was read. Destination filtering, ordering, selection limits, preparation scheduling and per-job fencing remain independent of this immutable-evidence reuse. Each later lookup or worker operation starts fresh; no process-global or durable validity cache is used. Relayer and Transaction Manager use combined job/package reads at their own boundaries and independently verify portable evidence before acting; one cannot supply the other's trusted context.

Portable `verifyDeliveryPackage` remains a complete verifier without a caller-supplied trust or skip flag. Its Merkle root reconstruction shares the existing leaf/node algorithm but does not allocate every member's proof. The supplied path is still checked independently against the authenticated membership, position, count and root. Ordered hashing, odd-node duplication, historical QC formats, transport bytes and existing golden vectors are unchanged.

Old packages retain their exact historical epoch and canonical first QC after rotation. Verification resolves the QC's historical committee and checks its activation schedule; it never uses the latest committee as a substitute or requests replacement signatures. Legacy v1/v2 certificates retain their original bytes and signatures, are verified using the explicitly configured initial committee, and expose `validatorEpoch: null` because those formats did not sign an epoch. No queue migration invents epoch-bound evidence.

### READY boundary and integration

READY means immutable delivery evidence was successfully materialized. It does not mean submitted, executed or confirmed. Source batch state remains COMMITTED. The queue stores no claim/lease, retry counter, transaction nonce, fee, hash or receipt; those belong to the separate Relayer and Transaction Manager subsystems. The queue does not send a Chain B transaction or encode Gateway calldata. Relayers remain untrusted transport, and DestinationGateway independently authorizes each submission before replay consumption and receiver execution.

The unified verification preserves the existing source, ZK, Merkle, PBFT, fault, view-change and rotation checks, and exercises queue unit/database tests. Real A/B/D produces three READY jobs with the original proofs and QC, while REORGED C produces none. The rotation integration also materializes real epoch-7 A/B/D and epoch-8 Message E, independently verifies packages in fresh processes, checks concurrent projection, injects deterministic interruption before commit and report loss after commit, and preserves all source lifecycle data and historical evidence. These queue checks establish materialized evidence only; production Gateway/application acceptance is verified separately through the real end-to-end path.

## Relayer and Persistent Transaction Manager

`indexer/src/relayer/` implements replaceable, bounded delivery orchestration workers. Relayer A and Relayer B use the same production entry point with distinct worker IDs, separate processes and separate database connections. They consume one durable queue through per-job leases and fencing. The Persistent Transaction Manager owns nonce allocation, gas, fees, local signing, durable raw transactions, broadcast, retries, replacement and receipt tracking. Both workers share one destination signer and one durable nonce space. Existing `pg` and `viem` dependencies are reused. Worker identity grants no consensus or destination authority; the manager exposes no arbitrary-address wallet send API.

### Configuration and selection

Configuration combines the Delivery Queue scope and public validator history with `CHAIN_B_RPC_URLS`, `CHAIN_B_CHAIN_ID`, `CHAIN_B_GENESIS_HASH`, `RPC_REQUEST_TIMEOUT_MS`, `RELAYER_A_PRIVATE_KEY`, `RELAYER_MAX_JOBS_PER_RUN` (default 100, maximum 1000) and `DESTINATION_CONFIRMATIONS` (default 3, exact positive integer). `CHAIN_B_RPC_URLS` is a nonempty JSON array of HTTP(S) URLs ordered by priority; when it is absent, the existing `CHAIN_B_RPC_URL` supplies one endpoint. Normalized duplicate URLs, fragments and malformed entries are rejected. The expected genesis hash is required; timeout defaults to 10000 milliseconds and is bounded by the Node.js timer limit.

`.env.example` contains empty private-key and genesis placeholders. Production workers require the operator's intended destination genesis. Unified verification loads the ignored root `.env`, reads the actual local Chain B genesis, injects its development signer, and creates two temporary RPC access paths automatically. It never rewrites personal configuration. Keep secrets out of committed files, PostgreSQL records and logs. Public configuration and endpoint observations use `rpc-0`, `rpc-1` labels without full provider URLs, credentials or path/query API tokens. The existing npm worker entries read process environment against an already migrated database.

Each worker automatically selects and leases only immutable READY jobs in its configured source scope and destination domain, with absent or unfinished transaction intents. Ordinary candidates retain batch epoch, message index and job ID order; due preparation-deferred jobs form the alternating group described below. Destination filtering occurs before the per-worker limit and lease acquisition; foreign-domain jobs remain unchanged for their own workers. Explicit wrong-domain job submissions fail before lease acquisition or transaction preparation. Historical direct submissions, final intents, automatically stopped retries and leases actively held by another session are excluded before the per-worker limit. Pending intent takeover is allowed. Ordinary scans defer previously attempted intents until their durable next-action time, so they cannot fill the limit and starve new jobs; clean SIGNED candidates and unresolved broadcast journals remain immediately claimable. Relayer and Transaction Manager each strictly read and independently verify the package at their boundary, including canonical message, payload hash, ordered batch commitment, Merkle path, root, QC signatures and exact historical committee. Candidate filtering is operational routing, not protocol authorization. A queue status or database row cannot replace cryptographic verification. Invalid evidence or the wrong RPC chain creates no intent, reserved nonce or signed attempt.

Every destination access path must match both the configured chain ID and genesis hash before use; the chain ID must also match the canonical message domain. Submission uses the canonical `destinationGateway`, never `destinationReceiver`, with `value = 0` and execute(bytes) wrapping the unchanged v1 envelope. Payload bytes remain opaque and unchanged. New-job Relayer passes are fail-fast after bounded provider fallback, except for the explicit pre-signing execution rejection described below. Durable Transaction Manager retries handle transaction-level failures separately; invalid evidence and malformed hashes remain failures. A shared earlier unbroadcast or stopped nonce can defer new work without creating another intent. Worker A becoming unavailable does not require a new Ethereum account.

### Preparation execution rejection and bounded re-evaluation

Preparation validates the package, destination and RPC identity, then checks historical submissions and existing intents before estimating gas. An explicit execution revert from the supported structured `eth_estimateGas` response (Anvil JSON-RPC code 3) becomes `PREPARATION_DEFERRED` only at this absent-intent boundary. It allocates no nonce, signs no transaction, creates no intent/attempt/broadcast journal/receipt, and leaves the immutable job READY. The result contains a public job ID, fixed `ESTIMATE_EXECUTION_REVERT` reason and retry timestamp, with `submitted: false` and no transaction hash or nonce. Explicit worker submission uses the same defer state. The Relayer does not decode supplier commands or query business state to decide scheduling.

[016_relayer_preparation_defer.sql](indexer/migrations/016_relayer_preparation_defer.sql) adds nullable `preparation_retry_at` and a fixed allowed `preparation_defer_reason` to existing lease rows. PostgreSQL time and the existing `TX_REBROADCAST_INTERVAL_MS` interval determine the next attempt. Current-fence checks protect the write; a shared job-row lock serializes it with initial intent creation, including unfenced direct Manager preparation. A newly committed intent clears the metadata in the same transaction through an insert trigger; rollback also rolls back clearing. Lease release preserves pending defer metadata. Old rows with null metadata remain immediately eligible, and existing intents ignore preparation scheduling and retain their normal recovery/retry history.

Automatic selection excludes not-yet-due preparation work before LIMIT. Ordinary candidates and due deferred candidates are interleaved; the latter are ordered by retry time, then the original batch/index/job order. One persisted `preparation_deferred_turn` bit per configured worker records which group should receive the next slot. Both groups obtain a slot within two effective selection rounds, including `maxJobs=1`, fresh processes and invocation gaps longer than the interval. With D continuously claimable due deferred jobs ahead of or including a job, that job is reconsidered within at most 2D effective rounds of that worker. New fresh arrivals cannot indefinitely displace due work, and each repeated execution rejection moves its retry timestamp forward. Empty groups yield their slots to the other group. This is operational transport scheduling; it adds no recovery cursor for already persisted intents.

An automatic pass continues its other selected candidates after a preparation defer and reports a separate deferred count. Unknown errors, transport failures after provider fallback, wrong chain/genesis, malformed RPC responses, invalid protocol evidence, session loss and stale fences remain failures. Arbitrary revert-like text or a generic RPC error is insufficient to defer. Raw provider text, endpoint URLs and credentials are never stored as defer reasons. A successful later estimate follows normal preparation. An actually mined canonical receipt with status 0 remains terminal `REVERTED` under the existing transaction policy; preparation defer has no on-chain transaction outcome and does not consume Gateway replay or change ApplicationB state.

Unified verification covers unit and PostgreSQL boundaries, migration upgrade/rerun, stale-owner rejection, concurrent creation/rollback, independent process selection and continuous READY arrivals. The existing real-chain execution scenario retains the pre-signed on-chain business revert and additionally attempts a never-prepared redundant supplier command after the first grant, then executes an unrelated valid command through the same Gateway, ApplicationB and validator cluster. Run only `./scripts/verify.sh` and inspect the root `verification.log` for results.

### Worker identity, leases and fencing

`RELAYER_WORKER_ID` defaults to `relayer-a`; use `relayer-b` for a second concurrent worker. IDs contain 1–64 lowercase ASCII letters/digits, underscores or hyphens, starting with a letter/digit. They are operational labels, independent from the destination Ethereum signer. The existing `RELAYER_A_PRIVATE_KEY` name is retained for that shared signer; there is no second private key or nonce allocator. Worker ID and session ID never enter messages, Merkle roots, QCs, delivery packages, package digests, logical intent IDs or signed transactions.

`RELAYER_LEASE_MS` defaults to `30000` and accepts exact positive integer milliseconds up to `3600000`. The root verification supplies A/B identities and controlled test expiry automatically. A per-schema worker-ID registry assigns numeric lock IDs. A database session advisory lock rejects two live processes with the same configured ID, while distinct IDs can operate concurrently. A new process also gets a session UUID: restarting the same configured worker does not silently inherit a previous process's active lease. PID and hostname are not durable ownership authorities.

`relayer_job_leases` is separate mutable operational state with one persistent row per immutable delivery job. Acquisition is atomic across independent clients. An active lease is idempotently readable only by its current owner/session; another worker receives BUSY. PostgreSQL `clock_timestamp()` supplies authoritative acquisition, renewal and expiry time. A heartbeat renews at one third of the configured duration; direct renewal and release primitives remain independently callable.

Each takeover or reacquisition after release increments a PostgreSQL BIGINT fencing token, represented as an exact string/BigInt in JavaScript. Release retains the row and last token. Current release is idempotent; stale renewal, release and fenced transaction requests return `STALE_FENCE`. Graceful release helps availability, but expiry permits takeover after an unavailable process without a central monitor or force-steal API. No job has permanent worker affinity.

Relayer-originated transaction mutations carry job ID, owner, session and fencing token. The repository checks the live lease in the same transaction as the account/intent/attempt mutation. Account locks precede lease locks consistently. An already-authorized mutation retains its lease row lock until COMMIT, so a successor token cannot be issued in the middle of that transaction. Preparation checks again before signed commit; sends use already committed exact bytes. Broadcast markers and completion use separate short transactions, with RPC in between and fencing checked again before result mutation. A lease becoming stale never grants permission to mutate another owner.

Takeover reuses the existing intent, sender, nonce, gas, calldata, package digest, attempts, signed bytes, hashes and retry/replacement history. Before continuing a SIGNED candidate, the manager queries its known hashes. Unresolved journals trigger recovery independently of ordinary retry due time. Previously attempted or BROADCAST candidates obey their durable due time and replacement policy; ownership change itself cannot create a replacement or reset exhaustion. CONFIRMED/REVERTED jobs are excluded. Independent Transaction Manager retry and receipt commands continue using account/intent locks without requiring a permanently living Relayer owner.

The worker core exposes bounded `runOnce()` and `submitJob()` operations with no hidden infinite loop. Independent scheduled invocations can continue pending work. Operators must deploy distinct worker IDs against the same queue, signer and destination RPC configuration. Coordination assumes honest but crashable workers using repository APIs; a lease does not defend against an arbitrary malicious database client.

### Destination RPC pool

`rpc-pool.mjs` owns endpoint identity probes, priority selection, bounded requests and runtime health. `rpc.mjs` supplies the typed Transaction Manager interface. All configured URLs are interchangeable access paths to the same intended blockchain. Their URLs and labels never enter delivery packages, message IDs, package digests, intent identity, signed transactions, roots or QCs.

Ordinary operations try endpoints in configured order. Transport failures, timeouts and temporary RPC errors allow fallback; a later independent operation tries the primary again. HEALTHY means the current chain fingerprint probe succeeded, UNAVAILABLE permits another probe, and IDENTITY_MISMATCH quarantines that endpoint for the current pool session. A fresh pool probes again. Every request and probe has a timeout, transport-library retries are disabled, and there is no background health service or sticky provider session.

One centralized classifier uses structured HTTP, JSON-RPC and transport evidence before a bounded, case-normalized node-message fallback. HTTP status is retained before the transport promotes a JSON-RPC error body, so response-body parsing cannot erase a rate limit or timeout. HTTP 429, 5xx availability failures and the known client/provider rate-limit forms remain retry/failover eligible. Numeric JSON-RPC 429 and the configured provider's -32007 rate-limit response are supported contract forms; -32007 is not assigned a universal Ethereum meaning, and other server-error numbers are not classified by a broad numeric range.

HTTP 408, request deadlines and connection resets are transient for reads. During raw transaction broadcast, timeout or reset with an unknown external outcome is AMBIGUOUS_BROADCAST. Another verified path may receive only the same persisted bytes, and acceptance still requires the expected hash plus exact transaction or canonical receipt evidence. Deterministic invalid-transaction responses do not blindly fan out. Already-known requires exact-hash reconciliation, underpriced remains a same-nonce fee-policy event, and nonce-too-low retains historical-transaction/receipt/nonce reconciliation.

Unknown provider errors and malformed responses use RPC_RESPONSE_ERROR with explicit diagnostics, including RPC_UNKNOWN_ERROR or RPC_INVALID_RESPONSE, rather than claiming deterministic transaction invalidity. A failed broadcast of this kind retains signed evidence and stops automatic sending for operator attention; canonical receipt reconciliation remains available. Wrong returned hashes and chain/genesis identity failures remain fail-closed. Error observations contain only safe endpoint labels, classifications and structured status/code values; provider bodies, headers, credentials and secret URLs are not stored as diagnostics.

Broadcast fallback sends exactly the same committed raw transaction. It never estimates gas, refreshes fees, signs, reserves another nonce or creates a replacement. A response lost after acceptance may be followed by an already-known response from another provider; the existing manager reconciles the exact local hash against transaction/receipt evidence. A returned hash must match locally derived identity. Underpriced, nonce-too-low and deterministic transaction rejections return to transaction policy without blindly broadcasting through every provider.

Gas estimation uses the first successful endpoint's result. Base fee and priority fee are resolved together from one endpoint; a failed fee operation is retried as a whole through the next path. Pending nonce is the maximum successfully observed across available same-chain endpoints. The durable allocator still wins when every provider is behind, and never regresses after failover. Nonce-consumption reconciliation reads account state at the fixed conservative snapshot block and searches local hashes across providers before declaring an unknown consumer.

Endpoint health remains runtime operational data and requires no endpoint-health table or dependency. Durable broadcast journals record committed manager-action starts and individual endpoint-send starts/results using safe endpoint labels. The broadcast count measures committed manager-action starts, including an action interrupted before its first wire send; it does not count individual fallback requests or prove node acceptance.

Retry settings are optional in the ignored root `.env`; `.env.example` lists safe defaults:

| Setting | Default | Meaning |
| --- | ---: | --- |
| `TX_REBROADCAST_INTERVAL_MS` | `5000` | Delay before another bounded action |
| `TX_REPLACEMENT_AFTER_MS` | `60000` | Minimum accepted pending age for replacement |
| `TX_FEE_BUMP_NUMERATOR` / `TX_FEE_BUMP_DENOMINATOR` | `9` / `8` | Exact ceiling fee multiplier |
| `TX_MAX_ATTEMPTS` | `4` | Total signed candidates, including attempt 0 |
| `TX_MAX_FEE_PER_GAS` | `100000000000` | Max fee cap, in wei |
| `TX_MAX_PRIORITY_FEE_PER_GAS` | `10000000000` | Priority fee cap, in wei |

Intervals and counts are bounded positive integers; replacement age cannot be shorter than the rebroadcast interval, the multiplier must exceed one, and priority cap cannot exceed max fee cap. The real replacement verification requires at least two allowed attempts and fee caps that accommodate its development transactions.

### Complete destination RPC outages

Destination delivery remains durable when every configured RPC access path is unavailable. READY jobs, verified packages, transaction intents, nonce reservations and exact signed transactions persist independently of RPC availability. Transient all-endpoint failures cannot authorize execution, fabricate a confirmed or reverted receipt, or discard queued work. Committed failed broadcast-action journals remain available after later successful delivery.

When access to the same expected Chain B identity recovers, ordinary scheduled delivery, retry, recovery and receipt passes resume from persisted state without a per-job resubmission or database reset. An existing signed transaction retains its sender, nonce, calldata, gas, fees, signed bytes and hash; later queued work still follows normal nonce-ordering and lease/fencing rules. These are bounded one-shot APIs suitable for periodic invocation, not a built-in production daemon. RPC recovery alone does not establish destination finality or replace the Gateway's authorization and replay checks.

### Versioned transport encoding

`encodeDestinationSubmission(package, options)` independently verifies the package before encoding its inner envelope. Transport version 1 is plain Solidity ABI encoding with domain string `CrossChainDeliveryPackage`; that inner envelope has no function selector. The production Relayer uses `encodeGatewaySubmission` to wrap these unchanged bytes in the standard `execute(bytes)` call before transaction preparation. The envelope is not JSON text encoded as transaction data.

The outer ABI parameter types are:

```text
string, uint8, string, bytes, bytes, uint256, uint256, bytes32, bytes32[], bytes
```

Their ordered values are domain string, transport version, delivery job ID, encoded canonical message, encoded batch, message index, leaf count, Message Root, ordered Merkle siblings and encoded QC.

The nested message preserves all twelve fields in this order:

```text
version, sourceDomain, sourceGateway, sourceSender, destinationDomain,
destinationGateway, destinationReceiver, nonce, payload, payloadHash,
deadline, messageId
```

The batch encoding carries `batchVersion`, `batchEpoch`, `batchId` and ordered `batchMessageIds`. QC encoding carries its original protocol version, encoded common signed statement, QC digest and ordered `(voterIdentity, commitDigest, signature)` tuples. Version 1's statement is source domain, source gateway, batch epoch, batch ID, root, proposal digest and committee digest. Version 2 adds the signed view immediately after batch epoch. Version 3 additionally appends the signed validator epoch. Original signatures and field presence are preserved: legacy certificates are never upgraded or re-signed, and a current committee never substitutes for a historical one.

`packageDigest = keccak256(encodedTransport)` binds the operational submission record to the exact bytes without storing another large payload copy. It is an operational integrity value, not a new message identity, consensus domain or authorization mechanism.

### Persistent transaction model

`indexer/migrations/010_single_relayer.sql` retains immutable historical `relayer_submissions` with these fields:

```text
delivery_job_id, relayer_address, destination_domain, destination_gateway,
package_digest, transaction_hash, submitted_at
```

Historical records were written after RPC returned a hash. They remain unchanged and block new delivery attempts for the same job. Their missing nonce, fees and raw bytes are never invented. Production transport extends the existing `011_transaction_manager.sql` tables in place through `012_transaction_retry_replacement.sql`:

- `transaction_accounts`: destination chain, sender and persistent next nonce;
- `transaction_intents`: one intent per job, binding immutable package digest, chain, sender, canonical gateway, zero value, calldata and one permanently reserved nonce; operational status, next-action time, retry-stop reason and winning attempt are stored alongside that immutable body;
- `transaction_attempts`: append-only signed candidates numbered 0, 1, 2, and so on, each with immutable nonce, gas, EIP-1559 fees, type 2, raw bytes, transaction hash and parent; mutable operational fields record broadcast count/time, error class and typed receipt outcome.

The delivery job ID remains the intent ID. Unique constraints protect one intent per job, one nonce per chain/sender/intent, one ordinal per intent, one child per parent and one transaction hash. Replacement never changes delivery data or allocates another nonce. SQL guards enforce linear lineage, immutable signed fields, higher fees, unchanged gas and a winning attempt belonging to the intent. Jobs remain READY, batches remain COMMITTED, and source messages, cursor, finality, membership, Merkle proofs and historical QC evidence remain unchanged.

Migration backfills the original attempt's existing nonce and final outcome without re-signing or reconstructing any artifact. A historical accepted transaction proves at least one broadcast; an old SIGNED row has no invented send count. Existing direct-submission records remain outside this model.

[015_rpc_response_errors.sql](indexer/migrations/015_rpc_response_errors.sql) extends only the allowed operational error classes in the attempt and journal CHECK constraints. All previous classes remain readable. No signed artifact, historical journal completion, nonce, retry schedule or stop reason is rewritten or automatically reset.

### Nonce, gas, fees and signing

The destination EOA must be exclusively managed by this manager in one operational database namespace. Another wallet must not consume its Chain B nonce space. Chain A has a separate nonce space.

Initial preparation verifies the RPC chain, estimates gas for exact sender/target/value/data, resolves `maxFeePerGas = 2 * baseFeePerGas + maxPriorityFeePerGas` from current RPC data, and reads pending nonce. A PostgreSQL account row lock serializes allocation. The nonce is the maximum of RPC pending nonce, durable next nonce and highest reserved intent nonce plus one. Higher pending state may advance the allocator; local state never regresses. Account advancement, intent and initial SIGNED attempt commit together. Gas, fee, signing or pre-commit failures leave no ghost reservation.

Fees and nonces use exact BigInt arithmetic. A replacement retains the original gas limit and uses the maximum of current market fees, the ceiling of the prior fee multiplied by the configured ratio, and the prior fee plus one wei. Both fee fields strictly increase, and max fee remains at least priority fee. Caps are checked before signing; uint256 overflow fails closed. No legacy transaction fallback or gas re-estimation occurs on replacement.

Each candidate is signed locally as type 2. `transactionHash = keccak256(rawSignedTransaction)` is computed locally. Strict reads validate every historical candidate's RLP, recovered sender, immutable body, nonce and fee lineage. Existing intents return the durable history without estimating, signing or reserving again.

### Exact rebroadcast and replacement

Exact rebroadcast sends the same stored bytes, hash, nonce, gas and fees. It updates operational broadcast metadata without creating an attempt. A replacement creates a new signed candidate with strictly higher fees and a different hash, persists it before RPC submission, and marks its parent REPLACED as local history. That label does not prove the old transaction was dropped or cancelled: the old attempt may still win.

Transient and ambiguous send failures retain signed evidence and schedule exact rebroadcast first. A timeout does not establish rejection. The manager checks receipts before acting and never immediately increases fees for a transport failure. Already-known responses require the exact persisted transaction hash and matching RPC body or canonical receipt before being treated as acceptance. Nonce-too-low responses query all local candidates and latest/pending nonce. A known canonical candidate is reconciled; consumed nonce with no matching local evidence stops with `UNKNOWN_NONCE_CONSUMPTION`.

Underpriced responses make a higher-fee candidate eligible after the persisted retry interval. Otherwise, an accepted pending transaction becomes a replacement candidate only after the configured age threshold. Receipt and transaction queries are repeated before insertion; a mined candidate awaiting depth suppresses replacement. Account and intent row locks recheck the active parent, limits and final status atomically. Competing clients cannot create two children of the same parent, and a stale worker cannot broadcast a newer candidate unintentionally.

`processTransactionRetriesOnce({ limit })` reads a bounded, deterministically ordered due set and one fixed conservative destination view. It has no sleep or infinite loop. A fresh invocation uses persisted scheduling, counts and lineage; the injected clock affects operational timing only. Separate receipt passes continue to observe stopped intents. Reaching a cap or maximum attempts preserves pending evidence and does not declare business failure or allocate another nonce. Automatic retry stops are not silently reset.

When replacement preparation returns `NO_REPLACEMENT` for an unchanged PENDING, unstopped active attempt, the manager schedules the next bounded action with the existing retry interval. The write checks the original parent and recovery revision under the existing account/intent locks; a concurrent new candidate, terminal outcome, stop or revision change cannot receive the stale schedule. A mined transaction body without complete receipt evidence therefore avoids an immediately due retry loop without signing, sending or allocating a nonce.

The primitives include preparation, exact broadcast/rebroadcast, replacement preparation, bounded retries, recovery and bounded receipt inspection. The existing `transaction:once` CLI accepts `prepare`, `broadcast`, `rebroadcast`, `replace`, `read`, `retries`, `receipts` and `recover`. Relayer workers reselect unfinished intents and reconcile persisted hashes before requesting fenced processing. Ambiguous journals are eligible independently of ordinary retry due time. An earlier unbroadcast SIGNED or stopped pending nonce blocks higher-nonce sends.

### Durable broadcast journal and recovery

Intent creation, nonce reservation and the initial signed attempt commit atomically. A crash between their SQL statements rolls back the entire preparation; a committed intent without an attempt is corrupted state, not a normal recovery phase. Replacement preparation likewise commits an entire immutable next candidate or nothing. No migration reconstructs or re-signs old artifacts.

`014_transaction_recovery.sql` adds operational recovery-lock IDs, exact monotonic revisions and `transaction_broadcast_events`. These fields never affect intent identity, package digest, raw bytes, nonce or transaction hash. Every manager broadcast action commits an unresolved parent event before contacting providers. Every actual endpoint send commits a child event first, using only its safe `rpc-N` label. Per-attempt sequences are exact PostgreSQL BIGINT values. Event identity/start fields cannot change; completion is allowed once and completed history cannot be overwritten or deleted.

The sequence is `commit start → external RPC → commit result`. RPC execution holds no database transaction or row lock. A per-intent database session recovery lock coordinates normal sends, replacement and recovery across processes; it is separate from a job lease. Short mutation transactions recheck current intent/attempt state and any supplied owner/session/fencing token. An expired or lost owner cannot write a successor's state; a completion that cannot be stored remains unresolved for a fresh coordinator.

An incomplete event proves only that a send was started operationally: the RPC may never have been called, may have accepted the transaction, or may have lost its response. Local SIGNED status alone cannot establish absence from Chain B. Broadcast attempt count and last-attempt time now record committed manager starts, including starts interrupted before RPC; successful endpoint acceptance and canonical chain evidence are recorded separately. Parent and child events do not represent additional signed candidates.

`recoverTransactionsOnce()` scans a bounded, durably rotating non-final set using the existing worker limit, with nonce/job order within each keyset range. It strictly reads persisted signed history, then queries receipts and transactions for all candidate hashes through the destination RPC pool. It validates exact transaction context, canonical blocks and one fixed conservative confirmation view for the bulk pass. Pending or mined evidence can recover BROADCAST; a canonical receipt at depth atomically records the winner, intent status and receipt fields as CONFIRMED or REVERTED. Older attempts remain eligible winners. Recovery never creates a replacement merely because a process died.

A persisted same-nonce replacement survives worker loss before its first broadcast. Recovery checks every historical candidate's canonical receipt before progressing the latest durable attempt. A confirmed historical winner finalizes the intent and suppresses the unsent replacement; a mined candidate awaiting confirmation or complete receipt evidence also suppresses sending. If no winner is established, an older pending hash does not establish submission of the replacement. Its own visibility and broadcast journal determine whether it needs exact recovery. An already-visible replacement is reconciled by its persisted hash without another send. A missing replacement with no completed first send, or an unresolved start marker, continues immediately without waiting another replacement timeout or ordinary retry interval.

Recovery sends only the exact committed raw transaction. No gas refresh, fee refresh, signature, new intent, nonce or additional candidate is generated. Receipt rechecks before replacement transmission retain the original conservative confirmation head and precede any unknown-nonce-consumption stop, so a parent mined during visibility reads can still be reconciled. A reconciliation may complete unresolved events only for the particular hash established by network evidence; a parent's accepted event cannot substitute for the replacement's event, and the replacement's visibility cannot settle an unknown parent's journal. After reconciliation changes the durable revision, the coordinator uses a fresh coherent snapshot for the existing guarded send path. The ordinary retry scheduler treats unfinished sending of the active attempt as recovery work; an unresolved historical sibling does not indefinitely divert the current candidate's due retries. Legacy attempts without a journal are conservatively queried first; their unknown historical send counts are not invented.

A retry pass carries its fixed confirmation view into delegated recovery and onward into broadcast reconciliation after response loss. Standalone recovery captures one view and keeps it through those same steps. Newly mined canonical evidence can establish BROADCAST while the intent remains PENDING at the original confirmation head; a subsequent pass captures a fresh view before confirming sufficient depth.

Receipt and visibility evidence reads complete before recovery reconciliation writes. The coordinator rechecks the persisted revision inside its post-RPC mutation transaction. Concurrent advancement invalidates the snapshot and leaves further work to a fresh pass. Unavailable read paths, inconsistent provider evidence or conflicting candidate receipts preserve transaction state and report an unchanged result. A subsequent send continues through the existing identity, fencing and durable broadcast-start/result checks. Definitively advanced canonical account nonce with no canonically mined candidate fails closed with `UNKNOWN_NONCE_CONSUMPTION` and requires operator attention; a stale pending hash cannot explain that consumption. The exclusive-signer assumption remains mandatory.

Final intents are never automatically rebroadcast or replaced. Retry-stopped intents remain eligible for chain reconciliation and final receipt truth, but their stop reasons and limits are not reset and no additional candidate is created. Structured recovery output reports scanned, reconciled, rebroadcast, finalized, unchanged and manual-action counts. There is no required background loop, new dependency, signer service or production crash toggle. Worker memory is disposable; PostgreSQL, persisted signed identities and canonical Chain B observations are the recovery inputs.

Recovery failures retain the original error code, redacted diagnostic message and safe endpoint observations through recovery results and fenced worker errors. A generic retry classification does not replace the underlying failure detail. Diagnostics never become transaction identity or signed evidence; configured private keys, database URLs and provider URLs are redacted from messages.

### Durable fair receipt and recovery observation

[017_transaction_scan_progress.sql](indexer/migrations/017_transaction_scan_progress.sql) adds independent nullable `receipt_scan_cursor_nonce` and `recovery_scan_cursor_nonce` fields to `transaction_accounts`. Both use exact `NUMERIC(78,0)` uint256 bounds and are scoped by chain ID and sender address. A null cursor starts at the beginning. These fields never reserve or advance `next_nonce`, modify intent `recovery_version`, or establish transaction submission, canonicality or a winner. Preparation-defer scheduling remains separate.

Each automatic scan locks the existing account row in a short transaction, selects at most its limit of unique eligible intents after its own nonce cursor, and wraps to the range at or below that cursor to fill remaining capacity. Each SQL query is bounded; complementary ranges avoid duplicates even when the limit exceeds the population. No full-population JavaScript rotation, random ordering or OFFSET is used. The last selected nonce advances only that scan's cursor. The selector creates no account for an empty namespace and leaves a cursor unchanged when nothing is eligible. JavaScript keeps nonces as decimal strings/BigInt.

Receipt selection retains the possible-submission predicate; recovery selection includes all PENDING intents, including stopped intents that may still have canonical outcomes. Stable populations of N eligible intents are covered within `ceil(N / limit)` repeated passes. Fresh repositories, pools and processes share durable progress. Terminal intents drop out, new higher nonces join the forward range, and newly eligible lower nonces remain visible on wrap. Receipt and recovery passes cannot advance or overwrite each other's cursor; explicit job recovery and per-job receipt inspection bypass both bulk selectors.

Selection commits before RPC observation, with no account row lock held across network access. A cursor records work offered for observation, not successful observation or exclusive ownership. A crash immediately after cursor commit may skip that offer, but a later cycle revisits it; duplicate observation is safe under the existing recovery lock, revision, fence and canonical checks. Concurrent selectors serialize only their short account-row progress transactions. No new daemon or receipt lease is required.

Each pass remains bounded by selected intent count. Every selected intent still checks the complete historical candidate set required by its existing receipt/recovery path, using the fixed conservative view and normal RPC failover. Observation fairness grants no permission to send a higher nonce: earlier unbroadcast SIGNED guards, allocator exclusivity, retry stops, fee/attempt caps, replacement lineage and exact persisted raw bytes remain unchanged.

Unified verification extends the existing unit/database suites and lightweight process fixture with missing-earlier-receipt/later-canonical outcomes at limit 1, cursor independence, full-width nonces, wrap/empty/single sets, new eligibility, terminal removal, concurrent clients, lock release before RPC, migration upgrade/rerun and deterministic selection-commit interruption. No suite is invoked twice; results come from the user's root `./scripts/verify.sh` run and `verification.log`.

### Receipts, winner and restart boundary

An intent is PENDING until one canonical attempt reaches confirmation depth, then CONFIRMED or REVERTED. Receipt tracking checks every historical candidate with evidence of possible submission, including REPLACED parents; reconciliation before replacement also checks all stored hashes. It validates receipt hash, canonical block number/hash and exact sender, target, nonce, input, value, type, chain, gas and fees.

Each pass samples available endpoint heads once and fixes their minimum as its confirmation bound. It compares canonical block hashes at that common height. Receipt discovery searches those paths; a null response from one provider cannot hide a valid receipt from another. Receipt, transaction body and canonical block are obtained in the source endpoint's context. Other sampled endpoints already at the receipt height must agree on the block hash; a lagging endpoint is not identity-mismatched or treated as invalid. Temporary read failures may continue through another sampled path. Newly recovered paths participate in the next fresh view.

Confirmation count is `head - receiptBlockNumber + 1` against that fixed minimum. It is never raised mid-pass. Insufficient depth preserves PENDING and suppresses replacement when a transaction is mined. Full canonical evidence can establish BROADCAST after a lost response without prematurely confirming. Same-height hash conflicts produce `INCONSISTENT_RPC_VIEW`; incomplete evidence produces `RPC_VIEW_INCOMPLETE`. Neither finalizes an intent, and retries retain durable evidence for a later converged pass.

At depth, status 1 records CONFIRMED and status 0 records REVERTED. The current canonical winner is persisted and every sibling stops. Ordinary APIs cannot reopen terminal outcomes or append another attempt to them. Conflicting canonical same-nonce receipts fail closed. Typed receipt block/status, observed head and confirmation time are retained in immutable observation history; the attempt receipt columns cache the current outcome. Arbitrary receipt JSON is not protocol state.

Fresh processes recover intent status, exact signed history, broadcast counts, latest candidate, next-action time, stop reason, winner and allocator state. Recovery does not change the delivery package, gas, nonce or historical signatures.

The `relayer:once` CLI reports durable intent `status` and `intentStatus`. Its top-level transaction hash and nonce identify the canonical winner when one exists; the compact `latestAttempt` retains the latest candidate's own hash, status and attempt number. Without a winner, a pending intent displays its current candidate without claiming a confirmed outcome. Historical direct submissions retain their narrower historical status.

### Destination receipt reorganization recovery

Destination confirmation is an observation at the configured depth, not irreversible database truth. `checkReceiptsOnce()` retains its bounded PENDING selection and also offers up to the same limit of terminal intents through an independent per-chain/sender `terminal_scan_cursor_nonce`. Both populations share the pass's fixed conservative destination view; terminal work cannot consume PENDING selection slots. Persistent keyset wrap provides eventual rechecks across process and client restarts. The existing one-shot receipt command invokes this path; periodic invocation remains the operator's responsibility.

[018_destination_receipt_reconciliation.sql](indexer/migrations/018_destination_receipt_reconciliation.sql) adds append-only receipt observations and orphan evidence, a current-observation pointer and a durable recovery marker. Migration archives existing CONFIRMED/REVERTED receipt fields without resetting states, recovery versions, signatures, timestamps or nonce allocations. New terminal receipts are archived atomically. `getReceiptObservations(deliveryJobId)` exposes their original transaction hash, height/hash, receipt status, confirmation head/time and any later positive orphan evidence. Historical observations cannot be updated or deleted. The attempt's current cache can be invalidated only after the exact old observation has been preserved.

Before reconciliation, the RPC pool validates destination chain ID/genesis, fixes the minimum sampled head and its block hash, and checks the old receipt height across that view's available paths. A replacement block with a different hash at that height supplies positive orphan evidence. A null receipt, unavailable endpoint, timeout, lagging head or unresolved provider conflict does not authorize reopening or sending. The fixed head anchor is rechecked around evidence collection. Provider agreement is an access-path consistency check and supplies no Byzantine RPC consensus or absolute finality.

The manager revalidates the stored transaction body and every persisted same-nonce candidate. A still-canonical receipt is a no-op. The same hash re-included at another location, or an existing sibling that becomes canonical, is adopted without a new signature or broadcast; confirmation depth is recomputed for its new location. Below depth the current intent remains PENDING. Only a dedicated evidence-bound reconciliation transaction may reopen a displaced terminal outcome, using existing account/intent locks, recovery serialization and revision checks. SQL guards require matching durable orphan evidence created in that transaction. Public status then reports PENDING with `canonicality: REORG_RECOVERY`, not the orphaned historical success.

Before delivery recovery and again at an actual endpoint send boundary, the manager checks exact-message `DestinationGateway.isMessageExecuted(messageId)`, candidate receipts, current nonce evidence and any supplied fence. Positive orphan evidence remains durable even if a subsequent replay read fails: current status is PENDING and no send is authorized until replay can be checked. If the Gateway has already consumed the message through another transaction, recovery stops with `GATEWAY_ALREADY_EXECUTED`; it does not present the orphaned local hash as canonical or blindly send another transaction. Unexplained nonce consumption likewise stops for operator attention. Source authorization, deadline, remote trust, package bounds, QC/Merkle and receiver policy remain enforced by the production Gateway on any resubmission.

When execution disappeared, ordinary leased Relayer/Tx Manager operations can resume the original intent. Recovery first prefers its existing active signed candidate, preserving nonce, gas, EIP-1559 fields, raw bytes and hash. A reorg alone does not create a replacement or lower the allocator. After acceptance/known-transaction reconciliation, existing same-nonce retry/replacement policy retains authority. Retry stops, candidate counts and historical broadcast journals are never reset. No new source message, proof, PBFT round or READY authority is required.

Unified verification includes `[Destination Transaction Reorg Recovery]`: a fresh authenticated message reaches CONFIRMED through the real source/finality/batch/PBFT/Relayer/Gateway/ApplicationB pipeline. A local destination snapshot immediately before its external send preserves prior deployments and executions. Snapshot rollback, removal of only the displaced target from the local pending pool when necessary, and deterministic alternate-block mining remove that message's execution. Normal receipt scans discover the changed canonical block, retain the old receipt, and reopen recovery. Fresh database clients resume the same signed transaction; final confirmation requires one canonical Gateway event and one ApplicationB transition. Source, QC, queue and historical evidence remain unchanged. The scenario does not stop a database service, kill a relayer, introduce another chain or inject another consensus/RPC fault.

### PostgreSQL service restart recovery

Protocol workers derive restart recovery from durable PostgreSQL state rather than process memory. Database-dependent operations fail closed during a temporary server outage: no in-memory cursor, vote, job ownership, nonce reservation or transaction outcome substitutes for a successful durable write. Existing Indexer/Finality passes fail, and a validator scheduler may halt or its process may exit when database connections disappear. Once the same database becomes available, an operator or supervisor can restart the existing production processes with the same identities, configuration and schemas. The repository does not provide a database availability supervisor or an automatic worker-restart service.

Source occurrences and lifecycles, sealed batch membership and Message Roots, historical committee bindings, PBFT safety locks/votes/views/certificates, delivery jobs, transaction intents, reserved nonces, retry schedules and broadcast/receipt history remain in their existing stores. They are read and validated again through the production components. PostgreSQL provides operational durability; it grants no cross-chain authorization and does not replace source canonical/finality checks, QC/Merkle/package authentication or destination canonical receipt/replay checks.

A database restart releases session/advisory locks, without erasing durable leases or fencing counters. A fresh Relayer establishes a new session and uses the existing database-time lease-expiry/acquisition rules; an old fence cannot authorize a mutation after a higher token has been issued. If Chain B accepted a signed transaction before the local send-result write failed, the existing recovery journal and persisted hash direct canonical receipt/transaction reconciliation before any repeat send. Restart alone does not authorize a new intent, nonce, signature or replacement. Receipt, recovery and terminal-canonicality scan cursors are durable operational progress, not destination finality authority.

Complete verification includes `[PostgreSQL Restart Recovery]` on a separately owned temporary PostgreSQL cluster. Existing server binaries initialize this disposable cluster once, with an independent local port, loopback-only TCP access, synchronous durable writes and no shared user-database storage. Current Indexer and validator migrations create the real schemas. Four active production validator processes form a genuine QC for a fresh exact-intent ZK-authorized message; production delivery/transaction components persist its intent, nonce, signed candidate and endpoint journal before the actual Chain B send.

The existing accepted-endpoint IPC barrier pauses before result persistence. Verification stops only its own PostgreSQL server with `pg_ctl -m immediate`, verifies that it is unavailable, and lets a normal database-dependent operation and the interrupted Relayer fail. Both chains remain available. It restarts the same PGDATA without another `initdb`, migrations, table reseeding or SQL lifecycle repair. Fresh connections compare the original persisted state; affected validators resume with the same identities/stores, and a fresh Relayer acquires valid ownership and reconciles the original accepted transaction. Confirmation and event readback require one canonical Gateway consumption and one ApplicationB supplier transition, with no second signature or send. This is the verified restart scenario, not a global exactly-once guarantee under arbitrary failures.

The helper and root shell trap clean up only the cluster, files and processes owned by that verification run. They never stop a Homebrew/system PostgreSQL service or operate on PGDATA derived from the configured user `DATABASE_URL`. The temporary local cluster uses host trust authentication only on its ephemeral loopback listener; it is a local verification fixture, not production database configuration. Missing server binaries fail verification clearly without a fake client-only restart or an installation attempt.

This recovery model assumes PostgreSQL's persistent data remains intact. Permanent database loss is a separate disaster-recovery problem; the chains cannot reconstruct all historical off-chain votes, journals and operational state. Database replication, HA and automatic failover are outside this implementation.

### Recovery across component failures

Recovery can span the existing consensus, delivery and transaction components for the same source-authorized message. A four-member pinned committee can commit with one non-primary validator unavailable and exactly three live signers. Its authenticated READY package remains durable after the signing Relayer process crashes. A second Relayer waits for PostgreSQL-time lease expiry, acquires a higher fencing token, and loads the original intent, nonce, gas, fees, signed bytes and transaction hash. The old owner's fence cannot authorize protected mutations.

Complete verification appends `[Multi-component Recovery]` after the independent fault scenarios. It uses a fresh exact-intent ZK-authorized source message, a distinct supplier and the next batch epoch in the already-restored verification-owned database and validator namespace. It first verifies OBSERVED, FINALIZING and FINALIZED, then stops one deterministically selected active non-primary OS process before any target vote. The remaining three real validators form a view-zero QC; the offline validator contributes no PREPARE or COMMIT. No committee, threshold, source occurrence, root or certificate is replaced to obtain progress.

Independent Relayer A pauses after committing SIGNED, before any broadcast journal or external send, and is killed with `SIGKILL`. The same independent B process polls normally before and after natural lease expiry. Once B has valid ownership and has loaded the original candidate, all of its configured destination RPC paths become unavailable. B must observe structured `RPC_UNAVAILABLE`; the READY package, intent, reserved nonce, signed candidate and empty broadcast journal remain intact, with no destination execution. The underlying Chain B, Chain A and PostgreSQL remain available throughout this composed scenario. No database restart, source/destination reorg, Byzantine vote, primary failure or view change is injected here.

Restoring those same access paths to the same canonical Chain B lets B's ordinary bounded production worker and receipt-observation passes continue automatically. The harness provides no subsequent per-job submit/recovery command, new source authorization, proof, PBFT round, intent, nonce, estimate or signature. Its only chain advancement is mining the configured confirmation depth. Verification requires the exact retained hash, one accepted external send, one canonical Gateway event and one ApplicationB supplier transition, while preserving previous transaction and consensus history. One-time barriers and scheduling live only in test helpers; the production worker retains its normal lease/fence and recovery checks. Owned Relayers and RPC gates are cleaned up, and the surrounding resource owner then disposes its validator processes and temporary database.

This bounded scenario assumes the three remaining validators, persistent database, second Relayer and canonical chains remain functional, and destination access eventually returns. It establishes no liveness or distributed exactly-once guarantee for arbitrary simultaneous failures or permanent dependency loss. The validator quorum authorizes batch consensus; Relayers remain untrusted transport; PostgreSQL supplies operational durability; RPC endpoints supply access and evidence. The production DestinationGateway remains the final destination authorization and replay boundary.

### Verification and destination boundary

The unified flow preserves source, ZK, Merkle, PBFT, queue and direct-submission checks. Additional unit/database cases cover exact retries, error classification, fee arithmetic and limits, concurrent replacement, rollback, migration of old artifacts, old/new winners, canonical reverts and stopped-state recovery.

Real A/B/D and rotated E use the production manager; REORGED C receives no intent or nonce. Two independently controlled HTTP paths forward through the existing persistence observer to one real Chain B Anvil. Verification covers wrong-chain/wrong-genesis rejection, an initial send failure, all-path-unavailable persistence, actual acceptance followed by response loss, exact fallback with already-known reconciliation, gas/fee/nonce fallback, primary recovery and receipt confirmation through secondary.

The same local proxy also injects HTTP 429 before forwarding, HTTP 408 after verified upstream acceptance, and the configured -32007 rate-limit response. A focused isolated fixture uses the already verified source batch/QC and one Chain B, confirms exact secondary submission, recovers accepted-but-408 state in a fresh process without another send, and checks canonical winners. It includes receipt-read 408 fallback and controlled deterministic/malformed response rejection without blind fan-out. Its owned destination snapshot and automine setting are restored. Unit/database cases additionally check structured-message precedence, operation-aware classifications, all-path retry scheduling, stopped-state restart and an upgrade from historical error constraints.

A pending real transaction is replaced at the same nonce, recovered through fresh CLI processes, and broadcast through secondary after primary becomes unavailable. Its canonical winner is checked at configured depth. Test-owned paths are cleaned up and the original automine setting is restored. Production never changes mining behavior. Unit/database tests additionally cover lagging visibility, null receipts, conflicting block views, allocation non-regression and old/new winners across provider changes.

Two real Relayer OS processes compete for the same actual job, reject duplicate worker IDs and stale tokens, and hold distinct job leases concurrently. Verification stops A after lease acquisition before intent creation, expires that lease through a test-only database helper, and observes B's higher token. A separate scenario stops A after committed SIGNED and before any external broadcast; B continues identical intent/nonce/raw bytes/hash, followed by the existing pending replacement and RPC-failover checks. PID registries, bounded IPC barriers and cleanup cover both workers. Unit/database tests additionally exercise renewal, atomic contention, commit-time fencing, fresh-client recovery and stopped/final job exclusion. The verification script alone executes these procedures.

The crash verification extends the existing process/IPC harness with explicit SQL, marker, RPC-result, receipt and final-commit checkpoints. It keeps a real parent transaction pending, kills A immediately after committing an unbroadcast replacement, and observes fresh B send those exact bytes through secondary with a higher fencing token. A stale A recovery request is rejected before any protected send. Response loss after actual replacement acceptance remains a separate checkpoint: a further fresh process reconciles that candidate without another send, attempt or nonce. A separate historical-winner scenario mines the parent before recovery and requires the replacement to stay unsent. The same flow retains replacement rollback, real receipt reobservation, rollback before final COMMIT and restart after final COMMIT. Database lock-release barriers replace guessed delays. Isolated fixtures reuse real A/B/D evidence and its existing QC without generating new consensus. Their own RPC observer independently verifies committed endpoint markers before forwarding.

Verification snapshots Chain B, controls automine and temporarily uses minimal reverting bytecode only to obtain a real status-0 receipt. It restores the original chain snapshot, bytecode and mining mode, and cleans up its own processes/proxies. These test fixtures implement no destination protocol and are separate from the normal durable deployment namespace. Unit/database tests also cover conflicts, corruption, exhaustion, exact identities, immutable journals, concurrent recovery and stale writeback.

CONFIRMED records a successful canonical receipt at configured depth, a heuristic rather than permanent finality. For a new zero-value execute(bytes) transaction targeting the production DestinationGateway, EVM success means its complete verification, replay consumption and receiver call committed atomically; verification also reads both Gateway and ApplicationB storage directly. Historical EOA-targeted receipts retain their narrower transport-inclusion meaning. Later positive destination replacement evidence is reconciled through the receipt history and original intent; Byzantine RPC-provider consensus remains outside the implementation.

## Cross-chain Message Explorer

A built-in read-only Explorer opens with recent messages from the configured source scope. Choose a message to follow its Chain A source occurrence through authorization, finality, batching, Merkle commitment, PBFT votes and quorum evidence, Relayer transaction history, and the current persisted Chain B execution result. It consumes the Message Query API described below. It never authorizes a proof, finalizes a source occurrence, votes, retries a delivery, reserves a nonce or submits a transaction.

The Explorer is served by the existing API process. The complete local launcher `./scripts/start.sh` configures and starts it alongside the protocol; open the printed address (default `http://127.0.0.1:8080/`, also available at `/explorer`). The homepage automatically loads up to 20 recent messages with first-observed time, exact source/destination domains and explicitly labelled source status. Select an ID link to open its lifecycle; no ID lookup in logs is required. Complete-ID search remains optional. Copy ID/copy link actions and expandable full IDs support sharing without losing the exact identifier. If clipboard access is unavailable, the page explains how to select the full ID or copy the browser URL.

Older messages uses bounded cursor pagination; Latest messages returns to the first page. The `before` query parameter preserves a list page through detail navigation and browser back/forward. Details retain the shareable `messageId` query parameter. Refresh reloads the current list or selected detail independently of unfinished search input; blank search returns to browsing without an invalid-ID error. Empty pages show a no-messages explanation and a path back to the latest messages. No second daemon, frontend build, package installation, wallet, external font or CDN is required. The page uses repository-local HTML, CSS and JavaScript modules. Listener configuration remains the API's existing loopback host/port settings.

The lifecycle timeline and detailed sections show Source, ZK Authorization, Finality, Batch, Merkle Commitment, PBFT Consensus, Validator Votes, Quorum & Certificate, Delivery, Relayer Attempts, Destination Transaction and Execution Result. Full-width integers remain exact decimal strings. Hashes remain fully readable and wrap on narrow screens. Public payload bytes are shown as hex in technical details. Search is keyboard-accessible, reports loading and fixed safe errors, cancels superseded requests and supports browser back/forward navigation. Refresh only performs another observational GET.

The page preserves original QC versions and pinned historical committees. It renders actual durable votes without adding an offline member's missing vote. Pending source/consensus states never imply delivery or execution. Attempt history retains replacement parents and older canonical winners. Orphaned receipts are visibly historical; the current destination observation is displayed separately, including recovery with no current winner. `TRANSPORT_CONFIRMED` does not imply Gateway/ApplicationB execution; `REVERTED` remains a failure. Application-specific business results remain unavailable unless supplied by the generic API, and are never decoded or inferred from supplier payloads.

Authorization observations require `IDENTITY_APPLICATION_ADDRESS` to identify the deployed, non-upgradeable production `IdentityApplicationA` for the configured source domain and SourceGateway. The query layer matches the exact version-2 message's `sourceSender` and source scope to this deployment. This relies on the production contract's only outbound path, `forwardAuthorizedMessage`, verifying the exact intent proof before calling SourceGateway; it is an operator-configured deployment assumption, not independent contract-code or Groth16 verification by the API. The existing complete verification separately observes the correlated `AuthorizedMessageForwarded` event and source message after a successful real proof-bearing transaction.

Matching live occurrences expose `AUTHORIZED`; a displaced occurrence exposes only `HISTORICAL_AUTHORIZED` on its former branch. Missing configuration, another application, another scope or an unsupported historical message version exposes `UNAVAILABLE`. An unavailable observation is not a failed proof. This field does not claim current credential validity, permanent source finality, credential-to-EVM ownership or a new proof check. Neither proofs nor private witnesses are sent to the browser.

The Explorer has no database, Validator-store or chain-RPC access and no protocol authority. All browser requests use the same-origin read-only API; all API-controlled display values are inserted as text. The server serves an explicit static-path allowlist, never arbitrary project files, with same-origin content restrictions. Explorer/API downtime does not affect protocol processing. Observations can lag chain changes; viewing a message never triggers reconciliation or reorg recovery. The server also provides the operational `/metrics` endpoint below; the Explorer contains no metrics dashboard, authentication or analytics service.

The single full verification entry remains `./scripts/verify.sh`, writing the latest complete run to root `verification.log`. It retains all protocol regressions and includes Explorer view-model/client/renderer tests, list/deep-link/refresh/copy navigation tests with a text-only DOM fixture, and real loopback static/API HTTP tests. Database cases check bounded pagination, scope isolation, live/orphan deduplication and unchanged persisted state. Existing E2E listeners also serve the assets, discover real messages through the production list client, feed real details through the same view-model/renderer code, and cover source orphans, historical committees, replacement history, destination reorg recovery and the three-of-four successful production execution. This is HTTP plus production presentation-code verification without browser automation; visual browser behavior still requires manual inspection. Repeated Explorer list/detail queries remain inside the existing zero-protocol-mutation snapshot checks.

## Read-only Message Lifecycle API

`GET /api/v1/messages` discovers messages in the configured source domain/Gateway and database schema. Optional `limit` defaults to `20` and must be an integer from `1` to `100`; optional `before` is the previous response's exact decimal `nextCursor`. Responses contain `apiVersion`, `authority: "OBSERVATIONAL"`, `observedAt`, `items` and `nextCursor` (`null` on the last page). Each item includes only `messageId`, `sourceDomain`, `destinationDomain`, `sourceStatus` and `observedAt`. Invalid, duplicated or unknown query parameters return `400 INVALID_LIST_QUERY` before database access.

The list uses a `REPEATABLE READ READ ONLY` snapshot, selects at most `limit + 1` rows and never runs a worker or queries a Validator store/RPC. Ordering follows descending stored source-occurrence IDs, with exact keyset cursors rather than offsets. For a repeated canonical message ID it prefers the live occurrence; if all occurrences are REORGED it selects the newest historical one. Older displaced occurrences stay out of later pages. Pages are independent observations: newly ingested/reorged occurrences can change a later refresh; the API does not promise a frozen snapshot across requests. Source FINALIZED is not destination execution or independently reverified QC evidence. The detail endpoint remains the place to inspect authenticated persisted lifecycle evidence.

`GET /api/v1/messages/:messageId` correlates one canonical cross-chain message with its source transaction and block, persisted source finality, immutable batch/Merkle commitment, PBFT observations and actual validator votes, historical quorum certificate, READY delivery job, ordered transaction attempts and current persisted destination outcome. IDs must be `0x` followed by exactly 64 hex digits; hex letters are case-insensitive and responses use lowercase canonical hex. Short values, whitespace and arbitrary strings are rejected.

Responses carry `apiVersion: "1"`, `authority: "OBSERVATIONAL"` and `observedAt`, followed by these sections:

- `message`, `zkAuthorization`, `sourceTransaction`, `sourceBlock`, `sourceOccurrences`, `finality`;
- `batch`, `merkle`, `pbft`, `validatorVotes`, `qc`;
- `delivery`, `deliveryAttempts`, `destinationTransaction`, `execution`.

Full-width integer fields are encoded as exact decimal strings, including domains, nonces, deadlines, block heights, epochs, views, fees and fencing tokens. Bounded flags/counts can remain JSON booleans or small numbers. Later lifecycle sections remain `null` or empty lists until evidence exists. A BUILDING batch has no sealed ID/root/position yet. The API never manufactures a QC, missing vote, delivery transaction or execution for an early or terminal REORGED source occurrence.

The canonical message fields are checked against the requested ID. If the same ID has historical source occurrences, the one non-REORGED occurrence is selected; when all are REORGED, the newest persisted occurrence supplies the main provenance. `sourceOccurrences` retains the other provenance. Multiple live occurrences fail closed. Historical source blocks retain their own hashes even after the indexed canonical branch changes; a missing historical parent hash stays `null`.

Batch and delivery reads reuse the production snapshot/Merkle/QC validators on an unlocked read-only database snapshot. Vote readers query only the requested batch epoch and its observed or certified view in explicitly configured identity-bound validator stores. They authenticate the public evidence and deduplicate copies by phase/view/signer, with `observedBy` indicating which stores retain each vote. Local observations are separate from the source batch's COMMITTED state. Historical messages retain their pinned committee and original QC version; the latest committee does not replace earlier authority. An offline Validator process can still have readable durable state. No configured reader, an unavailable database and an observed absence of votes are distinct conditions.

The API reads persisted observations and does not connect to Chain A or Chain B. `PERSISTED_CANONICAL` describes the Transaction Manager's current stored winner, not fresh independent proof of permanent chain finality. A fork that workers have not yet observed will not be discovered by GET. Archived orphan receipts remain in attempt history; once production reconciliation reopens an intent, the current transaction has no canonical winner and execution reports `REORG_RECOVERY`. GET never performs that reconciliation itself. The latest replacement is not substituted for an older actual canonical winner.

For the configured production Gateway, a current successful receipt for the exact authenticated `execute(bytes)` call is reported as execution `CONFIRMED`. Set the public `PRODUCTION_DESTINATION_GATEWAY_ADDRESS` to identify that deployment. Without that match, successful historical/raw-envelope or EOA-targeted transactions are labelled `TRANSPORT_CONFIRMED`, with no Gateway/business-success claim. `businessResult` remains `null`: the generic lifecycle API does not interpret supplier actions or query ApplicationB live. Full verification separately cross-checks the queried real production execution against Gateway replay and ApplicationB state.

### Configuration and startup

Use the ignored root `.env` for local connection material and the committed `.env.example` only as a placeholder reference. API configuration reuses `DATABASE_URL`, `INDEXER_DB_SCHEMA`, `CHAIN_A_DOMAIN`, `SOURCE_GATEWAY_ADDRESS`, `FINALITY_BLOCK_DEPTH`, `DESTINATION_CONFIRMATIONS` and the existing public validator-set history configuration. The optional public `IDENTITY_APPLICATION_ADDRESS` enables the deployment-scoped authorization observation described above; leaving it empty reports unavailable evidence. It does not require a signer key or an RPC URL/genesis. Listener settings default to `MESSAGE_QUERY_API_HOST=127.0.0.1` and `MESSAGE_QUERY_API_PORT=8080`.

`MESSAGE_QUERY_VALIDATOR_STORES` is a JSON array of existing reader locations. Each entry has `validatorAddress`, `databaseSchema`, and optionally `databaseUrl`; omitted URLs use `DATABASE_URL`. Supply readers for the historical committee members whose messages you query. Use actual public identities/schemas from your deployment; do not copy verification's temporary namespaces into a production configuration. Separate database credentials belong only in your ignored `.env`. The API creates no schemas, migrations, tables, votes or copied Explorer state.

Use separate root entries for verification and an interactive local deployment:

- `./scripts/verify.sh`: runs full verification as before and overwrites root `verification.log`.
- `./scripts/start.sh`: starts the complete owned local stack, automatically prepares or reuses a confirmed message and returns its Explorer link without changing `verification.log`.
- `./scripts/stop.sh`: stops only that stack's owned processes.

To browse messages:

```bash
./scripts/start.sh
```

The startup script resolves the repository and loads ignored root `.env`. Its detached supervisor owns the complete local deployment described in Local quick start and supplies actual deployment configuration directly to child processes. Startup waits for both worker readiness and a real confirmed message, so the Explorer has usable data without an extra terminal command. A repeated start checks and reuses the existing message. Full verification includes all normal-path and validator-fault scenarios automatically; startup runs only the normal path. Use `stop.sh` for shutdown. `verification.log` remains exclusively owned by `verify.sh`.

Standalone startup needs `DATABASE_URL`, the intended `INDEXER_DB_SCHEMA`, `CHAIN_A_DOMAIN`, `SOURCE_GATEWAY_ADDRESS`, `FINALITY_BLOCK_DEPTH`, and exactly one of `VALIDATOR_SET_HISTORY` or `VALIDATOR_SET_HISTORY_FILE`. Relative API history-file paths resolve against the project root where `.env` lives, independently of the shell/npm working directory. The committed history example is not an automatic fallback: supply the actual history for the selected source schema. Reader identities/schemas in `MESSAGE_QUERY_VALIDATOR_STORES` must belong to that same deployment; a separate reader connection URL remains private in `.env`.

A successful `verify.sh` run does not configure the low-level standalone `npm --prefix indexer run api:start` command. Its source addresses, history and reader locations belong to its temporary processes. The full `start.sh` launcher needs no copied verification addresses. When using the low-level API command to inspect persisted verification data, supply the public deployment addresses and actual history/read stores established for that selected source schema. Isolated fault/rotation namespaces have their own histories; do not combine their committee configuration with another namespace.

Missing/invalid standalone configuration now fails before pools or listeners are created with `INVALID_CONFIGURATION` and the affected field names together. Listener conflicts report `LISTEN_ADDRESS_IN_USE` with the host/port settings to check. Diagnostics do not echo configuration values, connection strings, file contents or arbitrary exceptions, and HTTP error bodies retain their fixed public codes.

### Errors, purity and trust

HTTP results are `200` for a consistent observed lifecycle, `400` for an invalid message ID, `404` for an unknown message/route, `405` for unsupported methods, `409` for inconsistent persisted evidence, `503` for unavailable observational dependencies, and `500` for unexpected internal errors. Responses contain fixed public error codes without database/RPC credentials, provider messages or stack traces. The explicit response allowlist excludes raw signed transaction bytes, private keys, private credential attributes, witnesses and connection strings. Public cross-chain payloads and signed public PBFT votes remain visible.

Each source/delivery/transaction read uses a `REPEATABLE READ READ ONLY` transaction. Validator stores have their own read-only snapshots; the API does not claim atomic snapshots across independent databases. It acquires no worker/account/voting row locks, advisory locks or delivery ownership. It advances no cursor, finality, PBFT phase, retry schedule or destination recovery. It signs and broadcasts nothing, and it repairs no corrupted evidence.

API responses are not protocol authorization or finality authority. Query API downtime does not affect message processing. The dependency direction is Explorer → API → existing state; Indexer, Validators, Relayers, Transaction Manager and Gateway never depend on this observational surface for decisions. DestinationGateway remains the destination authorization/replay boundary. The local read-only surface includes the built-in Explorer and a separate `/metrics` route, without an authentication service or dashboard.

Complete verification retains all protocol and fault-recovery coverage, adds HTTP/unit/database query cases, and queries existing real successful messages, source orphans, replacement history, historical committees and a temporarily reopened destination intent. It also queries the fresh three-of-four execution from composed recovery while its owned stores remain available. Repeated HTTP reads are compared against source/consensus/lease/account/attempt/receipt/business snapshots, with no new chain or Validator world.

## Prometheus Operational Metrics

The protocol exposes Prometheus-compatible operational metrics for source ingestion/finality/reorgs, batch creation, local PBFT progress, Validator readiness, durable transaction attempts/retries/replacements, destination RPC failures and execution outcomes. Metrics are aggregate observations. They authorize no source transition, consensus vote, delivery, nonce allocation, retry or Gateway execution.

### Endpoints and process ownership

`GET /metrics` returns the standard Prometheus text exposition and content type produced by [prom-client](https://github.com/siimon/prom-client/tree/v15.1.3), pinned to `15.1.3` in the Indexer package and lockfile. `HEAD` is supported; other methods receive `405` without changing counters or protocol state. The original fifteen instruments serialize in-memory state without database/RPC queries, worker locks, recovery or backfill. The API additionally owns the read-only pending-delivery collector described below, which performs one aggregate SELECT per scrape. Serialization failure returns a fixed safe `503`; no error stack or connection material is exposed, and ordinary protocol processing continues.

Each OS process owns one explicit registry. It is never registered with prom-client's global registry. API/Explorer serves `/metrics` on its existing `MESSAGE_QUERY_API_HOST`/`MESSAGE_QUERY_API_PORT` (default `127.0.0.1:8080`). Each Validator serves its own registry on that Validator's existing HTTP port. API scrapes do not aggregate event counters from separate workers or reconstruct counters from their databases. An API-only process will legitimately expose zero protocol-event counters; its additional pending gauge observes the configured durable source scope.

Indexer, Finality, Relayer and Transaction Manager CLI entries can expose their own same-process metrics-only listener using optional `METRICS_HOST` (default `127.0.0.1`) and `METRICS_PORT`. An empty/unset port disables it. Hosts are limited to loopback (`127.0.0.1`, `::1`, `localhost`); assign a different port to each simultaneous CLI process through its own environment. The listener has no scheduler or protocol commands, closes with its owning run, and a bind failure does not stop that worker. Short-lived one-shot workers can finish between scrapes; no background daemon, persistent exporter, process aggregation or new worker mode is provided.

For example, an external Prometheus instance can use these static targets after the existing API and a worker configured on port `9101` have been started:

```yaml
scrape_configs:
  - job_name: cross-chain-api
    static_configs:
      - targets: ["127.0.0.1:8080"]
  - job_name: cross-chain-worker
    static_configs:
      - targets: ["127.0.0.1:9101"]
```

This minimal snippet illustrates worker ownership only. For the supplied Grafana dashboard, use `observability/prometheus/prometheus.example.yml` and its fixed job names instead. Add each running Validator's actual existing HTTP address as a separate target; the repository does not assign a second Validator port. Target/job labels belong to the scraper, not protocol message labels. External Prometheus/Grafana installation and operation remain outside the verification prerequisites; dashboard artifacts are verified without starting those services.

### Metric definitions

Every name below is exported exactly as written. All counters track new events in the owning process; they are not database-wide totals or current-state gauges.

| Metric | Type | Instrumentation and meaning |
| --- | --- | --- |
| `cross_chain_messages_observed_total` | Counter | Actual new source occurrence inserts after `persistRange` commits; duplicates and rolled-back inserts add zero. |
| `cross_chain_messages_finalized_total` | Counter | Actual OBSERVED/FINALIZING → FINALIZED row transitions after finality COMMIT. |
| `cross_chain_messages_reorged_total` | Counter | Actual unfinalized occurrence → REORGED transitions after canonical recovery COMMIT; repeated reconciliation adds zero. |
| `cross_chain_batches_created_total` | Counter | New BUILDING batch INSERT after COMMIT; collection of an existing batch, seal, consensus commit and reads add zero. |
| `cross_chain_pbft_round_duration_seconds` | Histogram | **Local Validator** persisted PRE-PREPARE acceptance → first durable local QC (`outcome="committed"`), or acceptance → certified NEW_VIEW abandonment without an old-view QC (`outcome="view_change"`). No accepted proposal means no invented start/sample. Replicas produce independent local observations, not a single global-round count. |
| `cross_chain_pbft_view_changes_total` | Counter | A genuinely higher, verified NEW_VIEW accepted by this local Validator after COMMIT; repeated envelopes and reads add zero. Timeout votes alone do not increment it. |
| `cross_chain_validator_available` | Gauge | Zero during local startup/unready/closed or halted scheduler; one after production initialization/listen and successful existing readiness checks. Existing failed health checks set zero. Scraping does not actively probe readiness. Process death is represented by scrape failure / Prometheus `up=0`, never committee mutation. |
| `cross_chain_pbft_quorum_failures_total` | Counter | First durable local timeout/view-change entry for an active old view lacking a local QC. Repeated timeout votes, escalation of that same old view, insufficient/invalid vote input and passive reads add zero. |
| `cross_chain_delivery_attempts_total` | Counter | Each newly persisted signed transaction candidate, including a replacement, after COMMIT; no increment for preparation calls, rebroadcast, receipt polling or read-only recovery. |
| `cross_chain_delivery_retries_total` | Counter | `kind="replacement"` on durable new replacement creation; `kind="exact_rebroadcast"` on the first durably completed endpoint-send result of a repeated logical broadcast action for the same candidate. Root start markers without external send, subsequent failover endpoints and receipt-only reconciliation add zero. A crash before durable send-result recording can leave an observation gap. |
| `cross_chain_relayer_failures_total` | Counter | Failed explicit Relayer/Transaction Manager actions, bounded by `operation` and `reason_class`. A propagated manager failure is counted once. Normal no-work/busy/defer/front-nonce blocking results add zero. Successful RPC failover alone is not a failed action. |
| `cross_chain_rpc_failures_total` | Counter | Failed destination endpoint requests, including primary failure followed by successful fallback, plus explicit identity, single-request validation and broadcast-hash rejection. Bounded `operation`/`reason_class`; no endpoint URL label. Counts requests, not logical deliveries. Cross-provider disagreement without an identifiable failed individual request remains existing protocol diagnostics. |
| `cross_chain_transaction_replacements_total` | Counter | Each genuinely new durable same-nonce replacement candidate after COMMIT. Concurrent duplicate preparation, reuse and reconciliation add zero. |
| `cross_chain_cross_chain_latency_seconds` | Histogram | Persisted `source_messages.observed_at` → persisted canonical receipt `confirmed_at` for a new successful terminal observation of the exact `execute(bytes)` wrapper at configured `PRODUCTION_DESTINATION_GATEWAY_ADDRESS`. The doubled `cross_chain` is the canonical metric name. Historical raw-envelope/EOA transport receipts, signature creation and unconfirmed sends are excluded. |
| `cross_chain_destination_execution_failures_total` | Counter | A new durably canonical REVERTED destination transaction outcome after the ordinary receipt-depth checks; repeated reads/polls add zero. Estimate rejection/defer and unavailable RPCs do not create this event. |
| `cross_chain_pending_delivery_jobs` | Gauge | API-owned current count of READY jobs whose source remains FINALIZED in the configured source domain/Gateway, with no CONFIRMED/REVERTED intent. Read-only collection, no labels, no event-counter reconstruction. |

PBFT histogram buckets (seconds): `0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120`. Latency buckets (seconds): `0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600`. Standard `_bucket`, `_sum`, `_count` and `+Inf` series are provided. Missing, invalid or negative persisted durations drop only that metric observation.

Counter labels are allowlisted finite enums. Relayer `operation` is `process_job`, `run` or `transaction`; `reason_class` is one of `TRANSIENT_RPC_ERROR`, `AMBIGUOUS_BROADCAST`, `ALREADY_KNOWN`, `REPLACEMENT_UNDERPRICED`, `NONCE_TOO_LOW`, `DETERMINISTIC_REJECTION`, `RPC_RESPONSE_ERROR`, `STALE_FENCE`, `RELAYER_RUN_FAILED`, `TRANSACTION_MANAGER_FAILED`. RPC operations are the wire methods `eth_chainId`, `eth_getBlockByNumber`, `eth_blockNumber`, `eth_getTransactionCount`, `eth_getTransactionReceipt`, `eth_getTransactionByHash`, `eth_sendRawTransaction`, `eth_estimateGas`, `eth_maxPriorityFeePerGas`, `eth_call`, with the first seven failure classes above. Message/batch/transaction IDs, roots/QC digests, signer/user addresses, nonces, URLs, worker IDs, arbitrary exception text, credentials, private keys, raw signed bytes and private witnesses never become labels or exposition data.

### Event accuracy and verification

Durable transition observations are emitted only after COMMIT and discarded on rollback. They are best-effort in-memory telemetry: restart resets counters/histograms, and a crash or unavailable sink between durable COMMIT and observation can undercount. No metrics database, migration, recovery authority, event bus or historical counter backfill exists. Scraping and repeated recovery reads never replay past metric events. Library/sink/serialization failures are isolated from existing protocol errors, which retain their normal fail-fast behavior.

Canonical receipt finality remains depth-based and reversible. A later reorg does not subtract an old counter/histogram observation. Genuine canonical reconfirmation after ordinary production recovery is a **new terminal event**, and may produce a second latency or failure observation for the same intent. These metrics describe observed events; they are not an exactly-once business-execution ledger. The lifecycle API and immutable receipt history remain the place to inspect current/historical provenance.

The existing `./scripts/verify.sh` adds `[prometheus operational metrics]` for library types/HELP/buckets, isolated registries, bounded labels, secret sentinels, loopback HTTP methods and fail-open serialization/sinks, rollback/duplicate persistence, and event deltas. It checks the installed pinned dependency without installing packages. Existing real source/finality/reorg, PBFT/primary-failure, retry/replacement, all-path RPC outage, Gateway success and canonical REVERTED scenarios retain their original safety assertions and add metric deltas. Existing Explorer/API zero-mutation snapshots now include repeated metrics scrapes, covering source/QC/votes/leases/nonces/retries/attempts/receipts and Gateway/ApplicationB state. Results overwrite root `verification.log`. No Prometheus server, Grafana, additional chain, Validator network or fault framework is started just for metrics.

## Grafana Operational Dashboard

The repository ships **Cross-Chain Protocol Overview**, a single provisionable/importable Grafana dashboard backed only by Prometheus. It provides aggregate message throughput, cross-chain latency, PBFT and Validator health, Relayer/RPC behavior, unresolved delivery backlog, source reorgs and independent failure/retry activity. The Explorer remains the place for individual-message investigation. Grafana never participates in source authorization, finality, voting, delivery ownership, signing or destination execution.

```text
Protocol workers ── /metrics ──> Prometheus ──> Grafana (aggregate operations)
Existing durable state ──> Message Query API ──> Explorer (one message)
```

The committed artifacts are:

- `observability/grafana/dashboards/cross-chain-protocol.json`: stable dashboard UID `cross-chain-protocol`, version 1, Classic JSON schema 39, built-in Stat/Time series/Row panels; no external panel plugins, scripts or remote assets.
- `observability/grafana/provisioning/dashboards/cross-chain.yaml`: a file provider in the Cross-Chain folder, refreshed every 30 seconds. UI saves are disabled intentionally; the committed artifact controls the definition. Removing the source does not automatically delete the dashboard.
- `observability/grafana/provisioning/datasources/prometheus.yaml`: the sole datasource, UID `cross-chain-prometheus`, server/proxy access to `http://127.0.0.1:9090`, GET queries and a 15-second minimum interval.
- `observability/prometheus/prometheus.example.yml`: public loopback scrape examples with the job-name contract used by dashboard queries.

The JSON uses the widely supported [Classic model](https://grafana.com/docs/grafana/latest/visualizations/dashboards/build-dashboards/view-dashboard-json-model/) and ordinary [file provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/), intended for Grafana installations supporting that model, including Grafana 11/12. It does not require an experimental dashboard schema or a Grafana application package dependency.

### Configure existing observability services

1. Start the existing protocol components and read-only API against the intended deployment. The API collector uses its existing source domain/Gateway and database schema configuration. It opens no connection to a chain node for collection.
2. Configure your external Prometheus from the committed example. Keep job names `cross-chain-api`, `cross-chain-workers`, `cross-chain-validators`: readiness queries select only the Validator job, excluding zero-initialized gauges from other processes. Supply the actual configured Validator HTTP addresses in the intentionally empty Validator target list. The worker example at `127.0.0.1:9101` assumes an existing worker configured with that metrics port; remove/change it when that listener is absent. Never copy ephemeral test ports. Do not scrape the same process endpoint twice under different jobs.
3. In the **Grafana process environment**, set `GF_PATHS_PROVISIONING` to `<absolute-repository-path>/observability/grafana/provisioning` and `CROSS_CHAIN_GRAFANA_DASHBOARDS_PATH` to `<absolute-repository-path>/observability/grafana/dashboards`. Replace the path placeholder with your real repository location; both directories already exist in the repository. Grafana expands the provider's environment value. These settings belong to Grafana, not the protocol workers. Start/restart your existing Grafana instance to load the datasource/provider. The default datasource URL assumes Prometheus is reachable from Grafana at the local address; adapt the deployment-local provisioning URL if its location differs. Authentication is managed by your deployment and is not included in these files.
4. Open **Cross-Chain → Cross-Chain Protocol Overview**. Alternatively, once the matching datasource UID exists, import the committed dashboard JSON using Grafana's ordinary import UI. No protocol API, chain-node endpoint or database is a Grafana datasource.

Use one deployment/source scope for this job set. Multiple API replicas in `cross-chain-api` must read the same scope/schema; the pending panels use `max`, not `sum`, to avoid duplicate backlog counts. Independently scoped deployments should use separate datasource/dashboard deployments rather than silently summing unrelated scopes.

Workers retain their existing lifecycle. A one-shot Relayer or Transaction Manager exits after its action, and its listener exits with it. Prometheus can miss such activity entirely or lack enough samples for `rate`. The dashboard does not create persistent exporters or turn one-shot workers into new daemons. Missing targets/insufficient samples produce **No data**, not a promise of zero activity or complete historical coverage. Counters reset on restart and have the documented post-COMMIT crash gaps.

### Reading the panels

The default global range is one hour with 15-second refresh. Throughput uses observed/finalized `rate` queries with Grafana's adaptive rate interval. Latency displays p50/p95/p99 from the existing production histogram buckets in seconds. No successful observations yields No data. The unchanged canonical metric name is `cross_chain_cross_chain_latency_seconds`; destination reconfirmations remain new observations under its existing semantics.

PBFT timing shows p50/p95 of local committed-round samples; local view-change and quorum-failure rates retain their per-Validator meaning. They do not prove protocol safety or count one incident globally across replicas. Validator readiness uses the production availability gauge only for targets whose latest scrape succeeded. A separate `up` panel shows reachability. Reachable/unready, unreachable and unknown are distinct; target loss changes no committee or quorum. These instant panels do not retain an old ready value from an earlier point in the selected range.

Relayer panels show candidate creation, retries by kind, bounded operational failures and replacements. RPC panels group failed requests by operation/class, including failures followed by successful failover. Source reorg counts use the selected-range increase of source occurrence REORGED transitions, separate from destination receipt orphaning; Prometheus increase is an extrapolated estimate and may be fractional. Failure/retry overview series remain independent because one incident can contribute to several signals. No invented safety threshold, combined failure total or retry percentage is shown.

### Pending-delivery observation

`cross_chain_pending_delivery_jobs` is the one additional metric: an unlabeled Gauge owned only by the existing API process. It counts current persisted READY jobs in the configured source scope whose source is FINALIZED and whose intent has no CONFIRMED/REVERTED terminal outcome. No intent, a signed/pending intent, preparation defer, stopped retries and reopened destination recovery all remain unresolved. Immutable READY job status alone never implies pending work or successful execution.

Historical transport-only submissions without a canonical terminal intent remain unresolved in this count: a submitted hash is insufficient confirmation. This can include retained historical work that current workers intentionally skip. The gauge is **unresolved backlog**, not immediately eligible work, expected future throughput or independently checked chain truth. A terminal observation discovered to be orphaned re-enters backlog when ordinary production reconciliation reopens the intent; collection never performs that reconciliation.

Each API scrape issues one read-only aggregate SELECT on existing tables, with a five-second client query timeout and the database's statement-level consistent snapshot. It takes no row/advisory/lease locks, starts no protocol transaction, advances no cursor and creates no nonce, signature, retry or receipt. The other fifteen metrics retain their original in-memory event semantics and perform no database collection. No other worker imports the pending collector, and no production entry imports Grafana files.

A failed or invalid count exports `NaN` (unknown) instead of retaining a stale value or inventing zero. The pending queries filter out nonnumeric values, producing the panel's Unknown/No data state. Other metric families remain available; query errors and connection details are not exposed. Pending/readiness queries also exclude unsuccessful scrape targets. Grafana, Prometheus or collector failure never pauses a worker or changes protocol authority. There is no new metrics table, migration, cache, alerting/tracing stack or container infrastructure.

### Verification

The only root verification entry remains `./scripts/verify.sh`, overwriting root `verification.log`. `[grafana operational dashboard]` validates JSON identity, all nine required views, datasource/provider YAML, source-resolved file paths, bounded metric/label references, histogram/rate semantics, secret-free artifacts and read-only collector behavior. PromQL syntax is parsed with the Prometheus project's fixed-version parser and pinned Lezer peers. The pinned YAML parser also prepares deployment-local observation configuration for the complete launcher. These tools use the existing Indexer development dependencies; prepare them before verification or local startup. No script installs them.

All prior tests remain. The existing real source/PBFT/fault/Relayer/Gateway scenarios produce the event metrics. Their actual exposition is checked against dashboard references, with Prometheus-generated `up` treated separately. The receipt pass observes real unresolved READY work, confirms its backlog decrease and compares repeated-scrape protocol/business snapshots. Explorer/API snapshots include the pending collector. The added clean-stack group also starts installed native Prometheus/Grafana, checks all ten scrape targets, the provisioned datasource/dashboard and real demo privacy surfaces. Static checks alone do not prove service readiness or visual browser rendering; screenshot/browser verification remains an operator check. Docker, plugin downloads and a browser automation dependency are not required.

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

Chain A hosts the generated Groth16 verifier, its credential adapter, `IdentityApplicationA`, and `SourceGateway` during complete verification. Chain B hosts `RemoteGatewayRegistry`, `ValidatorSetRegistry`, the PBFT certificate/Merkle/message-domain verifiers, the production `DestinationGateway` and an `ApplicationB` instance bound to that Gateway. Remote source trust maps domain `10011` to the actual Chain A SourceGateway. Fresh business messages target the deployed Gateway and Application B; retained historical transport fixtures can use other explicit Gateway/receiver addresses without being treated as production business execution. Isolated mock-caller and replay contracts provide separate boundary regressions.

## Prerequisites

Install these tools before using the repository:

- Bash;
- Foundry, including `forge`, `cast`, and `anvil`;
- Circom 2;
- Node.js 22 or later;
- npm;
- Python 3;
- PostgreSQL with a disposable or local project database, plus its existing `initdb`, `pg_ctl` and `pg_isready` server tools for the isolated restart scenario. Tools are resolved from the same installation through `PATH` or `pg_config --bindir`.

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

The component commands below support local development. The sole repository-wide verification gate, including deployment and real end-to-end execution, is `./scripts/verify.sh`.

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

### Solidity security testing

The Solidity security suite combines deterministic regressions with bounded Foundry fuzzing and stateful invariant testing. It uses production message encoding, transport decoding, Merkle inclusion, historical PBFT certificate verification, registries and `DestinationGateway.execute(bytes)`. No external fuzz framework, verifier mock or production test bypass is involved.

Generated inputs cover all message identity fields, full-width `uint256` domains/nonces/epochs, domain swaps, payload substitutions, canonical round-trips, truncation, trailing bytes, dirty ABI padding, malformed offsets/lengths and unsupported versions. Message round-trips use the production transport decoder and its canonical-message projection; `MessageCodec` itself exposes hashing, without introducing a second decoder. Encoding acceptance alone does not establish QC authority or destination eligibility.

Merkle fuzzing constructs valid trees of 1–16 members before mutating siblings, positions and path lengths; odd last-leaf duplication remains mandatory. Existing maximum-size regressions remain intact. Certificate fuzzing uses real local-EVM signatures with the fixed three-of-four quorum, distinct recovered identities and exact historical authority: epoch 7 contains V1–V4 and epoch 8 contains V2–V5. Duplicate/reordered signers, wrong signed context, removed/future members and unknown epochs cannot acquire authority. Different signature bytes recovering the same signer add no quorum weight; existing high-s and equivalent recovery-ID compatibility remain intact. Existing v1/v2/v3 fixed-vector regressions remain unchanged.

The stateful handler targets six independently authenticated messages, including both historical committees, plus a separately expiring message. Foundry chooses the action order, arguments and callers. Only the handler's eleven action selectors are targeted; registry administration, receiver configuration and fixture helpers are excluded. Actions cover valid execution, replay, invalid Merkle/QC, wrong source/destination, malformed evidence, expiry, same-message reentrancy, downstream rejection and alternate canonical wrappers. Time moves forward in bounded steps while the main positive pool remains fresh.

After each action, the model compares actual Gateway replay storage and per-message receiver observations: every consumed message must have exactly one successful authenticated callback, failed-only messages remain unused, and attacks cannot affect unrelated messages. Callback failure must roll replay state back so a later valid attempt can succeed. Same-message nested execution must fail without adding a second callback; the protocol continues to allow independently authenticated different-message nesting. Different valid QC subsets or job IDs can produce different canonical package bytes for the same message; replay remains keyed by the authenticated message ID.

The default configuration fixes seed `0x5eed`, **256 cases per fuzz property**, and **256 invariant runs at depth 500**, with `fail_on_revert = true` and selector metrics enabled. Expected production reverts are explicitly classified by the handler; unexpected rejection of valid evidence, acceptance of invalid evidence or a helper failure fails verification. Related invariants share one campaign to avoid repeating the same expensive sequences. Existing Foundry failure persistence is retained, and failure output includes the generated input or minimized call sequence where available. Counterexamples must be preserved and investigated, without skipping their seeds or deleting the failure corpus.

The complete verification script pins and logs these settings, runs the retained full Solidity suite and the new campaigns together once, and emits `FUZZ / STATEFUL INVARIANT TESTS PASSED` only after that command succeeds. The existing real two-chain, database, validator, relayer and ZK execution-time expiry checks remain mandatory. The fuzz tests themselves use only Foundry's local EVM, without RPC, database or proof generation per iteration.

Fuzzing exercises implementation-level domain separation, canonical encoding and verifier invariants over generated samples. It is not a formal proof of cryptographic collision resistance or protocol correctness. The twelve-signal credential statement, public `authorizationValidUntil`, private credential expiry and rejection of old eleven-signal proofs are unchanged.

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

The `[ZK security invariants]` gate includes the twelve-signal authorization statement, all public-input mutations and the exact execution-time expiry regression. Regeneration and fresh verifier/Application A deployment are part of the existing workflow; previous unused eleven-signal proofs cannot be reused. No security acceptance claim is made until this complete workflow succeeds with the regenerated artifacts.

Run the unified verification script from the repository root:

```bash
./scripts/verify.sh
```

The full-verification profile requires the exact decimal setting `FINALITY_BLOCK_DEPTH=2`. The script reads the effective value after sourcing the root `.env`; assignments in that file retain their existing precedence over the calling shell's environment. An unset value defaults to `2`; an explicitly empty or otherwise mismatched value is rejected without silent replacement. The header records the expected and effective depths, and profile validation exits nonzero before Indexer prerequisite checks, PostgreSQL connectivity/migrations, RPC access, chain startup, tests, proof generation, builds or deployments. Production runtime continues to validate other configured depths independently.

For an optional early-rejection check, temporarily set the effective `FINALITY_BLOCK_DEPTH` to `3`, run the same script, and confirm that `verification.log` stops at `full verification finality profile validation` before `[Indexer prerequisite verification]`. Restore `2` or leave the value unset, then run the full verification again. Each run overwrites the root log, so retain the final normal full run as the completion evidence. The integration fixture also keeps its own depth-`2` assertion when invoked directly.

The script uses strict error handling and verifies the following boundaries:

- **Environment and persistence:** the fixed full-verification finality profile, existing dependencies/server tools, PostgreSQL connectivity, ordered migrations, atomic rollback and recovery through fresh clients. No dependencies are installed and no database is created on the user's configured server; only the separately owned restart cluster is initialized for its fault scenario.
- **Credential authorization:** credential/state/nullifier models, Groth16 proof generation and Solidity verifier export, exact forwarding-intent binding, policy/expiry/revocation checks and rejected replay or altered public inputs.
- **Source contracts:** the full Solidity suite with strict build/lint gates, source-application admission, canonical message/domain/Gateway separation, precise routing/deadline errors, atomic nullifier/nonce behavior and real source events.
- **Indexing and source finality:** fixed-head scans, exact-log idempotency, eventless canonical blocks, worker restarts, offline catch-up, source-fork reconciliation and FINALIZED-only batch eligibility.
- **Batch and Merkle commitments:** bounded deterministic collection, immutable sealing and historical snapshots, concurrent retries/rollback, shared JavaScript/Solidity golden vectors and real sealed-batch inclusion proofs.
- **Consensus and historical authority:** independent validator source checks, four-member committees with three-voter quorum, PRE-PREPARE/PREPARE/COMMIT/QC, durable vote locks, crash/partition/heal and view recovery, five development identities across separate historical committees, and exact Chain B registry/QC verification.
- **Durable delivery:** strict COMMITTED-to-READY projection, independently verified packages, destination-scoped leased workers, preparation-defer fairness, persistent signing/nonce allocation, exact retries and same-nonce replacement, fair receipt/recovery scans, RPC failover and fresh-process crash reconciliation.
- **PostgreSQL service recovery:** a genuine owned-server stop after real destination acceptance, failed database-dependent progress, same-PGDATA WAL recovery, unchanged source/consensus/delivery/transaction history, valid new ownership and canonical reconciliation of the original signed transaction without a duplicate business execution.
- **Composed recovery:** one fresh message completes same-view consensus with one non-primary offline, survives the signing Relayer's actual pre-send crash, transfers through natural lease expiry and higher fencing, remains intact during all-path destination RPC unavailability, and finishes through the same polling B process after access returns. No new authorization, batch, transaction identity or signature is introduced to recover delivery.
- **Read-only lifecycle queries:** real loopback HTTP, exact full-width numeric encoding, explicit secret-free response/error schemas, actual historical validator votes/QCs, ordered attempt lineage, historical/current reorg distinctions and independent production-state comparisons. Read-only database snapshots and repeated-GET state checks enforce zero protocol mutations.
- **Destination execution:** actual Chain B registries/verifiers and production `DestinationGateway`/`ApplicationB` deployment, canonical transport-v1 `execute(bytes)` parity and limits, QC → Merkle → full-message/domain checks, message-ID replay, exact receiver authority, atomic rollback/retry and supplier-state/event readback.
- **Compatibility and negative boundaries:** unchanged legacy v1/v2 and current v3 certificates, historical signed transactions and opaque payloads, independent stateless/test-harness checks, precise invalid-evidence rejection and full real source-to-application execution through production Relayer/Transaction Manager APIs.

`DATABASE_URL` is required and should point to a database intended for local verification. The ordinary flow uses project-owned schemas and tables; it does not drop a database or reset the `public` schema. It does not install PostgreSQL, create a database on the configured user server, install npm packages, or generate an Indexer lockfile. The restart scenario separately creates one disposable verification-owned cluster and removes only that cluster after its processes have stopped. Its isolated connection URL is derived at runtime; no additional password or setup commands are required.

Full verification selects fresh loopback ports, starts its own chains through `scripts/start-chains.sh`, and stops only those processes on completion. It never reuses the interactive stack's chains, so verification-time snapshots, mining and time changes cannot affect a manually running demo.

The validator integration applies existing migrations explicitly, chooses temporary local ports, injects runtime development keys, and cleans up its own processes and proxies. It preserves the complete normal consensus flow, then runs four isolated fault instances with fresh source/validator namespaces and real Chain A reconstruction. Test-owned namespaces are reset only during scenario preparation. The eight mutable negative-fixture tables are transactionally recreated from current source definitions and copied with explicit column lists; leftover older schemas cannot retain obsolete QC columns or checks. Fixture rebuild failures roll back, and production source data and triggers are unchanged. Healing and restart recovery retain their durable state. No production validator store is reset.

All stdout and stderr are displayed in the terminal and written to:

```text
verification.log
```

Each run replaces the previous `verification.log`. A successful run ends with:

```text
VERIFICATION PASSED
Complete End-to-End Cross-Chain Execution
```

### Expected error output

Within `[PostgreSQL Restart Recovery]`, the marked database-outage window deliberately produces connection failures and may halt or exit validators that depend on the owned server. These diagnostics are expected only within that controlled window. The scenario must subsequently prove same-storage recovery, fresh-worker continuation and exact business-event counts; an unrelated error or missing recovery assertion still fails the root script.

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
AuthorizationExpired
EXPECTED FAILURE: closed PostgreSQL client rejected a new operation
```

These messages demonstrate that the contracts reject unauthorized source applications, invalid destinations and deadlines, the circuit rejects invalid witnesses, a proof cannot be reused with a tampered public input, the identity application enforces policy, freshness, context-bound replay protection, state-root authority, and revocation, and a closed PostgreSQL client cannot be treated as a successful operation. Each expected failure is followed by `Verified rejection`, `EXPECTED FAILURE`, or `Verified expected ... rejection`. Complete verification succeeds only when the script exits with code `0` and the log ends with `VERIFICATION PASSED`.

Groth16 verifier negative cases normally return `false` and are reported as `Verified expected on-chain rejection`. PBFT certificate negative cases require a precise custom-error revert and print `EXPECTED FAILURE: Chain B PBFT certificate ...`. Merkle inclusion negative cases require the exact error name and arguments and print `EXPECTED FAILURE: Chain B Merkle inclusion ...`; odd-duplication forgeries have explicit per-level output. A transport error, an unrelated revert or successful acceptance of invalid evidence fails complete verification. No deployment or verification step treats an unexpected failure as a pass.

Deployed source routing and deadline checks require the corresponding `IdentityApplicationA` error: `InvalidDeadline()`, `InvalidDestinationGateway()`, `InvalidDestinationDomain()` or `InvalidDestinationReceiver()`. The shared call assertion matches the decoded revert reason or revert-data selector, preserves the original diagnostic, and rejects unrelated reverts, RPC/CLI failures and unexpected success. Isolated synthetic fixtures exercise that assertion without RPC access; they do not replace the four real deployed calls. Each source case also compares the Gateway nonce, public nullifier used-state and commitment authorization status with the actual before-state, including a nullifier already consumed by a successful forward. These read-only simulations submit no transaction and persist no message event or destination business execution.

Message-domain negative cases also require exact error names and arguments, including propagated remote-registry errors, and print `EXPECTED FAILURE: Chain B message domain verification ...`. An expired message can retain valid QC and inclusion; only destination deadline policy rejects it. The log identifies these facts independently and does not relabel historical cryptographic evidence as invalid.

Replay negatives require the exact custom error in preflight, a real reverted Chain B transaction and unchanged replay state. They print `EXPECTED FAILURE: Chain B replay acceptance ...`. `MessageAlreadyExecuted` is an expected duplicate rejection; `MockExecutionFailed` belongs only to the callback fixture. Invalid upstream evidence and authentic expired messages remain unconsumed. A successful callback exposes the exact nested replay-error bytes, proving that same-message reentry fails after consumption and before any second accepted execution. Unexpected reverts, RPC failures or receipt statuses fail verification.

Application B negatives print `EXPECTED FAILURE: Application B ...` only after matching a specific custom error, observing a real reverted transaction and confirming unchanged business state and no grant event. `AlreadyVerifiedSupplier` identifies a redundant business transition; it does not represent Gateway replay rejection. The isolated test caller is explicitly a mock, and its correlation IDs provide no claim of source/QC authentication or replay consumption. Separate production Gateway negatives print EXPECTED FAILURE only after precise error matching, a real reverted receipt and replay/business-state checks.

## Repository Layout

```text
Cross-Chain/
├── .env.example
├── contracts/
│   ├── foundry.toml
│   ├── src/
│   │   ├── interfaces/
│   │   │   ├── ICrossChainReceiver.sol
│   │   │   ├── ICredentialVerifier.sol
│   │   │   ├── IGroth16Verifier.sol
│   │   │   ├── IPBFTCertificateVerifier.sol
│   │   │   ├── IRemoteGatewayRegistry.sol
│   │   │   ├── ISourceGateway.sol
│   │   │   └── IValidatorSetRegistry.sol
│   │   ├── libraries/
│   │   │   ├── DeliveryPackageCodec.sol
│   │   │   ├── DeliveryPolicy.sol
│   │   │   ├── MessageBatchCodec.sol
│   │   │   └── PBFTCertificateCodec.sol
│   │   ├── CredentialVerifier.sol
│   │   ├── ForwardAuthorizationCodec.sol
│   │   ├── ApplicationB.sol
│   │   ├── DestinationGateway.sol
│   │   ├── IdentityApplicationA.sol
│   │   ├── MerkleInclusionVerifier.sol
│   │   ├── MessageCodec.sol
│   │   ├── MessageDomainVerifier.sol
│   │   ├── MessageMerkle.sol
│   │   ├── MessageReplayProtection.sol
│   │   ├── PBFTCertificateVerifier.sol
│   │   ├── RemoteGatewayRegistry.sol
│   │   ├── SourceGateway.sol
│   │   └── ValidatorSetRegistry.sol
│   └── test/
│       ├── ApplicationB.t.sol
│       ├── CredentialVerifier.t.sol
│       ├── DestinationGateway.t.sol
│       ├── DestinationGatewayFuzz.t.sol
│       ├── DestinationGatewayInvariant.t.sol
│       ├── ForwardAuthorizationCodec.t.sol
│       ├── IdentityApplicationA.t.sol
│       ├── MerkleInclusionVerifier.t.sol
│       ├── MerkleInclusionVerifierFuzz.t.sol
│       ├── MessageEncodingFuzz.t.sol
│       ├── MessageDomainVerifier.t.sol
│       ├── MessageMerkle.t.sol
│       ├── MessageReplayProtection.t.sol
│       ├── PBFTCertificateVerifier.t.sol
│       ├── PBFTCertificateVerifierFuzz.t.sol
│       ├── RemoteGatewayRegistry.t.sol
│       ├── helpers/
│       │   ├── DeliveryCodecHarness.sol
│       │   ├── GatewayHandler.sol
│       │   ├── GatewaySecurityFixture.sol
│       │   └── ProtocolTestFixtures.sol
│       ├── mocks/
│       │   ├── AuthenticatedMessageReplayHarness.sol
│       │   ├── GatewayReceiverFixture.sol
│       │   ├── IReplayTestReceiver.sol
│       │   ├── MessageReplayProtectionHarness.sol
│       │   ├── MockCredentialVerifier.sol
│       │   ├── MockDestinationGateway.sol
│       │   ├── MockSourceApplication.sol
│       │   ├── MockSourceGateway.sol
│       │   ├── ReplayQueryHarness.sol
│       │   └── ReplayTestReceiver.sol
│       ├── SourceGateway.t.sol
│       └── ValidatorSetRegistry.t.sol
├── indexer/
│   ├── migrations/
│   │   ├── 001_chain_a_indexer.sql
│   │   ├── 002_idempotent_event_ingestion.sql
│   │   ├── 003_finality_watcher.sql
│   │   ├── 004_source_reorg_detection.sql
│   │   ├── 005_batch_lifecycle.sql
│   │   ├── 006_pbft_commit.sql
│   │   ├── 007_view_bound_qc.sql
│   │   ├── 008_validator_epochs.sql
│   │   ├── 009_delivery_queue.sql
│   │   ├── 010_single_relayer.sql
│   │   ├── 011_transaction_manager.sql
│   │   ├── 012_transaction_retry_replacement.sql
│   │   ├── 013_relayer_job_leases.sql
│   │   ├── 014_transaction_recovery.sql
│   │   ├── 015_rpc_response_errors.sql
│   │   ├── 016_relayer_preparation_defer.sql
│   │   ├── 017_transaction_scan_progress.sql
│   │   └── 018_destination_receipt_reconciliation.sql
│   ├── public/explorer/
│   │   ├── index.html
│   │   ├── app.js
│   │   ├── client.js
│   │   ├── list-view.js
│   │   ├── view-model.js
│   │   ├── render.js
│   │   └── styles.css
│   ├── scripts/
│   │   ├── build-forward-authorization-vectors.mjs
│   │   ├── generate-merkle-golden-vectors.mjs
│   │   ├── verify-message-domain.mjs
│   │   ├── generate-destination-transport-vector.mjs
│   │   ├── verify-application-b.mjs
│   │   └── verify-merkle-inclusion.mjs
│   ├── src/
│   │   ├── api/
│   │   │   ├── config.mjs
│   │   │   ├── errors.mjs
│   │   │   ├── main.mjs
│   │   │   ├── message-list.mjs
│   │   │   ├── message-query.mjs
│   │   │   ├── read-snapshot.mjs
│   │   │   ├── server.mjs
│   │   │   ├── source-authorization.mjs
│   │   │   ├── static-assets.mjs
│   │   │   └── validator-evidence.mjs
│   │   ├── batch-lifecycle-policy.mjs
│   │   ├── batch-lifecycle.mjs
│   │   ├── canonical-block.mjs
│   │   ├── canonical-message.mjs
│   │   ├── check-database.mjs
│   │   ├── config.mjs
│   │   ├── db.mjs
│   │   ├── delivery/
│   │   │   ├── config.mjs
│   │   │   ├── main.mjs
│   │   │   ├── package.mjs
│   │   │   ├── policy.mjs
│   │   │   ├── projector.mjs
│   │   │   └── repository.mjs
│   │   ├── finality-policy.mjs
│   │   ├── finality-watcher.mjs
│   │   ├── forward-authorization.mjs
│   │   ├── indexer.mjs
│   │   ├── main.mjs
│   │   ├── message-batch.mjs
│   │   ├── message-merkle.mjs
│   │   ├── metrics/
│   │   │   ├── http.mjs
│   │   │   ├── pending-delivery.mjs
│   │   │   └── registry.mjs
│   │   ├── migrate.mjs
│   │   ├── reorg-detector.mjs
│   │   ├── relayer/
│   │   │   ├── config.mjs
│   │   │   ├── encoding.mjs
│   │   │   ├── leases.mjs
│   │   │   ├── main.mjs
│   │   │   ├── repository.mjs
│   │   │   ├── service.mjs
│   │   │   ├── summary.mjs
│   │   │   └── submitter.mjs
│   │   ├── source-event-identity.mjs
│   │   ├── source-gateway-event.mjs
│   │   └── transaction-manager/
│   │       ├── config.mjs
│   │       ├── main.mjs
│   │       ├── nonce-policy.mjs
│   │       ├── receipts.mjs
│   │       ├── recovery.mjs
│   │       ├── repository.mjs
│   │       ├── retry-policy.mjs
│   │       ├── retry.mjs
│   │       ├── rpc-errors.mjs
│   │       ├── rpc-pool.mjs
│   │       ├── rpc.mjs
│   │       ├── service.mjs
│   │       └── transaction.mjs
│   ├── test/
│   │   ├── batch-lifecycle-policy.test.mjs
│   │   ├── batch-lifecycle.database.test.mjs
│   │   ├── canonical-block.test.mjs
│   │   ├── canonical-message.test.mjs
│   │   ├── config.test.mjs
│   │   ├── database.test.mjs
│   │   ├── delivery-config.test.mjs
│   │   ├── delivery-package.test.mjs
│   │   ├── delivery-policy.test.mjs
│   │   ├── delivery.database.test.mjs
│   │   ├── explorer.test.mjs
│   │   ├── explorer-http.test.mjs
│   │   ├── explorer-list.test.mjs
│   │   ├── message-list.test.mjs
│   │   ├── message-list.database.test.mjs
│   │   ├── message-query-config.test.mjs
│   │   ├── finality-policy.test.mjs
│   │   ├── finality-watcher.test.mjs
│   │   ├── forward-authorization.test.mjs
│   │   ├── helpers/
│   │   │   ├── delivery-fixtures.mjs
│   │   │   ├── delivery-integration.mjs
│   │   │   ├── destination-rpc-fixtures.mjs
│   │   │   ├── explorer-fixtures.mjs
│   │   │   ├── explorer-integration.mjs
│   │   │   ├── fail-relayer-rpc.mjs
│   │   │   ├── legacy-relayer.mjs
│   │   │   ├── lease-fixtures.mjs
│   │   │   ├── merkle-inclusion-contract.mjs
│   │   │   ├── message-domain-contract.mjs
│   │   │   ├── message-integrity.mjs
│   │   │   ├── message-integrity-runtime.mjs
│   │   │   ├── message-query-fixtures.mjs
│   │   │   ├── message-query-integration.mjs
│   │   │   ├── message-query-privacy.mjs
│   │   │   ├── multi-relayer-integration.mjs
│   │   │   ├── read-batch-lifecycle.mjs
│   │   │   ├── read-canonical-message.mjs
│   │   │   ├── read-delivery.mjs
│   │   │   ├── relayer-fixtures.mjs
│   │   │   ├── relayer-integration.mjs
│   │   │   ├── relayer-polling.mjs
│   │   │   ├── relayer-process.mjs
│   │   │   ├── rpc-failover-integration.mjs
│   │   │   ├── transaction-database-fixtures.mjs
│   │   │   ├── transaction-crash-integration.mjs
│   │   │   ├── transaction-fixtures.mjs
│   │   │   └── transaction-retry-integration.mjs
│   │   ├── indexer.test.mjs
│   │   ├── integration.test.mjs
│   │   ├── message-batch.test.mjs
│   │   ├── message-integrity-invariants.test.mjs
│   │   ├── message-merkle.test.mjs
│   │   ├── message-merkle-golden.test.mjs
│   │   ├── message-query.test.mjs
│   │   ├── message-query.database.test.mjs
│   │   ├── metrics.test.mjs
│   │   ├── metrics.database.test.mjs
│   │   ├── grafana-dashboard.test.mjs
│   │   ├── pending-delivery.test.mjs
│   │   ├── pending-delivery.database.test.mjs
│   │   ├── reorg-detector.test.mjs
│   │   ├── relayer-config.test.mjs
│   │   ├── relayer-encoding.test.mjs
│   │   ├── relayer-leases.database.test.mjs
│   │   ├── relayer-leases.test.mjs
│   │   ├── relayer-polling.test.mjs
│   │   ├── relayer-service.test.mjs
│   │   ├── relayer-summary.test.mjs
│   │   ├── relayer.database.test.mjs
│   │   ├── rpc-failover.database.test.mjs
│   │   ├── rpc-pool.test.mjs
│   │   ├── source-event-identity.test.mjs
│   │   ├── transaction-manager.database.test.mjs
│   │   ├── transaction-manager.test.mjs
│   │   ├── transaction-retry.database.test.mjs
│   │   ├── transaction-retry.test.mjs
│   │   ├── transaction-recovery.database.test.mjs
│   │   └── transaction-recovery.test.mjs
│   ├── package.json
│   └── package-lock.json
├── observability/
│   ├── grafana/
│   │   ├── dashboards/cross-chain-protocol.json
│   │   └── provisioning/
│   │       ├── dashboards/cross-chain.yaml
│   │       └── datasources/prometheus.yaml
│   └── prometheus/prometheus.example.yml
├── scripts/
│   ├── build-canonical-message-vector.mjs
│   ├── build-validator-set-vector.mjs
│   ├── deploy-application-b-test-fixture.sh
│   ├── deploy-destination-gateway.sh
│   ├── deploy-merkle-inclusion-verifier.sh
│   ├── deploy-message-domain-verifier.sh
│   ├── deploy-pbft-certificate-verifier.sh
│   ├── deploy-remote-gateway-registry.sh
│   ├── deploy-replay-test-harness.sh
│   ├── deploy-validator-set-registry.sh
│   ├── deploy-verifier.sh
│   ├── lib/
│   │   └── expect-revert.sh
│   ├── start-chains.sh
│   ├── start.sh
│   └── verify.sh
├── test-vectors/
│   ├── application-b-commands.json
│   ├── canonical-messages.json
│   ├── delivery-policy.json
│   ├── destination-transport.json
│   ├── forward-authorizations.json
│   ├── merkle-golden-vectors.json
│   ├── nullifiers.json
│   ├── legacy-credential-proof.json
│   ├── pbft-certificates.json
│   └── validator-sets.json
├── validator/
│   ├── .env.example
│   ├── migrations/
│   │   ├── 001_validator_foundation.sql
│   │   ├── 002_pre_prepare.sql
│   │   ├── 003_prepare.sql
│   │   ├── 004_commit_and_qc.sql
│   │   ├── 005_view_change.sql
│   │   ├── 006_view_recovery.sql
│   │   └── 007_validator_epochs.sql
│   ├── scripts/
│   │   ├── generate-pbft-certificate-vectors.mjs
│   │   └── verify-pbft-certificates.mjs
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
│   │   ├── validator-sets.mjs
│   │   ├── view-timeout.mjs
│   │   └── consensus-runtime.mjs
│   ├── test/
│   │   ├── validator-set-golden.test.mjs
│   │   ├── validator-sets.test.mjs
│   │   ├── pbft-certificate-golden.test.mjs
│   │   ├── postgres-cluster.test.mjs
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
│   │       ├── destination-execution-scenarios.mjs
│   │       ├── fault-transport.mjs
│   │       ├── fault-scenarios.mjs
│   │       ├── fixtures.mjs
│   │       ├── message-domain-scenarios.mjs
│   │       ├── message-replay-scenarios.mjs
│   │       ├── multi-component-recovery-scenario.mjs
│   │       ├── four-process.mjs
│   │       ├── pbft-certificate.mjs
│   │       ├── pbft-certificate-contract.mjs
│   │       ├── process-cluster.mjs
│   │       ├── postgres-cluster.mjs
│   │       ├── postgres-restart-scenarios.mjs
│   │       ├── rotation-scenarios.mjs
│   │       ├── validator-set-registry.mjs
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
│   │   ├── verify-circuit.sh
│   │   ├── verify-rejection.mjs
│   │   └── verify-security-invariants.mjs
│   ├── test/
│   │   └── rejection.test.mjs
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
- The circuit proves `currentTimestamp < authorizationValidUntil <= private expiry`, and Application A separately enforces execution strictly before the public authorization deadline plus its independent proof-freshness policy. `authorizationValidUntil` reveals a bound on expiry, not a separate exact-expiry field. Stored supplier status still does not automatically expire; standalone status provides no later forwarding permission.
- Revocation uses membership in a deterministic active-credential root and an explicit Chain A root authority. The authority is responsible for publishing a root and revoked-commitment list that describe the same transition.
- Nullifiers prevent repeated authorization for the same credential, application, epoch, and action. They do not hide the public credential commitment, prevent correlation through other public signals, or provide global replay protection across distinct contexts.
- `SourceGateway` admits only explicitly authorized application contracts and records the direct application caller as `sourceSender`.
- Source-application authorization is administered by one immutable address. The local deployment uses an explicit development account; production use requires an appropriate governance and key-management design.
- Registry authorization does not authenticate the EOA calling an authorized application. Each application remains responsible for its own caller and business-policy checks.
- Gateway revocation affects future message creation only. It does not invalidate previously emitted messages or alter historical message IDs.
- `IdentityApplicationA` requires an exact intent-bound credential proof and consumes its context nullifier atomically with every protected `SourceGateway` call. Standalone supplier verification provides no later forwarding capability.
- The Indexer validates and persists the resulting public source event. It does not inspect private credential witnesses or independently rerun the Groth16 proof.
- `OBSERVED` records the current Chain A view at ingestion time. `FINALIZED` means only that the configured source-block depth was reached at the recorded watcher head; it provides no validator-approval or delivery guarantee.
- Canonical block hashes and parent hashes are tracked for every scanned block, including blocks without source events. The Indexer and Finality Watcher reconcile this history before their respective work.
- An unfinalized orphan is retained as terminal `REORGED` data and is never batch eligible. A replacement occurrence has its own block-hash identity and lifecycle.
- A fork that reaches a `FINALIZED` occurrence fails closed and requires operator investigation; configured block depth therefore remains a policy choice with real reorganization risk.
- Transactional block, message, cursor, reorganization, and finality writes support single-node worker restart recovery after graceful or abrupt process loss. Database-enforced source-event uniqueness makes exact-log retries and rescans idempotent without overwriting first-observation data or lifecycle status.
- PostgreSQL connection errors fail database-dependent work. Recovery requires fresh connections or normal worker restarts against the same durable database; the owned-server restart verification preserves operational and PBFT state and reconciles an ambiguous accepted destination transaction. Permanent data loss, PostgreSQL availability management, replication and automatic failover remain separate concerns.
- The runtime supports one active Indexer and one active Finality Watcher concurrently. Each watcher pass evaluates a fixed head snapshot, preserves canonical Indexer progress beyond it, and leaves newer occurrences for a later pass. Multi-instance coordination, distributed locking, active-active failover, and zero-downtime orchestration remain unimplemented.
- The current message binds its protocol type, source domain, source gateway, source sender, destination domain, destination gateway, destination receiver, nonce, payload hash, and deadline.
- A committed destination gateway is caller-selected. `SourceGateway` does not validate remote deployment, domain ownership, or trust. Chain B's `RemoteGatewayRegistry` supplies current administrator-configured source-domain/SourceGateway authority to `MessageDomainVerifier`; the production Gateway supplies address(this) as the independent expected destination target.
- The batcher consumes only the existing `FINALIZED` eligibility boundary. `REORGED` occurrences remain terminal and are excluded from every batch.
- A deterministic batch ID binds its source scope, epoch, and ordered canonical message IDs. The Merkle Message Root and proofs additionally bind message membership to canonical batch positions through distinct leaf and internal-node hash domains.
- Off-chain inclusion verification requires the caller's expected batch and root. A valid proof establishes membership within that commitment and supplies no consensus result, quorum certificate, Chain B authorization, or cross-chain acceptance.
- Batch and Merkle computation preserve source lifecycle state and use only existing public message data and provenance. They introduce no private credential attributes.
- PostgreSQL remains operational persistence. Batch and Merkle construction do not independently establish canonical-chain consensus or validator authority.
- Persistent batch assignment, sealing, and epoch advancement preserve source lifecycle state. Validator-local `PREPARED` permits COMMIT voting. Only an independently verified QC authorizes the atomic `CONSENSUS_PENDING → COMMITTED` transition.
- The Solidity Merkle primitive requires independently trusted expected context, including member count. Its stateless facade derives count from the full unique ordered ID list and recomputes the expected batch commitment; the exact root/context must be authenticated separately by the QC verifier. Neither component replaces canonical message-field validation or authenticates a relayer. Shared golden vectors lock compatibility and grant no destination permissions.
- Four independent validator processes may share one source RPC provider; independent checking does not eliminate that provider's trust assumptions or produce a cryptographic source-finality proof.
- Validator-local observations are separate from source persistence and are never consensus votes. One validator or four local `VALID` results cannot commit a batch.
- Peer handshake signatures prove configured identity control in a distinct domain and cannot serve as PREPARE/COMMIT signatures. Source mismatches fail closed and do not trigger source DB repairs.
- Signed PRE-PREPARE proposals use a separate canonical domain and authenticate the deterministic primary, but signature validity cannot replace independent source validation. One accepted digest per local identity/epoch/view is durable across restart; accepted proposals do not authorize `COMMITTED`.
- Signed PREPARE votes use another canonical domain, bind the exact accepted proposal and voter identity, and count once per configured validator. Three matching voters produce durable local `PREPARED` state; duplicates and conflicts cannot add quorum weight or replace prior votes.
- Current v3 COMMIT votes bind the exact accepted proposal, pinned validator epoch and historical committee digest. Membership is resolved from trusted immutable history; legacy v1/v2 retain their original initial/static authority. One or two voters cannot commit; three distinct valid COMMIT signatures are required. QC submitters need no trusted identity, and persisted evidence is cryptographically reverified on committed reads.
- The failure model retains progress with one unavailable non-primary and an honest available primary. A single conflicting backup cannot supply a conflicting QC. A 2|2 partition preserves safety and pauses progress until explicit retries restore delivery; connectivity changes do not reset vote locks or select a new primary.
- Primary failure or withholding triggers progress timeouts; replacement still requires three valid VIEW_CHANGE votes and an available deterministic new primary. Process availability is not commit authority. PostgreSQL never substitutes for independent source and signature verification.
- READY jobs contain verified immutable evidence and provide no destination permission or execution guarantee. Delivery projectors coordinate per batch through database locks and uniqueness; this does not add multi-instance Indexer/Finality Watcher coordination or exactly-once destination consumption.
- Relayer A/B delegate verified zero-value transport to the Persistent Transaction Manager. Their shared exclusive EOA is an untrusted transport account with no validator or destination permission. Exact signed bytes are durable before broadcast; bounded retry reuses them, and replacement only appends a higher-fee candidate at the same nonce. Any historical candidate may win. A successful production Gateway-targeted receipt commits atomic application execution; historical EOA transport receipts provide no business-execution claim, and neither provides permanent destination finality.
- Destination RPC failover uses ordered, fingerprint-checked access paths. Provider URLs never identify a transaction or grant destination authority. Conservative cross-provider checks do not provide Byzantine RPC consensus.
- Chain B QC verification requires trusted expected batch context. Legacy v1/v2 use the initial immutable authority with an explicitly expected legacy version; v3 uses its exact signed/expected validator epoch. A QC cannot choose destination eligibility for itself, and high-s compatibility cannot add quorum weight for a duplicated recovered identity.
- Full-message verification must use the same ID authenticated by QC/Merkle composition, not an unrelated self-consistent ID. Unsupported versions and wrong current source/destination context fail independently of canonical hash consistency.
- Source and destination require time strictly before deadline. Historical source validity, QC agreement and inclusion do not override destination expiry or rewrite source/READY evidence. Stateless domain checks can repeat without consuming IDs. The separate internal replay guard records only successful acceptance; failures roll back and consumed IDs are never cleared by expiry or policy changes.
- Application B trusts exactly one configured Gateway address. It stores business supplier state, not credential-subject ownership or message replay. Test Gateway callers deliberately omit protocol authorization; they must not be used as production authority.
- DestinationGateway enforces QC/inclusion/full-message policy, message-ID replay protection and atomic receiver dispatch. Relayers and database state cannot bypass those checks. Successful consumption is scoped to one Gateway deployment's canonical storage; it does not guarantee eventual delivery, arbitrary receiver success or permanent destination finality.
- Remaining limitations include decentralized validator governance, a cryptographic source-finality proof and multi-worker source orchestration. Destination reorg recovery depends on periodic receipt observation and the configured RPC trust model; it cannot promise irreversible finality or delivery after policy expiry, retry exhaustion or unexplained nonce consumption. RPC failover and independent validator checks do not establish Byzantine RPC-provider consensus or a production cross-chain security model.
- Groth16 proofs are verified on Chain A through IdentityApplicationA and its verifier adapter. The current protected source path binds the exact public destination intent; preserved historical evidence is not retroactively claimed to use that flow. DestinationGateway authenticates public messages through PBFT/Merkle/domain checks and invokes the receiver. Private witnesses remain with the prover, and credential proofs are not forwarded to Chain B.

Before using real assets, permissions, or production networks, the protocol requires a production trusted setup or verifiable ceremony, issuer authentication, production credential-state publication and governance, operator/signer key management, production operation and monitoring of destination reorganization recovery, and independent security review of the deployed Gateway, applications and trust configuration. The implemented local end-to-end path is a development prototype, not evidence of a production deployment.
