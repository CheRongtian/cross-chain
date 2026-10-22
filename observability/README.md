# Observability

[Project overview and public commands](../README.md)

This directory contains the Prometheus scrape example and provisioned Grafana
dashboard for existing API, worker, and validator metrics.
It observes the protocol; it never drives consensus, delivery, authorization,
canonical receipt recovery, or business state.

Runtime collectors live in
[indexer/src/metrics](../indexer/src/metrics).
The [Indexer/runtime reference](../indexer/README.md) owns worker and local-stack
behavior; the [Validator reference](../validator/README.md) owns readiness/PBFT.

## Contents

- [Startup and ownership](#startup-and-ownership)
- [Metric families](#metric-families)
- [Counting and backlog semantics](#counting-and-backlog-semantics)
- [Labels and privacy](#labels-and-privacy)
- [Prometheus configuration](#prometheus-configuration)
- [Grafana provisioning](#grafana-provisioning)
- [Reading failures correctly](#reading-failures-correctly)
- [Verification](#verification)

## Startup and ownership

`./scripts/start.sh` starts existing native Prometheus/Grafana along with the
normal owned local system. It prints actual URLs and per-run log paths.
Defaults are Prometheus port 9090 and Grafana port 3000.

`./scripts/stop.sh` stops only those owned instances.
There is no separate required dashboard command, Docker service, npm dashboard
package, or public demonstration CLI.

The environment must already contain `prometheus`, `grafana`, and Grafana's
installed home files.
`PROMETHEUS_BIN` / `GRAFANA_BIN` may specify existing executable paths.
`GRAFANA_HOME` must identify an installation containing `conf/defaults.ini`
when it cannot be located from the executable.

The launcher prepares per-run configuration under its ignored runtime directory.
It substitutes actual API/worker/validator ports and its Prometheus URL without
rewriting the tracked examples.
Native data, plugin, provisioning, and log directories belong to that run.

The full root verification includes both artifact-level dashboard checks and
a real clean-stack path that launches native Prometheus/Grafana.
Therefore those installed tools are prerequisites for the complete workflow.
The artifact-only checks do not individually need the servers.

Protocol workers do not load Grafana dashboards or scrape configuration.
Observation collection errors are isolated from protocol state changes.
The local supervisor still reports observation-service readiness as part of
complete-stack startup; that operational readiness is not protocol authority.

## Metric families

[registry.mjs](../indexer/src/metrics/registry.mjs) owns fifteen instrument
definitions; the API additionally owns the pending-delivery gauge.
Names below are exact, including the existing doubled latency prefix.

| Metric | Type | Observation |
| --- | --- | --- |
| cross_chain_messages_observed_total | Counter | Newly committed source occurrences |
| cross_chain_messages_finalized_total | Counter | Durable FINALIZED transitions |
| cross_chain_messages_reorged_total | Counter | Durable REORGED occurrence transitions |
| cross_chain_batches_created_total | Counter | New durable BUILDING records |
| cross_chain_pbft_round_duration_seconds | Histogram | Local accepted proposal to QC or certified view abandonment |
| cross_chain_pbft_view_changes_total | Counter | Certified active-view transitions accepted by that node |
| cross_chain_validator_available | Gauge | Reachable process's local production readiness |
| cross_chain_pbft_quorum_failures_total | Counter | First durable timeout handling for a local view |
| cross_chain_delivery_attempts_total | Counter | New SIGNED candidates, including replacements |
| cross_chain_delivery_retries_total | Counter | Replacement creation or actual repeated candidate send |
| cross_chain_relayer_failures_total | Counter | Failed production Relayer/manager actions |
| cross_chain_rpc_failures_total | Counter | Failed endpoint requests, including failures followed by successful fallback |
| cross_chain_transaction_replacements_total | Counter | New durable same-nonce candidates |
| cross_chain_cross_chain_latency_seconds | Histogram | Source observation to new canonical production Gateway confirmation |
| cross_chain_destination_execution_failures_total | Counter | Newly canonical, sufficiently confirmed REVERTED outcomes |
| cross_chain_pending_delivery_jobs | Gauge | API-owned current unresolved READY count |

Histogram bucket boundaries are fixed in seconds:

```text
PBFT:   .01 .025 .05 .1 .25 .5 1 2.5 5 10 30 60 120
Latency: .1 .25 .5 1 2.5 5 10 30 60 120 300 600
```

A PBFT observation is local to each validator.
Summing it across validators does not produce a global distinct-round count.
View-change votes alone do not increment certified view transitions.

## Counting and backlog semantics

Transactional observations are published after successful database commit.
Publication is best effort; a process can die between commit and metric emission.
Counters are process-local and reset at restart, so they are not a durable
exactly-once event ledger.

A new canonical confirmation after a destination reorg is another latency event.
Old counter observations are not decremented.
A reverted transaction contributes only after its receipt satisfies the
canonical confirmation policy, not because gas estimation rejected a request.

Attempts count durable signed candidates, not queue jobs or endpoint requests.
Retry kind is `replacement` or `exact_rebroadcast`.
A repeated logical marker without an actual repeated candidate send is not a retry.
Fallback endpoint requests remain separately visible as RPC observations.

### Pending delivery gauge

[pending-delivery.mjs](../indexer/src/metrics/pending-delivery.mjs) runs only in
the observational API, once per registry/source scope.

Its single bounded-time SELECT counts READY jobs in that source domain/Gateway
whose source occurrences remain FINALIZED and whose intent is not currently
CONFIRMED or REVERTED.

This includes fresh jobs, preparation-deferred work, stopped retry work,
historical unresolved transport, and reopened destination-reorg recovery.
It is not a count of immediately sendable jobs, a retry scheduler, or a throughput rate.

The collector uses no protocol repository, state transition, worker lock, RPC,
or repair action. A failed or invalid observation becomes NaN, not zero or an old
successful value. Other metric families remain usable.

## Labels and privacy

Only fixed, bounded enumerations are application labels:

- PBFT outcome: committed or view_change;
- retry kind: exact_rebroadcast or replacement;
- Relayer operation: process_job, run, or transaction;
- supported RPC operation and fixed reason class.

Reason classes include transient access, ambiguous broadcast, already-known,
underpriced replacement, nonce-too-low, deterministic rejection, response error,
stale fence, and fixed worker-failure categories, as applicable to each instrument.

Message IDs, batch IDs, hashes, epochs, nonces, addresses, worker IDs, fencing
tokens, endpoint URLs, passwords, private keys, payloads, and raw errors are not
application metric labels.

Prometheus adds its normal job/instance target labels.
Keep targets free of credentials; use one deployment/source scope per job set.
Public RPC failure output uses safe endpoint labels, not secret URLs.

Metrics do not expose private witnesses or turn public message data into anonymous
data. The [ZK reference](../zk/README.md#privacy-and-limitations) describes the
actual privacy boundary.

## Prometheus configuration

[prometheus.example.yml](prometheus/prometheus.example.yml) uses a 15-second
scrape interval and 10-second timeout, with three jobs:

| Job | Scrape owner |
| --- | --- |
| cross-chain-api | Existing API listener's /metrics, including pending count |
| cross-chain-workers | Each continuous worker's same-process metrics listener |
| cross-chain-validators | Each validator's existing HTTP listener |

API and validator servers serve `GET/HEAD /metrics`.
Continuous CLI workers use `METRICS_PORT` and optional loopback `METRICS_HOST`
for a same-process listener.
One-shot worker metrics disappear when their process exits.

The tracked example intentionally has an empty validator target list.
A manually configured deployment must supply its real listeners; temporary
verification ports are not reusable configuration.

The standard local launcher fills all targets automatically:
one API, five worker listeners, and four validator listeners.
No sidecar or second metrics daemon is required.

## Grafana provisioning

Tracked artifacts are:

- [Dashboard](grafana/dashboards/cross-chain-protocol.json),
  UID `cross-chain-protocol`, classic schema version 39;
- [Datasource](grafana/provisioning/datasources/prometheus.yaml),
  UID `cross-chain-prometheus`, proxy/GET access, default example URL
  `http://127.0.0.1:9090`, 15-second interval;
- [Provider](grafana/provisioning/dashboards/cross-chain.yaml),
  Cross-Chain folder, 30-second file refresh, UI updates disabled.

The dashboard refreshes every 15 seconds and opens a one-hour range.
It uses only the existing metric families, histogram quantiles, rates, increases,
and Prometheus scrape availability.

Panels cover throughput/latency, pending work, source reorgs, local PBFT
timing/view changes/quorum failures, validator readiness versus scrape availability,
delivery attempts/replacements/retries, Relayer failures, and RPC failures.

Manual provisioning resolves the dashboard directory through
`CROSS_CHAIN_GRAFANA_DASHBOARDS_PATH`.
The standard launcher supplies the actual absolute path in its per-run copy and
points the datasource at its owned Prometheus.

Local Grafana binds loopback with anonymous Viewer access and disables automatic
plugin preinstallation/update retrieval.
That is local demonstration configuration, not a production authentication design.

## Reading failures correctly

Prometheus `up = 0` means scraping failed.
A reachable validator reporting availability zero means local readiness failed.
Missing/unknown data is neither readiness zero nor a zero-event assertion.

The dashboard preserves those distinctions.
An empty rate shortly after startup can reflect insufficient samples, and a
counter reset does not erase durable protocol history.

Latency and backlog summarize observations.
Neither can prove source canonicality, a PBFT QC, destination replay consumption,
or supplier state. A dashboard cannot repair a stuck transaction.

Consult source/transaction evidence through the
[API/Explorer](../indexer/README.md#message-query-api), retained worker logs,
and the actual chain when investigating a failure.
The API itself is also observational, not live independent chain verification.

## Verification

The only complete verification command is:

```bash
./scripts/verify.sh
```

It overwrites root `verification.log` and includes collector/unit/database tests,
real exposition, fixed label/privacy checks, PromQL and provisioning consistency,
backlog changes, scrape purity, and native clean-stack observation readiness.

Static artifact checks require no browser or native server.
The complete clean-stack check requires the existing native installations.
No verification script installs them.

The dashboard's existence is not a claim that every graph was visually inspected.
Full protocol completion still depends on the verified chain/committee/execution
path and the final root verification result.
