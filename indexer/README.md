# Indexing, Persistence, Delivery, and Explorer

[Project overview and public commands](../README.md)

This Node.js subsystem owns source ingestion and finality, deterministic batches,
delivery projection, redundant Relayers, the Persistent Transaction Manager,
and the read-only API/Explorer.
Its script-layer local supervisor composes the complete development system.

PostgreSQL preserves operational history.
Chain A remains source truth, PBFT supplies configured committee authority,
and DestinationGateway owns destination authentication and replay.

## Contents

- [Ownership and data flow](#ownership-and-data-flow)
- [Source ingestion and cursor](#source-ingestion-and-cursor)
- [Finality and source reorganization](#finality-and-source-reorganization)
- [Deterministic batches](#deterministic-batches)
- [Ordered Merkle commitment](#ordered-merkle-commitment)
- [Persistent batch lifecycle](#persistent-batch-lifecycle)
- [Delivery Queue](#delivery-queue)
- [Relayers and fenced leases](#relayers-and-fenced-leases)
- [Persistent Transaction Manager](#persistent-transaction-manager)
- [Destination RPC and receipt recovery](#destination-rpc-and-receipt-recovery)
- [Message Query API](#message-query-api)
- [Explorer](#explorer)
- [Local orchestration](#local-orchestration)
- [Configuration and diagnostics](#configuration-and-diagnostics)
- [Verification and limitations](#verification-and-limitations)

## Ownership and data flow

```text
SourceGateway logs
  -> canonical history + source occurrences + cursor
  -> FINALIZED occurrences
  -> assigned/sealed batch + ordered tree
  -> pinned historical committee + verified QC -> COMMITTED
  -> immutable READY jobs
  -> leased preparation -> durable signed transaction candidates
  -> endpoint send journal -> canonical receipt reconciliation
  -> persisted observations exposed by API/Explorer
```

| Area | Implementation |
| --- | --- |
| Source encoding and persistence | [src/canonical-message.mjs](src/canonical-message.mjs), [src/db.mjs](src/db.mjs) |
| Batch lifecycle | [src/batch-lifecycle.mjs](src/batch-lifecycle.mjs) |
| Portable queue | [src/delivery](src/delivery) |
| Worker coordination | [src/relayer](src/relayer) |
| Transaction state and chain access | [src/transaction-manager](src/transaction-manager) |
| Read-only query surface | [src/api](src/api) |
| Metrics | [src/metrics](src/metrics) |
| Local deployment and recovery demonstrations | [scripts/local](scripts/local) |
| Schema history | [migrations](migrations) |

Protocol uint256 values remain BigInt internally and decimal strings at JSON
boundaries. Database protocol integers use `NUMERIC(78,0)`.
Bounded array positions/counts use exact safe integers.
Public addresses/hashes use canonical lowercase hexadecimal; payload uses BYTEA.

Database IDs, process IDs, timestamps, retry cursors, fencing tokens, and lease
owners are operational data. They do not enter canonical message, batch, Merkle,
or PBFT hash inputs.

## Source ingestion and cursor

Startup checks the RPC chain ID against `CHAIN_A_DOMAIN` and requires bytecode
at the configured SourceGateway.
Only that address's `CrossChainMessage` logs are eligible.

Each pass captures one fixed source head.
Before writing, it reconciles canonical block ancestry and scans bounded ranges
through that head. One-shot mode never follows new blocks beyond its starting
snapshot.

For each event, the Indexer decodes the current ABI, hashes the complete payload,
reconstructs the canonical message, and matches its emitted ID.
A malformed event or mismatched ID fails the complete range.

### Occurrence identity

A protocol message ID identifies message content and context.
An event occurrence identifies one concrete chain log:

```text
(sourceDomain, sourceGateway, sourceBlockHash,
 sourceTransactionHash, sourceLogIndex)
```

PostgreSQL enforces uniqueness on that identity.
An exact repeat reads back and compares all immutable message/provenance fields.
Consistent duplicates are idempotent; inconsistent duplicates roll back the range.

The same protocol message under a replacement block hash is another occurrence.
The old orphan remains REORGED while the new canonical occurrence begins OBSERVED.
A reorg classification never erases or globally revokes the protocol message ID.

### Atomic range persistence

`source_messages` stores canonical fields, full payload, source provenance,
observation time, lifecycle state, and transition/finality evidence.
`indexed_source_blocks` stores every scanned block, including eventless blocks.

Blocks, messages, duplicate validation, and `indexer_cursors.next_block` commit
through one client in one transaction.
The cursor is scoped by source domain/Gateway and points to the first uncommitted
block. Existing cursor state takes precedence over the configured initial block.

A pre-commit crash leaves the whole range retryable.
A post-commit crash leaves its complete evidence and advanced cursor durable.
A range with only consistent duplicates can still advance the cursor.

Continuous indexing repeats fixed-head catch-up passes with the configured poll
delay. Restart reads the persisted cursor and reconciles ancestry before continuing.
It does not reset to the deployment block.

## Finality and source reorganization

The independent watcher captures one head H per pass and evaluates only persisted
OBSERVED/FINALIZING occurrences at or below H.

```text
head >= sourceBlock + FINALITY_BLOCK_DEPTH

OBSERVED -> FINALIZING -> FINALIZED
    |            |
    +----------> REORGED
```

Depth counts successor blocks.
At depth two, block N is eligible at head N+2.
Depth zero is supported by the runtime loader but supplies no depth protection.
The complete deterministic verification profile requires exactly two.

An already-deep OBSERVED row can move directly to FINALIZED without a
`finalizing_at` timestamp.
FINALIZED and REORGED are terminal source occurrence states.
Building a batch does not rewrite them.

### Canonical reconciliation

The reconciler compares persisted blocks with the chain at the fixed snapshot.
A mismatch or confirmed head rollback searches retained history for a common
ancestor.

Recovery locks the source cursor and rechecks its observed premise.
In one transaction it:

1. locks the affected occurrence/history range;
2. rejects any fork touching FINALIZED occurrences;
3. marks affected unfinalized occurrences REORGED while preserving provenance;
4. removes displaced canonical block records;
5. rewinds the cursor to the fork block.

Normal indexing then persists the replacement branch.
A finalized fork or unavailable common ancestor stops automatic recovery with
existing records intact.

Legacy state with messages/cursor but no canonical block table is bootstrapped
only after historical hashes are checked.
Unsafe legacy history cannot be reconstructed by assuming stored messages were
canonical.

### Concurrent startup and fixed snapshots

One Indexer and one Finality Watcher may run concurrently.
Cold cursor creation is conflict-aware and rereads committed state.
Canonical-history bootstrap and subsequent writes recheck the cursor/history
premise under the shared source lock.

A watcher using old H may encounter blocks another worker already persisted
above H. That alone is not evidence of a fork.
Additional current-head probes distinguish stale snapshots from real rollback;
they do not move H for scan bounds or finality calculations.

Ordinary concurrent progress retries reconciliation against the same original
snapshot. Verified canonical divergence uses the guarded recovery path.
A still-canonical suffix above the caller's older snapshot is preserved.

Source RPC calls remain outside the write transaction.
This supports the stated Indexer/watcher pairing; it is not a general active-active
Indexer or distributed ingestion-leasing framework.

### Restart and storage

A watcher restart reconstructs pending work from PostgreSQL, not an in-memory
message list. Database errors fail the current pass and entry point.
Fresh clients resume from durable state after the database returns.

Graceful shutdown is not required for transaction-boundary correctness.
Retaining the same PostgreSQL storage is required; database replication or server
failover is not supplied.

## Deterministic batches

Standalone `createMessageBatcher({ config, pool }).buildBatch({ epoch })`
selects at most the first 128 finalized occurrences in one source scope.
It returns undefined if none exist and does not reserve lifecycle ownership.

The pure builder and database-backed builder apply canonical ascending order:

1. source block number;
2. global source log index;
3. normalized source block hash;
4. source transaction hash;
5. canonical message ID.

They reject non-finalized or wrong-scope inputs, invalid canonical IDs,
duplicate messages/occurrences, conflicting hashes at one height, and conflicting
global log positions.

The batch contains version `1`, source domain/Gateway, explicit batch epoch,
ordered complete messages/provenance, ordered message IDs, and batch ID.

```text
MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)

batchId = keccak256(abi.encode(typeHash, uint8(1),
                             sourceDomain, sourceGateway, epoch, orderedMessageIds))
```

Message order and context determine identity.
Database primary keys, observation/finalization times, and insertion order do not.

The standalone finalized-list API includes assigned history.
Persistent collection instead selects unassigned eligible rows for its specific
BUILDING record. Growing eligibility can change a standalone result; sealed
lifecycle membership is immutable.

## Ordered Merkle commitment

`buildMessageMerkleTree(batch)` first validates/rebuilds the canonical batch.
It neither selects new database rows nor changes the batch ID.

```text
leaf = keccak256(abi.encode(
  keccak256("MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)"),
  batchId, uint256(index), messageId))

node = keccak256(abi.encode(
  keccak256("MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)"),
  left, right))
```

Leaves follow canonical batch order.
Children are positional, never hash-sorted.
An odd last node duplicates itself at every affected layer.
A single leaf is its root with an empty path; an empty tree is invalid.

Proofs carry batch ID, message ID, index, leaf count, and leaf-up siblings.
Expected count fixes path length and self-duplication locations.
The caller must authenticate count through the expected batch, not trust the
proof's own count.

Off-chain proof verification checks complete message fields, finality/provenance,
expected membership, metadata, siblings, and root.
The Solidity kernel receives canonical IDs and the caller's trusted context.

[Shared golden vectors](../test-vectors/merkle-golden-vectors.json) freeze the
cross-language tree/proof contract.
Normal verification checks them without rewriting expected output.
See [contract Merkle reference](../contracts/README.md#batch-and-merkle-verification).

## Persistent batch lifecycle

`createBatchLifecycle({ config, pool })` requires an existing source cursor.

```text
BUILDING -> SEALED -> CONSENSUS_PENDING -> COMMITTED
```

`message_batches` stores operational record identity, source scope, uint256
epoch, commitments, count, and transition timestamps.
`message_batch_members` references authoritative source occurrences rather than
an alternate JSON snapshot.

A BUILDING record may be empty and has no final batch ID/root/positions.
It cannot seal empty.
Only finalized same-scope occurrences can be assigned, at most once across batches.

Creation/assignment/sealing lock the source cursor without advancing it.
One BUILDING record is allowed per source scope.
The first creation needs an explicit seed; later epochs are persisted latest+1.
A conflicting seed or uint256 overflow fails.

| API | Result |
| --- | --- |
| `getOrCreateBuilding({ initialEpoch } = {})` | Recover/create the building record |
| `collectEligible({ initialEpoch } = {})` | Assign the next canonical unclaimed finalized rows up to capacity |
| `assignMessages({ batchRecordId, sourceMessageIds })` | Validate explicit eligible occurrence ownership atomically |
| `sealBatch({ batchRecordId, expectedBatchId?, expectedMessageRoot? })` | Freeze/recover identical membership and commitments |
| `readBatch({ batchRecordId })` | Reconstruct and validate the durable snapshot |
| `markConsensusPending({ batchRecordId })` | Idempotently advance sealed state |
| `commitWithCertificate({ certificate })` | Independently verify QC and atomically commit its exact pending batch |

Collection filters ownership/status/scope and orders/limits candidates in SQL.
A full building batch does no candidate query.
Overflow remains finalized and unassigned for a later batch.
This bounds materialized payload rows, not total database execution complexity.

Explicit assignment loads only requested IDs.
Duplicate requests and same-batch membership are idempotent; foreign ownership
or an over-capacity request fails atomically.

Sealing reconstructs the batch/tree and saves contiguous positions, count,
commitments, and status together.
Guards prevent later membership, epoch, commitment, or transition-time rewrites.
Reads rebuild and compare immutable evidence; they do not silently repair it.

Snapshots contain record, members, batch, and tree.
Before sealing, batch/tree are null.
Current consensus additionally pins protocol version, validator epoch, and
committee digest using trusted operator history.

Only `commitWithCertificate` can establish the valid COMMITTED path.
SQL guards require matching evidence; application readers reverify its cryptography.
Local PREPARED/COMMIT_QUORUM, a status string, or a QC row's existence is insufficient.

Equivalent QC retries preserve the first final certificate.
Committee rotation does not rewrite membership, root, or historical evidence.
See [Validator reference](../validator/README.md).

## Delivery Queue

The projector materializes one immutable READY job for each position of a
strictly verified COMMITTED batch.
BUILDING, SEALED, and pending batches are ineligible.

The canonical operational identity is:

```text
sourceDomain:sourceGateway:batchId:messageIndex
```

It introduces no additional protocol hash.
Each portable package includes the complete message, ordered batch IDs, position,
count, Message Root, inclusion path, and original historical QC/context.

Ordered IDs authenticate batch identity and leaf count.
Trusted validator history comes from the caller, never a package-supplied committee.
Portable verification needs no database or RPC; source provenance/finality is
additionally checked by the strict source lifecycle path.

### Projection and strict reads

`delivery_batches` references the original immutable batch/QC.
`delivery_jobs` retains canonical member references, routing fields, siblings,
READY state, and creation time.
Signatures are not copied as an independent QC for every message.

Projection locks the source batch, revalidates it, and commits every job together.
Uniqueness and deferred structural guards reject partial projections.
Concurrent/repeated projection recovers the exact original jobs/timestamps;
conflicting stored data fails closed.

| API | Behavior |
| --- | --- |
| `materializeBatch({ batchRecordId })` | Atomic whole-batch projection |
| `projectCommittedBatches()` | Bounded ordered discovery of unprojected committed batches |
| `listReadyDeliveryJobs({ limit })` | Strict non-destructive listing; default 100, maximum 1000 |
| `getDeliveryJob(id)` | Verified metadata |
| `getDeliveryPackage(id)` | Verified complete portable evidence |
| `getDeliveryEntries(ids)` | Combined strict reads, maximum 1000 IDs, preserving request order |

Within one operation, immutable batch/root/QC work is shared across selected
members of that batch. Each member, stored sibling path, routing field, and
source reference is still checked.
A good regenerated path cannot replace a corrupt stored path.

There is no process-global validity cache, caller skip-verification flag, or
durable trusted-result token.
A later worker/read starts fresh and verifies its own boundary.
Combined reads do not lease unselected members.

READY means evidence materialized, not submitted or executed.
The immutable queue keeps no authoritative transaction status, nonce, fee,
lease, or receipt; separate worker/manager records own those.
Expired deadlines and opaque application payloads are preserved, not deleted.

Historical v1/v2 QCs retain original bytes and initial-committee semantics,
including absent signed validator epoch. New v3 packages retain their exact epoch.
Rotation never requests new signatures for old packages.

## Relayers and fenced leases

Relayer A/B run the same production worker in separate processes and database
sessions with distinct `RELAYER_WORKER_ID` values.
Both use the exclusive EOA configured by `RELAYER_A_PRIVATE_KEY`.
There is no separate signer identity implied by the second worker.

Eligibility is scoped to source domain/Gateway and destination chain before
batching/limits. Work for another destination does not consume a run's local
candidate allowance.

The job lease uses PostgreSQL time, a worker session identity, expiry, and an
increasing BIGINT fencing token.
Default lifetime is 30 seconds; renewal runs at roughly one third of that interval.
Every protected write checks current ownership/fence.

Takeover waits for natural expiry and acquires a higher fence.
No verification or production path grants authority by manually clearing a lease.
A stale worker cannot write as owner after losing the fence.

### Pre-sign deferral and fairness

An explicit destination execution rejection during preparation, before any
durable intent exists, is `PREPARATION_DEFERRED`.
The worker stores bounded retry scheduling/reason data without reserving a nonce,
creating an intent, or manufacturing a signed attempt.

Only the narrowly recognized preparation condition enters that path.
Database failures, integrity errors, or arbitrary RPC exceptions do not become
successful deferrals.

Due preparation-deferred jobs and fresh jobs are interleaved with durable turn
progress. One repeatedly rejected candidate cannot permanently starve unrelated
fresh work. Persisted signed recovery follows its separate transaction path.

Run summaries count real outcomes across all processed work, including retries
and older recovered attempts. A diagnostic line or attempted operation is not
counted as a confirmed delivery.

The Relayer is untrusted transport.
Leases coordinate workers; they cannot authenticate a package or override the
Gateway's message policy/replay checks.

## Persistent Transaction Manager

The manager owns a durable execution intent and its nonce/candidate history.

Before signing it independently validates the selected package and reconstructs
the expected target, zero value, and production `execute(bytes)` calldata.
The account is exclusive to this manager deployment.

Account locking chooses a nonce from pending chain state, durable next-nonce
progress, and existing reservations.
Intent, reservation, and first SIGNED candidate become durable atomically.
Signed bytes are persisted before any external send.

Crash recovery compares transaction bytes, signer, chain, nonce, target, value,
calldata, fees, and history with the expected intent.
It does not trust a database hash without the corresponding validated candidate.

### Candidate and journal model

One intent may have the original candidate and same-nonce replacements.
All candidates retain the same execution intent.
A later replacement is not automatically the winning transaction.

External send journaling records a logical operation and its endpoint children
before the corresponding requests, then records their results.
Interrupted records preserve uncertainty; they do not prove a send reached a node.

Broadcast events reference an `attempt_id`.
Their delivery job is obtained through the attempt relationship, not a nonexistent
direct job field. Read-only recovery evidence uses that same relationship.

A lost send response is reconciled from retained transaction/receipt evidence.
Recovery does not allocate a new nonce because a request timed out or a process
died after signing.

### Retry and fee replacement

Exact rebroadcast sends byte-identical signed data and preserves its hash.
A replacement uses the same nonce, destination, value, calldata, and gas limit
with increased EIP-1559 fees.

The default bump is at least ceil(previous * 9/8), with a minimum increase of one,
and is constrained by market recommendations and configured fee caps.
A replacement cannot silently change the authenticated message or use a new nonce.

Replacement/rebroadcast intervals, candidate limits, and fee caps are bounded.
An exhausted policy stops progress explicitly; restart does not reset its budget.
Either an older original or newer replacement may become canonical.

Durable keyset scan progress separately schedules receipt checks, recoverable
candidates, and terminal canonicality review.
These cursors are not nonce allocation state.
Bounded/fair scans prevent an old unresolved item from monopolizing every pass.

RPC operations occur outside account/row-lock transactions where the protocol
requires an external observation.
Later writes recheck the durable premise.

## Destination RPC and receipt recovery

The ordered endpoint pool validates the configured destination chain ID and
genesis hash. Public diagnostics use labels such as `rpc-0`, not secret URLs.

Structured, operation-aware errors distinguish transient access failures,
ambiguous broadcasts, already-known transactions, replacement-underpriced,
nonce-too-low, deterministic rejection, and malformed RPC responses.
Broad string matching must not turn arbitrary errors into retry success.

A fallback may restore access to the same chain.
It does not change the signed candidate, destination identity, or nonce.
`ALREADY_KNOWN` still requires exact candidate reconciliation.

### Canonical receipts

Receipt reconciliation observes endpoint evidence against one fixed destination
head and canonical block hashes.
The configured default is three confirmations, counted inclusively:

```text
head - receiptBlock + 1 >= DESTINATION_CONFIRMATIONS
```

This differs from source successor-depth semantics.
Null receipts or a lagging provider alone do not establish a reorganization.
The implementation reconciles its trusted-chain observations conservatively,
without claiming Byzantine provider consensus.

A sufficiently confirmed successful receipt establishes CONFIRMED transaction
state; an equally canonical failed receipt establishes REVERTED.
The actual winning hash can belong to an older candidate.

### Destination reorganization

Terminal receipt observations are revalidated through bounded passes.
Positive canonical block-hash divergence archives the old receipt and reopens the
same intent through the dedicated guarded transaction.

Recovery retains original intent, nonce, candidates, signed bytes, send history,
and retry budget. It does not delete attempts, reset status arbitrarily, or
construct a new source proof/QC.

Before another external action, the production Gateway's exact message-ID state
is checked. If another canonical transaction already executed it, the manager
stops as `GATEWAY_ALREADY_EXECUTED` without claiming its old receipt survived.

Unexplained nonce consumption stops for investigation.
A still-pending original can confirm without another signature/send.
Archived orphan evidence remains visible beside the current outcome.

Canonical confirmation is not irreversible finality.
The latest persisted winner can lag a fork until a worker observes it.

## Message Query API

The API reads persisted source, lifecycle, vote, delivery, and transaction evidence.
It never opens Chain A/B RPC connections, signs, submits, repairs, or drives a worker.

### Routes

| Route | Meaning |
| --- | --- |
| `GET /api/v1/messages?limit=20&before=...` | Bounded recent-message discovery in the configured source scope |
| `GET /api/v1/messages/:messageId` | Correlated lifecycle evidence for one complete canonical ID |
| `GET /metrics` | Operational metrics, documented separately |
| `GET /` | Built-in Explorer |

List `limit` defaults to 20 and accepts 1–100.
`before` is the exact decimal `nextCursor` returned previously.
Unknown/duplicate parameters fail before database access.
The list uses at most limit+1 rows and descending stored occurrence-ID keyset
pagination, never an unbounded history download.

A repeated message ID prefers its live occurrence; if all are orphaned, the newest
historical occurrence is shown. Older displaced rows do not reappear on later pages.
Each page is a separate observation, not a frozen cross-request snapshot.

Detail IDs must be `0x` plus exactly 64 hex digits.
Responses carry `apiVersion: "1"`, `authority: "OBSERVATIONAL"`, and `observedAt`.

The detail sections include message/authorization, source transaction/block and
occurrences, finality, batch/Merkle, PBFT/votes/QC, delivery/attempts, destination
transaction, and execution.
Unavailable later state remains null/empty; missing votes or QCs are never invented.

### Snapshot and authority semantics

Source/delivery/transaction reads use REPEATABLE READ READ ONLY snapshots.
Validator stores have separate snapshots; there is no cross-database atomicity claim.
Vote reads target only the requested epoch and relevant view, authenticate signers,
and deduplicate evidence by phase/view/signer with its observing stores.

Readers revalidate persisted canonical fields, batches, Merkle paths, and QCs.
They acquire no worker lease, voting lock, nonce lock, or recovery authority.
A dead validator process may still have readable durable votes.
Unreadable stores and observed absence are different results.

`PERSISTED_CANONICAL` means the manager's stored observation.
A GET does not discover a new chain fork.
After manager reconciliation reopens an intent, execution can report
`REORG_RECOVERY` with archived receipt history but no current winner.

A successful exact production-Gateway transaction is `CONFIRMED` only when the
configured Gateway, wrapper, and canonical receipt evidence agree.
Other successful raw/EOA historical transport is `TRANSPORT_CONFIRMED`.

`businessResult` remains null.
The API neither interprets supplier commands nor indexes/queries ApplicationB state.
Verification independently checks business execution on-chain.

### Source authorization observation

`IDENTITY_APPLICATION_ADDRESS` identifies the configured non-upgradeable
production application for this source scope.
Matching version-2 messages expose AUTHORIZED; orphaned occurrences expose
HISTORICAL_AUTHORIZED. Missing configuration or another application exposes
UNAVAILABLE, not a failed-proof assertion.

This relies on that deployment's only outbound proof-bearing entry.
The API does not verify deployed bytecode, source Groth16 proofs, present-day
credential validity, subject ownership, or permanent source finality.

### Public errors and data

| HTTP status | Boundary |
| --- | --- |
| 400 | Invalid message ID or list query |
| 404 | Unknown message or route |
| 405 | Unsupported method |
| 409 | Inconsistent persisted evidence |
| 503 | Unavailable observational dependency |
| 500 | Unexpected internal failure |

Public errors use fixed safe codes.
Responses exclude raw signed transactions, private keys, private credential
attributes/witnesses, and connection strings.
Public payloads and signed PBFT evidence remain visible.

Standalone configuration errors report affected field names together before
pools/listeners open. Values and file contents are not echoed.
Listener conflicts identify which host/port settings need attention.

## Explorer

The Explorer is served by the existing API from repository-local HTML/CSS/JS.
It needs no frontend daemon, wallet, CDN, external font, or separate build tool.

It automatically lists recent messages.
Selecting a row opens lifecycle detail; complete-ID search, shareable links,
copy actions, older/latest pagination, refresh, and back/forward navigation remain
available. Blank search returns to browsing.

Views distinguish source status from execution, original/historical committees,
real votes from unavailable observations, replacements from actual winning hashes,
and archived orphan receipts from current confirmation.

All browser traffic is same-origin observational GET.
API values are inserted as text.
The server serves explicit static paths, never arbitrary project files.

The browser has no database/RPC connection or repair action.
Refreshing cannot retry delivery, advance consensus, or grant business status.
Explorer downtime does not stop the protocol.

## Local orchestration

The public commands are:

```bash
./scripts/verify.sh
./scripts/start.sh
./scripts/stop.sh
```

`verify.sh` owns root `verification.log`.
`start.sh` launches the normal interactive deployment and prints real interface
URLs, confirmed message ID, run directory, and service log locations.
`stop.sh` shuts down only that owned deployment.

### Fresh start and healthy reuse

The launcher loads ignored root `.env`, resolves existing tools/artifacts,
and starts a detached supervisor.
A new run owns two fresh Anvil chains, isolated source/validator schemas, four
validator processes, Indexer, Finality Watcher, delivery worker, both Relayers,
API/Explorer, Prometheus, and Grafana.

It deploys the actual contracts, prepares an exact current-policy proof using
existing WASM/zkey, and waits for a real confirmed supplier message.
It does not regenerate the development proving/build artifacts during normal start.

A healthy repeated start reuses the active deployment and its confirmed message.
It does not create another initial message.
A failed/stale owned stack is reported for stop/start handling rather than silently
mixing old records with a new chain.

If DATABASE_URL is configured, the normal run uses isolated schemas in that
database without owning its server. Otherwise it starts an owned temporary
cluster using existing PostgreSQL server tools.
An owned cluster is not a system installation.

### Ownership and logs

Normal run directories live under ignored `.run/local/`.
The active ownership pointer is `.run/local/active.json`.
Per-run logs and native observation configuration remain with that run.

The supervisor records process identity before readiness.
Stop verifies ownership rather than blindly killing a PID or port.
It leaves unrelated services and configured external PostgreSQL servers intact.
Historical logs are retained; they are not new-run protocol input.

Port conflicts fail with configuration guidance.
Default chains use 4545/9545; default interfaces use 8080/9090/3000.
Actual printed URLs win over assumed defaults.

### Verification-owned worlds

Full verification's local-stack portion uses its own `.run/verification/`
ownership records, dynamically allocated ports, and owned temporary PostgreSQL.
It does not reuse or overwrite the normal active pointer.

Clean bootstrap demonstrates independent happy paths and inspects privacy
surfaces. The retained stack then exercises fresh Byzantine/backup-crash messages,
Relayer failover, source reorg, replay, and controlled destination-access recovery.

Existing prior history and safety evidence remain intact during each recovery
scenario. Fault gates/process controls belong to internal verification helpers,
not public APIs, hash inputs, or a separate demo command.

The real PostgreSQL-restart check stops only its owned temporary server and
reopens the same storage.
Cleanup stops owned children/services and preserves failure diagnostics.
The final authorization-expiry gate runs after temporary fault-stack cleanup.

Normal start never injects faults or runs the full validation suite.
Full verification includes all required fault scenarios automatically.

## Configuration and diagnostics

[Root .env.example](../.env.example) is a public template.
Real values belong in ignored `.env` or the process environment.
Placeholders must be replaced; they are not literal usernames/passwords.

### Source and database

| Setting | Meaning/default |
| --- | --- |
| DATABASE_URL | PostgreSQL connection string |
| INDEXER_DB_SCHEMA | Source operational schema; default cross_chain_indexer |
| CHAIN_A_RPC_URL / CHAIN_A_DOMAIN | Expected source endpoint/identity |
| SOURCE_GATEWAY_ADDRESS | Only admitted emitting Gateway |
| SOURCE_GATEWAY_START_BLOCK | Initial cursor block only |
| INDEXER_BLOCK_RANGE | Maximum blocks per range; 2000 |
| INDEXER_POLL_INTERVAL_MS | Continuous catch-up delay; 1000 |
| FINALITY_BLOCK_DEPTH | Required nonnegative source successor depth |
| FINALITY_POLL_INTERVAL_MS | Watcher delay; 1000 |

Delivery readers additionally need exactly one trusted validator-history source:
`VALIDATOR_SET_HISTORY` or `VALIDATOR_SET_HISTORY_FILE`.

### Destination and transactions

| Setting | Meaning/default |
| --- | --- |
| CHAIN_B_CHAIN_ID / CHAIN_B_GENESIS_HASH | Exact destination identity |
| CHAIN_B_RPC_URLS | Ordered JSON endpoint list; otherwise CHAIN_B_RPC_URL |
| RPC_REQUEST_TIMEOUT_MS | Request timeout; 10000 |
| RELAYER_A_PRIVATE_KEY | Shared exclusive transaction signer; secret |
| RELAYER_WORKER_ID / RELAYER_LEASE_MS | Distinct worker identity / 30000 |
| RELAYER_MAX_JOBS_PER_RUN | Bounded worker allowance; 100 |
| DESTINATION_CONFIRMATIONS | Inclusive receipt depth; 3 |
| TX_REBROADCAST_INTERVAL_MS | Exact retry interval; 5000 |
| TX_REPLACEMENT_AFTER_MS | Replacement threshold; 60000 |
| TX_FEE_BUMP_NUMERATOR / TX_FEE_BUMP_DENOMINATOR | Fee increase; 9 / 8 |
| TX_MAX_ATTEMPTS | Candidate bound; 4 |
| TX_MAX_FEE_PER_GAS | Fee cap in wei; 100000000000 |
| TX_MAX_PRIORITY_FEE_PER_GAS | Priority cap in wei; 10000000000 |

The replacement interval must not be below rebroadcast interval.
Fee numerator must exceed denominator, priority cap must not exceed total cap,
and attempt count is bounded by the loader.

### API and local launch

API requires database/schema, source domain/Gateway, finality depth, and trusted
history. It needs no signer, destination RPC, or genesis configuration.

`MESSAGE_QUERY_API_HOST/PORT` default to loopback/8080.
`MESSAGE_QUERY_VALIDATOR_STORES` lists public validator identity and schema with
an optional private database URL per reader.
Relative API history-file paths resolve against the project root.

`IDENTITY_APPLICATION_ADDRESS` enables the source deployment assumption;
`PRODUCTION_DESTINATION_GATEWAY_ADDRESS` enables production execution classification.
Missing optional values leave observations unavailable rather than inventing success.

The complete launcher supplies actual deployment addresses/stores to its children.
A successful verification run does not configure standalone API startup:
temporary verification addresses must not be copied blindly into another schema.

Native observation overrides are `PROMETHEUS_BIN`, `GRAFANA_BIN`,
`GRAFANA_HOME`, and interface ports.
[Observability reference](../observability/README.md) owns their semantics.

### Narrow diagnostic entries

After configuring the intended environment, the package exposes `migrate`,
`catch-up`, `start`, `finality:once`, `finality`, `delivery:once`,
`relayer:once`, `transaction:once`, and `api:start`.
These are maintainer diagnostics for existing deployments, not extra steps after
the public start command.

`api:start` loads the root env file but creates no schemas or deployment.
Use actual source scope/history/read stores for the database being inspected.

## Verification and limitations

[package.json](package.json) and [package-lock.json](package-lock.json) require
Node.js 22+ and pin pg, viem, prom-client, and verification dependencies.
No scripts here install the environment.

The root entry covers unit/database tests, bounded query and concurrency
regressions, real indexing/finality, batches/Merkle, independently verified QCs,
queue projection, lease takeover, exact sends/replacements, RPC classification,
destination reorgs, and API/Explorer/metrics purity.

Database recovery tests recreate application pools and exercise real owned-server
restart. Real-process scenarios use saved evidence and natural lease expiry,
not arbitrary status resets or new nonce allocation.

Fixed vectors remain read-only expected artifacts.
Source and transaction history comparisons use their actual relationships.
Tests distinguish expected policy rejection from environmental/runtime failure.

API/Explorer checks include production presentation-code and loopback HTTP tests.
They do not claim browser automation or visual browser verification.
The complete result remains the final root log footer and zero exit code.

This implementation does not supply PostgreSQL replication, multi-region
availability, arbitrary active-active ingestion, Byzantine RPC consensus,
unconditional delivery liveness, or a destination business-event indexer.

Further boundaries: [Contracts](../contracts/README.md),
[Validators](../validator/README.md), [ZK](../zk/README.md),
[Observability](../observability/README.md), and
[system limitations](../README.md#known-limitations).
