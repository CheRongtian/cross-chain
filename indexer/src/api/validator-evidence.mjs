import { isDeepStrictEqual } from "node:util";
import { createValidatorStore } from "../../../validator/src/db.mjs";
import { authenticatePrePrepare } from "../../../validator/src/pre-prepare.mjs";
import { authenticatePrepare } from "../../../validator/src/prepare.mjs";
import { authenticateCommit } from "../../../validator/src/commit.mjs";
import { deterministicPrimary } from "../../../validator/src/committee.mjs";
import { evidenceRead, inconsistent, MessageQueryError } from "./errors.mjs";
import { readSnapshot } from "./read-snapshot.mjs";

export async function readValidatorEvidence({ config, readers, snapshot }) {
  const record = snapshot.record;
  const qc = snapshot.quorumCertificate;
  let version = qc?.protocolVersion ?? snapshot.consensusBinding?.protocolVersion;
  const peers = [...new Set(config.validatorSets.history.flatMap(set => set.validators))].map(address => ({ address }));
  async function load(identity, view) {
    const reader = readers.find(value => value.config.validatorAddress === identity);
    if (!reader) throw new MessageQueryError("VALIDATOR_EVIDENCE_UNAVAILABLE", 503);
    const publicConfig = { databaseSchema: reader.config.databaseSchema, validatorAddress: identity,
      validatorSets: config.validatorSets, peers, chainDomain: config.chainDomain,
      sourceGateway: config.sourceGateway, finalityBlockDepth: config.finalityBlockDepth, allowHistorical: true };
    const store = createValidatorStore({ config: publicConfig, pool: reader.pool });
    const result = await evidenceRead(() => readSnapshot(reader.pool, client => store.readConsensusObservation({ epoch: record.epoch, view }, client)));
    return { result, publicConfig };
  }
  // Historical in-flight consensus can predate source-side bindings. Derive
  // its version only from actual local evidence, never from the latest set.
  const legacyReads = new Map();
  if (!version && record.status === "CONSENSUS_PENDING") {
    const versions = new Set();
    for (const identity of config.validatorSets.history[0].validators) {
      const read = await load(identity); legacyReads.set(identity, read);
      const actual = read.result.proposal?.envelope.protocolVersion ?? (read.result.state ? String(read.result.state.protocol_version) : null);
      if (actual) versions.add(actual);
    }
    if (versions.size > 1 || versions.has("3")) throw inconsistent();
    version = [...versions][0];
  }
  if (!version) return { pbft: { status: record.status, validatorEpoch: null, committee: null, observations: [] }, validatorVotes: [] };
  const selected = version === "3" ? config.validatorSets.resolveForBatchEpoch(record.epoch) : config.validatorSets.history[0];
  const observations = []; const votes = new Map();
  for (const identity of selected.validators) {
    const { result, publicConfig } = legacyReads.get(identity) ?? await load(identity, qc?.view ?? (version === "1" ? "0" : undefined));
    const view = qc?.view ?? result.state?.current_view ?? "0";
    if (result.state && (result.state.batch_id !== record.batchId || result.state.message_root !== record.messageRoot ||
      String(result.state.protocol_version) !== version || (version === "3" &&
      (result.state.validator_epoch !== selected.validatorEpoch || result.state.committee_digest !== selected.committeeDigest)))) throw inconsistent();
    const context = input => {
      if (input.protocolVersion !== version || input.epoch !== record.epoch.toString() || (input.view ?? "0") !== view ||
        input.batchId !== record.batchId || input.messageRoot !== record.messageRoot ||
        input.sourceDomain !== config.chainDomain.toString() || input.sourceGateway !== config.sourceGateway ||
        (version === "3" && (input.validatorEpoch !== selected.validatorEpoch || input.committeeDigest !== selected.committeeDigest))) throw inconsistent();
    };
    const actual = result.proposal?.envelope;
    if (actual) { context(actual); await evidenceRead(() => authenticatePrePrepare(publicConfig, actual)); }
    for (const [phase, entries, authenticate] of [["PREPARE", result.prepares.votes, authenticatePrepare], ["COMMIT", result.commits.votes, authenticateCommit]]) {
      for (const input of entries) {
        context(input); await evidenceRead(() => authenticate(publicConfig, input));
        if (!actual || input.proposalDigest !== actual.proposalDigest || !selected.validators.includes(input.voterIdentity)) throw inconsistent();
        const digest = phase === "PREPARE" ? input.prepareDigest : input.commitDigest;
        const vote = { phase, signer: input.voterIdentity, protocolVersion: version, epoch: input.epoch,
          view: input.view ?? null, validatorEpoch: input.validatorEpoch ?? null, batchId: input.batchId,
          messageRoot: input.messageRoot, committeeDigest: input.committeeDigest ?? selected.committeeDigest,
          proposalDigest: input.proposalDigest, digest, signature: input.signature, observedBy: [] };
        const key = `${phase}:${view}:${input.voterIdentity}`;
        const old = votes.get(key);
        if (old && !isDeepStrictEqual({ ...old, observedBy: [] }, vote)) throw inconsistent();
        const stored = old ?? vote; stored.observedBy.push(identity); votes.set(key, stored);
      }
    }
    observations.push({ validator: identity, view: version === "1" ? null : view,
      currentView: result.state?.current_view ?? null,
      targetView: result.state?.target_view ?? null, changingView: result.state?.changing_view ?? false,
      status: result.commits.quorum ? "COMMIT_QUORUM" : result.prepares.prepared ? "PREPARED" : actual ? "PRE_PREPARE" : "NO_PROPOSAL",
      proposalDigest: actual?.proposalDigest ?? null,
      ownPrepare: result.prepares.votes.some(vote => vote.voterIdentity === identity),
      ownCommit: result.commits.votes.some(vote => vote.voterIdentity === identity) });
  }
  // A QC's votes remain available even when its submitting process is offline;
  // configured stores are observed separately and are never backfilled.
  if (qc) for (const commit of qc.commits) {
    const vote = votes.get(`COMMIT:${qc.view ?? "0"}:${commit.voterIdentity}`);
    if (!vote || vote.digest !== commit.commitDigest || vote.proposalDigest !== qc.proposalDigest) throw inconsistent();
  }
  const observedViews = [...new Set(observations.map(value => value.currentView ?? value.view).filter(value => value !== null))];
  const observedView = qc ? qc.view ?? null : observedViews.length === 1 ? observedViews[0] : null;
  return { pbft: { status: record.status, protocolVersion: version, validatorEpoch: version === "3" ? selected.validatorEpoch : null,
    view: observedView, committeeDigest: selected.committeeDigest, committee: selected.validators,
    primary: qc || observedView !== null ? deterministicPrimary(selected.validators, record.epoch, observedView ?? "0") : null,
    committeeSize: 4, faultTolerance: 1, quorum: 3, observations }, validatorVotes: [...votes.values()] };
}
