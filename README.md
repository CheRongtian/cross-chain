# Cross-Chain Messaging Protocol

A research and portfolio prototype for credential-authorized messaging between
two EVM chains, with persistent indexing, PBFT certification, redundant delivery,
destination execution, an Explorer, and operational dashboards.

The example business flow grants a supplier status on Chain B after an
authorized application forwards a message on Chain A.
The protocol carries application messages; it does not bridge tokens or assets.

This repository demonstrates a complete local path and controlled recovery
scenarios. It is not a production bridge, a mainnet deployment, or a formally
verified implementation.

## Contents

- [System overview](#system-overview)
- [Trust model](#trust-model)
- [Run the project](#run-the-project)
- [Message lifecycle](#message-lifecycle)
- [Authorization and privacy](#authorization-and-privacy)
- [Consensus and destination execution](#consensus-and-destination-execution)
- [Faults and recovery](#faults-and-recovery)
- [Verification](#verification)
- [Explorer and observability](#explorer-and-observability)
- [Repository and documentation](#repository-and-documentation)
- [Known limitations](#known-limitations)

## System overview

The local deployment uses Chain A domain `10011` and Chain B domain `2001`.
Domains are EVM chain IDs in this prototype.
Source and destination contracts, workers, and committee configuration must agree
on those identities and on the deployed Gateway addresses.

```text
Private credential + exact forwarding intent
                    |
           Groth16 authorization
                    v
Chain A: IdentityApplicationA -> SourceGateway -> CrossChainMessage
                                                    |
                                     Indexer + Finality Watcher
                                                    |
                                    finalized deterministic batch
                                                    |
                                        ordered Merkle commitment
                                                    |
                                  four validators / three-vote QC
                                                    |
                                           Delivery Queue
                                                    |
                               Relayer A / Relayer B, shared signer
                                                    |
                                  Persistent Transaction Manager
                                                    v
Chain B: DestinationGateway -> QC + inclusion + domain + replay checks
                                                    |
                                              ApplicationB

PostgreSQL: durable operational records, votes, intents, and receipts
Explorer / Prometheus / Grafana: read-only observations of this path
```

Each layer has a different responsibility:

| Component | Responsibility |
| --- | --- |
| IdentityApplicationA | Enforce credential policy and authorize one exact source forwarding call |
| SourceGateway | Admit configured applications and emit canonical messages |
| Indexer | Persist validated source events and canonical block ancestry |
| Finality Watcher | Apply the configured source confirmation-depth policy |
| Batch lifecycle and Merkle tree | Freeze deterministic finalized membership and commit its order |
| Validators | Independently validate source evidence and certify a batch/root through PBFT |
| Delivery Queue | Persist immutable per-message packages from committed batches |
| Relayers and Transaction Manager | Coordinate transport, nonces, signed bytes, retries, and receipts |
| DestinationGateway | Authenticate the package, prevent successful message replay, and invoke the receiver atomically |
| ApplicationB | Apply the example supplier-grant action |
| Explorer and dashboards | Explain persisted progress without authorizing or repairing execution |

The current message format is version `2`, the batch format is version `1`,
and the destination transport format is version `1`.
Current PBFT evidence is version `3`; historical version `1` and `2`
evidence retains its original meaning.

A batch epoch, validator-set epoch, PBFT view, and credential policy epoch
are separate contexts. None should be inferred from another.
Their encodings and transition rules are documented with their owning subsystem.

## Trust model

The system combines explicitly configured authorities.
It does not remove trust in the credential publisher, committee, chain RPC
providers, administrators, or the underlying chains.

| Authority or assumption | Boundary |
| --- | --- |
| Chain A and its RPC access | Source event truth, ancestry, and the observed head used for confirmation depth |
| Credential issuer policy | The application chooses a trusted issuer value; the circuit does not authenticate issuer signatures |
| Credential-state authority | Publishes the active credential root, records explicit revocations, and advances policy epochs |
| SourceGateway administrator | Chooses which applications may emit protocol messages |
| Validator committee | Four members per validator epoch; three distinct matching votes are required |
| Destination registry administrators | Configure trusted remote Gateways and append validator-set history |
| Chain B and its RPC access | Destination execution and canonical receipt observations |
| PostgreSQL and local operator | Preserve durable operational state and configuration; stored data is still revalidated |
| Relayer | Transports evidence; possession of its transaction key grants no independent message authority |

The PBFT configuration is `n = 4`, `f = 1`, quorum `3`.
Safety and progress claims are limited to the implemented protocol and fault
scenarios under these assumptions.
Two unavailable validators or a persistent 2|2 partition cannot make progress.

Validators do not accept an Indexer flag as source truth.
Each independently reads Chain A and validates the proposed finalized batch.
A QC certifies the committee's signed batch/root statement; it is not an
independent cryptographic proof of Chain A consensus finality.

The destination accepts the configured remote Gateway and historical committee
authority. Administrative mistakes can change which messages are admissible.
Registry administration is a security boundary, not an automatic governance system.

PostgreSQL makes operations recoverable across process loss.
A database row alone is neither a source-chain fact nor permission to execute.
Persisted messages, batches, votes, certificates, and transaction bytes have
validation rules at their consumers.

Confirmation depth is an operational finality policy.
A source fork that touches a finalized occurrence stops automatic recovery.
Destination receipt confirmation can also be reversed by a later canonical fork.

## Run the project

### Prepared environment

The scripts expect an already prepared local development environment.
They do not install packages, Foundry, compilers, PostgreSQL, Prometheus, or Grafana.

Required tooling includes:

- Node.js `22+` and the locked dependencies for `indexer/`, `validator/`,
  and `zk/`;
- Foundry tools, including Forge, Cast, and Anvil, with the Solidity toolchain
  configured by [contracts/foundry.toml](contracts/foundry.toml);
- Python 3 and Circom 2 for the credential and proving workflow;
- an existing PostgreSQL server/tool installation;
- native Prometheus and Grafana executables and Grafana's installed home files.

Package manifests and lockfiles own JavaScript dependency versions.
The ZK package pins `circomlibjs` to `0.1.7`.
Subsystem documentation describes artifact preparation and diagnostic commands;
those are not additional day-to-day launch steps.

Use the ignored root `.env` for local credentials and configuration.
[.env.example](.env.example) contains configuration names and placeholders,
not usable passwords. Replace placeholders with your own local values.
Do not commit real connection strings, passwords, or private keys.

Full verification requires a working `DATABASE_URL` for its database-backed
checks. Normal startup can use that configured database with isolated schemas,
or create an owned temporary local cluster using the already installed
PostgreSQL tools when no database URL is configured.

The complete verification profile uses source successor depth `2`.
Other valid source depths are supported by the runtime configuration, but that
deterministic full-verification fixture requires the exact value `2`.

### Verify and prepare artifacts

From the project root:

```bash
./scripts/verify.sh
```

This is the complete automated verification entry.
It builds contracts, prepares development proving artifacts, runs tests,
deploys temporary contracts, exercises real workers and recovery scenarios,
and checks a clean local stack.

It overwrites [verification.log](verification.log) on every run.
A failed prerequisite or verification step stops the workflow with a nonzero exit.
See [Verification](#verification) for the success criteria and safety boundary.

### Start the interactive system

After successful artifact preparation:

```bash
./scripts/start.sh
```

Startup launches the complete normal local system and prepares a real,
confirmed example message automatically.
No separate message-ID lookup, frontend build command, demo command, or
fault-injection command is needed.

The script prints the actual Explorer, Prometheus, and Grafana URLs,
the confirmed message ID, and the run's log directory.
Default observation URLs are:

| Interface | Default URL |
| --- | --- |
| Explorer | `http://127.0.0.1:8080/` |
| Prometheus | `http://127.0.0.1:9090/` |
| Grafana | `http://127.0.0.1:3000/` |

Open the printed Explorer URL to browse recent persisted messages and select
one for its lifecycle details. The full canonical message-ID search remains
available for direct links and investigation.

Normal startup includes two Anvil chains, database-backed workers, four
validators, both Relayers, the API/Explorer, Prometheus, and Grafana.
It uses existing build/proving artifacts and creates a fresh deployment when
starting a new owned run.

A repeated start reuses a healthy owned active run without creating another
initial message. It does not blindly attach old database records to new chains.
A stopped run followed by a fresh start creates new chains and isolated schemas;
retained log files are historical evidence, not input for the new deployment.

### Stop the owned system

```bash
./scripts/stop.sh
```

Shutdown targets resources recorded as belonging to this local run.
It leaves unrelated processes and an external PostgreSQL server alone.
Run logs are retained for inspection.

The two regular entries remain `verify.sh` for automated verification and
`start.sh` for interactive use; `stop.sh` is their explicit local shutdown helper.
Fault injection runs inside verification, never during ordinary startup.

## Message lifecycle

Source, batch, transport, and business state are distinct.
A page showing progress in one layer does not imply completion in the next.

### Source observation and finality

The Indexer validates the configured Gateway's event, payload hash, and canonical
message ID before committing a scanned range and its next-block cursor together.
One-shot indexing stops at the head captured when that pass starts.

Source occurrences progress through:

```text
OBSERVED -> FINALIZING -> FINALIZED
    |            |
    +----------> REORGED
```

An already-deep observation may move directly to `FINALIZED`.
The policy is `head >= sourceBlock + FINALITY_BLOCK_DEPTH`.
Depth counts successor blocks, so a message in block N reaches depth two at N+2.

Unfinalized forks preserve orphan occurrences as terminal `REORGED` records
and rewind canonical indexing to the replacement branch.
`REORGED` refers to one concrete source log occurrence, not every occurrence
of the same protocol message ID.

### Batch and consensus

Only finalized source occurrences are eligible for persistent batch assignment.
Canonical ordering determines membership, batch ID, leaves, and the Message Root.
The persistent lifecycle freezes membership when sealing:

```text
BUILDING -> SEALED -> CONSENSUS_PENDING -> COMMITTED
```

`COMMITTED` requires an independently verified QC.
A sealed batch or a local `PREPARED` vote state grants no destination authority.

### Queue and transaction

A committed batch produces immutable `READY` delivery jobs.
Relayers may contend for the same job, but a database-clock lease and increasing
fencing token coordinate durable transaction preparation.

The Transaction Manager persists signed bytes before broadcasting.
It retains nonce reservations, candidate history, and endpoint outcomes across
process loss. Fee replacement preserves the original nonce and execution intent.

A confirmed or reverted transaction does not turn the queue row into a new
source lifecycle state. Transaction outcomes and queue eligibility are separate
records; the API derives progress from their associated evidence.

### Destination and business result

DestinationGateway validates the complete package before consuming its message ID.
It then invokes the receiver in the same transaction.
Receiver failure rolls back replay consumption and all transaction-local effects.

A canonical successful production-Gateway receipt reaching the configured
destination depth is reported as `CONFIRMED`.
A successful receipt for a different transport wrapper is only
`TRANSPORT_CONFIRMED`; it cannot establish production Gateway execution.

The API does not index ApplicationB business events, so `businessResult`
remains `null`. The complete verification separately checks actual supplier
state and successful Gateway/ApplicationB execution.

## Authorization and privacy

The current authorized source path is
`IdentityApplicationA.forwardAuthorizedMessage`.
Its Groth16 proof binds the exact forwarding intent, including the destination,
payload hash, deadline, application, Gateway, and actual executor.

Proof verification, source nullifier consumption, and SourceGateway emission
are atomic. Altering a bound field or using the proof through another executor
fails that path. Standalone supplier verification grants no later forwarding
capability.

The circuit has twelve public signals.
Its public authorization deadline is constrained by
`currentTimestamp < authorizationValidUntil <= private expiry`.
Application A additionally requires
`block.timestamp < authorizationValidUntil` when the proof is executed.
Proof freshness against `maxProofAge` is a separate check.

The authorization deadline exposes a lower bound on private expiry.
The credential commitment, issuer policy, required role, state root, application
context, nullifier, and intent limbs are also public proof context.
Repeated public values can be correlated; this prototype does not promise anonymity.

Private credential fields and membership paths stay in the proving workflow.
Cross-chain messages and delivery packages do not carry the private witness
or a raw credential. Message payloads are public source-event data.

The circuit does not authenticate issuer signatures or bind its private subject
to an EVM address. Stored supplier status is keyed by credential commitment and
does not automatically expire.

SourceGateway itself is credential-unaware.
Other applications authorized by its administrator remain responsible for their
own policy. Older source events are not retroactively covered by today's exact
proof-to-forwarding binding.

Indexer and Validators validate source evidence without re-proving credentials.
Chain B validates committee and message evidence without running Groth16.
The ZK trust boundary remains at the configured Chain A application.

## Consensus and destination execution

Four validators independently reconstruct the same finalized batch/root.
The deterministic primary proposes; three distinct PREPARE votes establish
local prepared evidence; three distinct COMMIT votes form a QC.
Votes are authenticated, context-bound, and durably locked before transmission.

Current evidence pins a validator epoch and committee digest.
The history fixture contains epoch `7` with V1–V4 and epoch `8` with V2–V5.
That is five known identities across history, with four active members per epoch.
Historical verification resolves the signed epoch; it does not substitute
the latest committee.

A stalled primary can be replaced through authenticated VIEW_CHANGE evidence
and a quorum-certified NEW_VIEW. Backups independently check safe-value
selection. Old votes do not count toward a new view's quorum.

The destination execution path composes:

1. bounded, canonical delivery-package decoding;
2. historical committee and QC verification;
3. positional Merkle inclusion bound to the ordered batch;
4. canonical message-ID, payload, source/destination domain, Gateway, and deadline checks;
5. message-ID replay protection;
6. atomic receiver execution.

The destination trusts the configured source Gateway, not the Relayer's identity.
Relayer A and B are redundant transport workers using one coordinated exclusive
EOA signer. Their redundancy does not increase committee quorum or create
another authorization authority.

Protocol bounds include a `4096`-byte payload, `128` batch members, Merkle
depth `7`, an `11232`-byte raw package, and `11300` bytes of outer
`execute(bytes)` calldata.
These are delivery limits, not new canonical message-hash inputs.

Full encodings, committee compatibility rules, contract APIs, and bounds live in
[contracts/README.md](contracts/README.md).

## Faults and recovery

Recovery follows durable evidence and chain observations.
A supervisor restart does not authorize state resets, new nonces, or replacement
certificates for already committed messages.

| Failure | Implemented recovery or stop condition |
| --- | --- |
| Source fork before finalization | Mark orphan occurrences REORGED, rewind the cursor atomically, index the replacement branch |
| Fork touching finalized history | Fail closed with the existing records intact for investigation |
| Indexer or watcher loss | Recreate clients, reconcile Chain A, resume the committed cursor and lifecycle |
| One unavailable backup validator | Three live validators can commit; the returning node verifies retained evidence |
| Conflicting Byzantine backup | Reject conflicting signed contexts; three honest votes can still certify the canonical statement |
| Primary loss | Persist view-change evidence and activate a quorum-certified safe replacement view |
| 2|2 partition | Stop short of quorum; resume with authenticated retained evidence after connectivity returns |
| Relayer loss after signing | Wait for natural lease expiry; a higher fence recovers the same durable nonce and signed candidate |
| Ambiguous send or RPC outage | Reconcile transaction evidence and retry exact bytes or a bounded same-nonce replacement |
| Duplicate package delivery | Destination message-ID replay check prevents another successful receiver execution |
| Destination receipt reorg | Reopen from positive canonical divergence, retain nonce/history, recheck on-chain replay before sending |
| PostgreSQL restart | Recreate connections and resume durable state from the same storage |

Configured RPC failover validates destination chain identity and genesis.
It improves access availability; it does not establish Byzantine agreement
between providers or make a single RPC response infallible.

Retry limits, fee caps, persistent partitions, unexplained nonce consumption,
invalid evidence, and finality-policy violations can stop progress.
The system exposes those conditions rather than claiming unconditional recovery.

## Verification

The single full entry is `./scripts/verify.sh`.
It uses strict error handling, streams stdout/stderr to the terminal and root
`verification.log`, overwrites the previous log, and stops dependent steps on failure.

The workflow covers contract builds and tests, credential/proof checks,
cross-language fixed vectors, PostgreSQL state transitions, independent validator
processes, real source/destination execution, API/Explorer behavior, and metrics.

Its fault coverage includes:

| Group | Evidence checked |
| --- | --- |
| Source recovery | Fixed-head indexing/finality, unfinalized forks, finalized-fork rejection, concurrent startup/history |
| PBFT | Backup loss, conflicting votes, partitions, primary loss, safe view changes, restart and committee rotation |
| Delivery | Durable signing, natural-lease takeover, nonce reuse, replacement recovery, fair work selection |
| Destination | RPC failures, receipt confirmation/reorganization, exact replay rejection, receiver rollback |
| Storage | Real owned PostgreSQL restart and multi-component recovery without rebuilding durable history |
| Security | Message/domain integrity, ZK public-signal mutations, stateful/fuzz invariants, execution-time authorization expiry |
| Local stack | Clean bootstrap, two real happy paths, privacy surfaces, and native observation services |

The isolated local-stack verification also exercises six retained scenarios:
a Byzantine validator, backup crash, Relayer failover, source reorg, duplicate
delivery, and recovery after a controlled Chain B access outage.

These scenarios run automatically within verification.
There is no separate public `demo.sh` command, optional fault mode required
for completeness, or fault injection in normal startup.

The complete workflow uses dedicated temporary ownership records, chain ports,
and database scopes. The clean-stack portion owns its PostgreSQL cluster and
native services; PostgreSQL-restart checks target owned temporary storage.
It must not restart the operator's external PostgreSQL instance.

Verification success requires exit code zero and the final
`VERIFICATION PASSED` / `Complete End-to-End Cross-Chain Execution` footer.
A partial test pass, expected rejection, or earlier marker does not replace
that complete result.

Expected negative tests deliberately exercise rejected proofs, invalid messages,
replays, and policy failures. Judge them by their asserted outcome and the
workflow's exit status. Unexpected errors or warnings deserve investigation;
this README does not certify an unexamined log as successful.

Full verification changes temporary chain state, runs processes, and generates
development artifacts. Read the log when it stops; correct the reported local
configuration or implementation issue before retrying.
Generated local proving keys use development entropy and are not production setup.

## Explorer and observability

The Explorer is served by the read-only Message Query API.
It offers recent-message browsing, direct canonical-ID queries, lifecycle
evidence, consensus history, and delivery attempts.

API responses have authority `OBSERVATIONAL`.
They describe persisted evidence through read-only database snapshots and do
not submit transactions, query chains for repair, cast votes, or change state.
A browser refresh cannot cause a retry or grant a supplier status.

Prometheus collects existing worker/API/validator metrics.
Grafana provisions the repository's dashboard against that Prometheus instance.
Both are included in normal local startup and the clean-stack verification.

Metrics are process-local operational observations, not an authoritative ledger.
Restarts can reset counters; scrape gaps and post-commit publication gaps can occur.
An unavailable scrape, a reachable-but-unready validator, and unknown data are
different conditions.

The current metric names, label restrictions, backlog meaning, dashboard
configuration, and source ownership are in
[observability/README.md](observability/README.md).

## Repository and documentation

```text
contracts/       EVM contracts, shared on-chain codecs, and Foundry tests
zk/              Credential model, circuit, proof preparation, and security cases
indexer/         Source ingestion, batches, delivery, API, Explorer, local orchestration
validator/       Independent validator processes, PBFT, epoch history, durable safety state
observability/   Prometheus example configuration and Grafana provisioning/dashboard
test-vectors/    Fixed cross-language protocol and regression vectors
scripts/         Public start/stop/verify entries and their internal shell helpers
```

Generated artifacts, dependency directories, local secrets, and run logs are
not part of the source architecture. Local runtime ownership and logs live
under ignored `.run/` directories.

| Read next | Scope |
| --- | --- |
| [Contracts](contracts/README.md) | Canonical message/intent/package encodings, registries, destination execution, ABI bounds, contract tests |
| [Zero-knowledge authorization](zk/README.md) | Credential fields, twelve public signals, active-state tree, nullifiers, deadlines, proving artifacts |
| [Credential model](zk/credential-model/README.md) | Synthetic credential schema, field encoding, fixtures, and model validation |
| [Indexer and transport](indexer/README.md) | Fixed-head ingestion, finality/reorgs, batches/Merkle, queue, leases, transactions, API/Explorer, local runtime |
| [Validators](validator/README.md) | Identity, independent source validation, PBFT phases, QC, safe view changes, historical committees |
| [Observability](observability/README.md) | Metric families, collection boundaries, Prometheus targets, Grafana provisioning, observation caveats |

Each subsystem reference links back here and to related protocol boundaries.
Configuration examples are public templates; use local ignored files for secrets.

## Known limitations

- Local EVM chains and controlled scenarios demonstrate a prototype.
  They do not establish mainnet readiness, universal fault tolerance, or formal safety.
- Source confirmation depth and destination receipt depth are operational
  policies; neither guarantees irreversible chain finality.
- Credential issuer authentication, decentralized root governance, subject-to-EVM
  ownership, public-signal unlinkability, and automatic stored-status expiry are absent.
- The exact proof/message binding applies to the current authorized forwarding
  path. SourceGateway admission alone does not establish that every caller uses ZK.
- Committee size is fixed at four per validator epoch. Historical rotation is
  configured explicitly; there is no permissionless committee selection.
- Registry administrators and the credential-state authority remain trusted.
  Current remote-Gateway replacement has no historical grace-period machinery.
- Relayer workers share an exclusive transaction account. External use of that
  account can disrupt nonce management; signer redundancy is not key decentralization.
- RPC failover assumes honest chain access. It is not a light client or
  multi-provider consensus protocol.
- PostgreSQL durability assumes retained local storage. Replication, server
  failover, and general active-active Indexer deployment are outside this repository.
- Destination replay protection covers successful execution once per message ID.
  Failed transactions can be retried; distinct authenticated messages can invoke
  the same receiver independently.
- The API/Explorer does not independently establish business state or index
  ApplicationB events. Its `businessResult` remains `null`.
- Development proving setup, synthetic credentials, public local keys, and
  loopback dashboards must not be reused as production security configuration.

For implementation detail, start with the owning subsystem reference above.
For the complete current behavior, use the single verification entry and inspect
its latest root log; no document substitutes for that execution result.
