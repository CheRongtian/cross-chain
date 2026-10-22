# PBFT Validators

[Project overview and public commands](../README.md)

Each validator is an independent Node.js process with its own key, endpoint,
PostgreSQL namespace, durable observations, and vote locks.
It independently checks Chain A evidence before participating in batch consensus.

PBFT certifies one batch/root under configured historical committee authority.
It does not create source events, authenticate credential issuers, or execute
a destination receiver.

## Contents

- [Identity and independent state](#identity-and-independent-state)
- [Source validation](#source-validation)
- [Committee history and contexts](#committee-history-and-contexts)
- [Signed messages and domains](#signed-messages-and-domains)
- [Normal consensus](#normal-consensus)
- [View change and safe recovery](#view-change-and-safe-recovery)
- [Crash and final-certificate recovery](#crash-and-final-certificate-recovery)
- [HTTP interfaces](#http-interfaces)
- [Configuration](#configuration)
- [Verification and fault model](#verification-and-fault-model)
- [Limitations](#limitations)

## Identity and independent state

[identity.mjs](src/identity.mjs) derives a public Ethereum identity from the
process's configured private key.
Private keys remain in ignored local configuration or process environments;
they are not stored as committee data or copied into vote tables.

Each validator binds its local database/schema to its identity.
Restart with another key cannot adopt that store.
Two validators do not share writable local consensus state.

The source operational schema and a validator's local schema must be distinct.
They may use the same PostgreSQL server.
Source observations, accepted proposals, issued intents, votes, prepared evidence,
view targets, and final certificates survive process loss through their own records.

### Handshake

[handshake.mjs](src/handshake.mjs) uses a fresh challenge and this typed digest:

```text
ValidatorIdentityHandshake(uint256 sourceDomain,address sourceGateway,address validator,bytes32 challenge)
```

The identity signs its raw 32-byte ABI/Keccak digest through EIP-191.
The caller verifies the recovered expected peer, challenge, source context,
identity protocol version `1`, and advertised finality configuration.

Endpoint discovery is operator configuration, not committee selection.
A valid handshake establishes key control for that endpoint; membership must
still be checked against the exact committee serving the batch.
Self/unknown peers and duplicate endpoint identities are rejected.

Identity/handshake version `1` is independent of current PBFT evidence version `3`.

## Source validation

[source-validation.mjs](src/source-validation.mjs) reconstructs candidates from
the strict source lifecycle reader.
It accepts source-validation candidates in SEALED or CONSENSUS_PENDING state;
new voting requires the pending state and immutable consensus binding.

A VALID local observation is not PREPARE, COMMIT, QC, or global commitment.

For each pass, a validator:

1. checks source chain ID and Gateway bytecode independently;
2. captures one Chain A head snapshot;
3. reconstructs batch membership, canonical order, batch ID, root, and positions;
4. fetches each member's canonical block and successful transaction receipt;
5. finds the exact raw receipt log and decodes its actual topics/data;
6. checks provenance, payload, canonical fields, ID, and configured source depth;
7. rebuilds the batch/root from those independent events;
8. rereads the captured head height to ensure its anchor hash did not change.

A persisted FINALIZED string alone is insufficient.
RPC calls use that validator's own client, not another node's observation.
Within a pass, repeated block/receipt reads may be reused for members sharing them.

Source depth uses successor semantics:
`head >= sourceBlock + FINALITY_BLOCK_DEPTH`.
The later anchor recheck does not advance the captured head.

Wrong chain/Gateway, insufficient depth, a source fork, a raw-log mutation,
REORGED/nonfinalized membership, and mismatched root/context fail closed.
Database or RPC failure is not converted into a successful observation.

A validator does not repair source history, advance its cursor, or change finality.
Its only authorized source write path is the dedicated verified-QC commit transition.

## Committee history and contexts

The active committee has exactly four members, fault assumption `f = 1`,
and quorum `3`.
Members are canonicalized by unsigned Ethereum address order.

| Context | Meaning |
| --- | --- |
| Application policy epoch | Chain A credential authorization context; outside PBFT |
| Batch epoch | Deterministic source-batch sequence |
| Validator epoch | Exact historical committee authority |
| PBFT view | Primary attempt inside one batch consensus instance |

A committee can serve many batch epochs.
Primary selection is:

```text
canonicalValidators[(batchEpoch + view) mod 4]
```

The sum uses full-width mathematical arithmetic before modulo.
Committee size never becomes five because history contains five identities.

### Historical activation

Trusted history contains validator epoch, activation batch epoch, four distinct
nonzero addresses, and the derived committee digest.
Input member ordering does not change the canonical result.
Validator epochs are consecutive and activation boundaries strictly increase.

The resolver selects the greatest activation boundary not above the batch epoch.
The public example is:

| Validator epoch | Members |
| --- | --- |
| 7 | V1, V2, V3, V4 |
| 8 | V2, V3, V4, V5 |

[config/validator-set-history.example.json](config/validator-set-history.example.json)
is an example, not automatic authority for another deployment.
V1 remains historical after rotation; V5 gains no authority over epoch 7.

Local history is append-only.
Restart with omitted/conflicting stored history fails closed.
An appended history entry cannot rewrite an already-started instance's binding.

The source lifecycle pins protocol version, validator epoch, and committee digest
before new consensus. Each node compares that binding with its own trusted
activation schedule and persists its local immutable binding.

A fresh V5 store starts with its own evidence.
It does not copy V1 votes or fabricate historical participation.

### Historical evidence

Current PBFT messages use version `3`, binding validator epoch and committee digest.
All views of one instance preserve that authority.
Rotation changes neither canonical messages, batch IDs, membership, roots, nor paths.

Historical v1/v2 type strings, ABI bytes, digests, and signatures are unchanged.
They contain no signed validator epoch and resolve the explicitly configured
initial committee. Version 1 has no signed view; version 2 is view-bound.

Existing v2 in-flight contexts keep their original encoding and committee.
There is no relabeling of legacy signatures as v3 and no latest-committee fallback.

The Chain B [ValidatorSetRegistry](../contracts/README.md#historical-validator-authority)
stores exact historical committee records.
Off-chain activation boundaries remain operator history, not on-chain scheduling.
A QC does not prove decentralized governance selected its committee.

## Signed messages and domains

[protocol.mjs](src/protocol.mjs) and phase codecs own versioned standard
ABI/Keccak digest construction.
Signatures use EIP-191 personal-sign over the raw 32-byte digest.

Current shared context includes protocol version, source domain/Gateway, batch
epoch, view, batch ID/root, validator epoch, and committee digest.
Phase-specific fields bind proposal, sender, or recovery evidence.

| Evidence | Domain / owning codec |
| --- | --- |
| PRE-PREPARE | PBFTPrePrepare / [pre-prepare.mjs](src/pre-prepare.mjs) |
| PREPARE | PBFTPrepare / [prepare.mjs](src/prepare.mjs) |
| COMMIT | PBFTCommit / [commit.mjs](src/commit.mjs) |
| QC | PBFTQuorumCertificate / [quorum-certificate.mjs](src/quorum-certificate.mjs) |
| VIEW_CHANGE | PBFTViewChange / [view-change.mjs](src/view-change.mjs) |
| NEW_VIEW | PBFTNewView / [view-change.mjs](src/view-change.mjs) |

The type string is hashed as the domain separator, then ABI-encoded with its
ordered fields. JSON key ordering is not a signing algorithm.

PRE-PREPARE binds the deterministic primary.
PREPARE and COMMIT bind the accepted proposal digest and voter identity.
COMMIT and QC retain their historical committee-digest positions;
v3 appends validator epoch without rewriting old formats.

The canonical envelope additionally carries its digest and signature.
Normalizers require exact fields, widths, addresses, and hex bytes.
Authentication independently recomputes digests, recovers signers, and resolves
the serving historical committee.

Distinct signatures by one identity remain one vote.
Canonical certificate evidence is sorted by voter identity.
One or two distinct signers cannot manufacture quorum.

[PBFT certificate vectors](../test-vectors/pbft-certificates.json) freeze v1/v2/v3
digests, signatures, signers, and transport bytes.
[Validator-set vectors](../test-vectors/validator-sets.json) freeze committee
ordering and the independent version-1 committee codec.

## Normal consensus

```text
CONSENSUS_PENDING
  -> accepted PRE-PREPARE
  -> three distinct PREPARE votes -> local PREPARED
  -> three distinct COMMIT votes -> local QC
  -> independently verified QC submission -> source COMMITTED
```

### PRE-PREPARE

Only the deterministic primary may propose the independently validated pending
batch/root for that context.
The primary persists its signed intent before broadcasting.

Receivers authenticate the primary, exact context, source candidate, and digest,
then atomically persist one accepted proposal.
A conflicting proposal cannot overwrite the lock.
A duplicate is idempotent and does not invent new progress.

A partial broadcast or restart rebroadcasts the saved envelope exactly.
The primary signature alone supplies no commitment authority.

### PREPARE

A validator may cast PREPARE only for its durable accepted proposal.
It persists its self-vote and double-vote lock before network transmission.

Receivers require the exact accepted proposal and authenticated serving member.
Votes arriving without the prerequisite proposal are not silently adopted.
Duplicates add no weight; conflicts cannot remove matching honest evidence.

At three distinct matching voters, the local transaction records PREPARED
with immutable prepared evidence.
A fourth matching vote may be retained without rewriting the first quorum record.

State readers coordinate with metadata locks so votes and PREPARED evidence
describe one consistent snapshot.

### COMMIT and QC

Casting COMMIT requires durable local PREPARED.
The node persists its self-vote/lock before broadcasting.
A validly signed but wrong-context COMMIT is still rejected.

Three matching distinct COMMITs create a QC.
A complete certificate contains the batch/root/proposal/committee context,
QC digest, and three or four canonical signed COMMIT entries.
All supplied entries are verified.

The source commit path independently verifies the QC against immutable batch
and trusted history, then saves evidence and COMMITTED status atomically.
The first final certificate is retained.
Equivalent signer subsets or later-view certificates cannot replace it.

Local vote quorum is not a database status bypass.
Source rows, history, member order, proofs, and the next batch remain unchanged.

## View change and safe recovery

```text
progress timeout -> VIEW_CHANGE quorum -> NEW_VIEW
                 -> safe proposal -> PREPARE/COMMIT in certified view
```

A timeout alone cannot activate a view or make a backup primary.

### Durable timeout state

The base `PBFT_VIEW_TIMEOUT_MS` defaults to 30000 and is bounded by 2147483647.
The effective window is capped exponential backoff from the durable view.
Active rounds use current view; waiting recovery uses pending target view.

Current active view and pending target view are separate fields.
Timeout pauses old-view voting and persists one signed VIEW_CHANGE for a target.
Failure to publish NEW_VIEW leaves that target inactive.
After another full timeout, a higher target may be persisted.

Retries/restarts reuse each immutable intent.
Duplicate delivery does not extend deadlines.
Locked timeout updates compare the original view/target/progress revision;
a superseded timer cannot erase new progress or sign for obsolete state.

### VIEW_CHANGE evidence

The signed message binds its independent phase domain, source/batch context,
target view, sender, pinned authority, accepted proposal digest, and prepared
certificate digest.

When present it carries the complete accepted signed proposal.
PREPARED state carries the highest durable Prepared Certificate:
that proposal plus three or four matching signed PREPAREs.
This certificate is not a final COMMIT QC.

### NEW_VIEW safety

Only the deterministic primary for the target may establish NEW_VIEW.
It carries three or four distinct authenticated VIEW_CHANGE messages and
their canonical digest array.

Every backup verifies nested evidence and independently selects the value at
the highest prepared view.
Conflicting highest-view evidence fails closed.
Without prepared evidence, selection requires the independently validated
canonical pending batch.

The replacement primary rechecks its immutable candidate against a fresh
fixed Chain A head.
That head need not equal an older source observation.

NEW_VIEW is persisted before broadcast.
Acceptance atomically records evidence and activates the quorum-certified view.
Views never decrease; an already higher pending target is preserved.

The scheduler retransmits durable NEW_VIEW even after its sender starts waiting
for another target, so lagging peers can recover.
It rereads state after replay/establishment and drives active replacement-view
proposal/PREPARE/COMMIT work without waiting through another timeout.

View-zero initiation retains explicit propose/cast interfaces.
There is no force-primary or administrative set-view endpoint.

## Crash and final-certificate recovery

Before opening HTTP/readiness, startup performs pending discovery, independent
source validation, and local epoch registration.
It preserves existing views and safety evidence without fabricating startup votes.

Discovery is separate from scheduling.
A storage/integrity error prevents readiness rather than opening a partially
initialized validator.

Restart recovers accepted proposals, issued envelopes, votes, prepared evidence,
commit locks, view targets, and progress revisions.
Exact saved bytes are retransmitted where required.

Old-view votes cannot count in a new view's quorum.
Prepared history and local COMMIT locks constrain later safe-value selection.
A valid old-view QC still finalizes its batch and ends timeout processing.

If another validator commits during discovery, the normal strict lifecycle reader
verifies that final QC and finalizes the local instance.
This does not fabricate an accepted NEW_VIEW or force local view to equal the
certificate's signing view.

A returning backup can verify a global QC without claiming votes it never cast.
A missing vote remains missing evidence.
Corrupt or incomplete certificates fail closed.

## HTTP interfaces

The server accepts bounded JSON bodies up to 64 KiB and rejects extra/malformed
fields. These are local protocol/diagnostic interfaces, not extra user launch steps.

| Route | Purpose |
| --- | --- |
| GET /health | Local alive/readiness and public identity |
| GET /identity | Public source/identity configuration |
| POST /handshake, /connect-peer | Challenge authentication |
| POST /validate-batch | Independent source validation |
| GET /observations | Durable local validation observations |
| POST /pbft/primary | Compute the primary for epoch/view |
| POST /pbft/propose, /pbft/pre-prepare | Issue or receive a proposal |
| POST /pbft/prepare/cast, /pbft/prepare | Persist/cast or receive PREPARE |
| POST /pbft/commit/cast, /pbft/commit | Persist/cast or receive COMMIT |
| POST /pbft/qc | Recover a local certificate |
| POST /pbft/qc/verify | Read-only portable QC verification |
| POST /pbft/qc/submit | Verified source commit transition |
| POST /pbft/view-change, /pbft/new-view | Authenticated recovery evidence |
| GET /pbft/pre-prepares, /pbft/prepares, /pbft/commits, /pbft/views | Local evidence |
| GET /validator-sets | Configured public history |
| GET /metrics | Process-local operational metrics |

A successful read-only QC verification does not prove source execution or create
a vote. COMMITTED lifecycle reads separately authenticate their source snapshot.

Protocol responses distinguish acceptance/rejection from internal failures.
Keys and database connection material are excluded from public responses.
Readiness and metrics are observational; neither can grant voting weight.

## Configuration

[.env.example](.env.example) describes one process.
Actual secrets belong only in ignored local configuration/process environments.

| Setting | Responsibility |
| --- | --- |
| VALIDATOR_PRIVATE_KEY | This process's key only |
| VALIDATOR_LISTEN_HOST / VALIDATOR_LISTEN_PORT | Local endpoint matching its peer directory entry |
| VALIDATOR_DATABASE_URL / VALIDATOR_DB_SCHEMA | Identity-bound local state |
| SOURCE_DATABASE_URL / SOURCE_DB_SCHEMA | Existing source operational state |
| CHAIN_A_RPC_URL / CHAIN_A_DOMAIN | Independent source chain access/identity |
| SOURCE_GATEWAY_ADDRESS | Expected emitting Gateway |
| FINALITY_BLOCK_DEPTH | Source successor-depth policy |
| VALIDATOR_PEERS | Public JSON directory of unique address/url entries, including self/history |
| VALIDATOR_SET_HISTORY or VALIDATOR_SET_HISTORY_FILE | Exactly one trusted public history source |
| PBFT_VIEW_TIMEOUT_MS | Base timeout; default 30000 |

The endpoint directory must contain every historical member, not only the current
committee. Each process still holds only its own key.
Unknown identities, overlapping stores, conflicting history, and mismatched
self/listen endpoints fail early.

The standard local launcher supplies actual development configuration.
Full verification loads root `.env` and creates isolated namespaces;
`VALIDATOR_VERIFICATION_DATABASE_URL` can select a separately prepared database.
No permanent additional key/password configuration is required for those fixtures.

Package entries `start`, `migrate`, `test`, and `test:database` are maintained
for subsystem diagnosis. They are not additional normal launch commands.

## Verification and fault model

Run the complete repository workflow from its root:

```bash
./scripts/verify.sh
```

[package.json](package.json) / [package-lock.json](package-lock.json) require
Node.js 22+ and pin existing pg/viem dependencies.
The script does not install an environment.

Unit/database coverage includes signed context mutation, source checks,
identity isolation, immutable locks, concurrent duplicate votes, quorum thresholds,
consistent reads, partial broadcasts, fresh-client recovery, view targets,
historical authority, and equivalent-certificate retention.

Real processes exercise:

- one unavailable backup, with exactly the three live members signing;
- a conflicting Byzantine backup while three honest members certify one root;
- a bidirectional 2|2 partition with no QC until connectivity returns;
- primary loss before proposal and at proposal/PREPARE/PREPARED/COMMIT boundaries;
- persisted view-change recovery, delayed NEW_VIEW, and an unavailable candidate;
- old-view replay exclusion and highest-prepared safe-value checks;
- historical epoch-7/8 rotation with five independent identities/stores;
- composed storage, Relayer, RPC, and destination recovery.

Test-only transport gates block directed delivery without changing protocol bytes.
There is no production fault mode or fault field in digest inputs.

Progress checks use durable distinct signer evidence and the final verified QC,
not delivery acknowledgements or a chosen wall-clock sleep.
Ownership-aware cleanup preserves RPC access until validators finish shutdown.

## Limitations

Safety/liveness claims assume the configured four-member committee and explicit
fault model. Persistent partitions or two unavailable members can stop progress.

A primary is a coordinator, not unilateral authority.
A Byzantine/unavailable primary requires certified view change and eventual
connectivity with a responsive replacement.

Committee rotation is trusted public operator configuration.
Permissionless election, staking/slashing, decentralized governance, and arbitrary
committee sizes are outside this implementation.

The protocol is a local research prototype, not a formal PBFT proof or a chain
light client. Independent checks still rely on honest source RPC access.

Related references: [Indexer/lifecycle](../indexer/README.md),
[destination QC verification](../contracts/README.md#certificate-verification),
[metrics](../observability/README.md), and [system trust](../README.md#trust-model).
