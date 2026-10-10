import assert from "node:assert/strict";
import { setTimeout as pause } from "node:timers/promises";
import { createScenario } from "./fault-scenarios.mjs";
import { sourceState } from "./four-process.mjs";
import { deterministicPrimary } from "../../src/committee.mjs";
import { authenticateNewView, newViewDigest } from "../../src/view-change.mjs";
import { proposalIdentity } from "../../src/prepared-certificate.mjs";
import { validatorAccount } from "../../src/identity.mjs";
import { verifyQuorumCertificate } from "../../src/quorum-certificate.mjs";

// Poll observed durable conditions. The delay only spaces observations; it never
// declares success. The deadline is a failure watchdog, not a consensus trigger.
async function until(label, predicate) {
  const deadline = Date.now() + 30000;
  do {
    const value = await predicate();
    if (value) return value;
    await pause(25);
  } while (Date.now() < deadline);
  assert.fail(`timed out waiting for ${label}`);
}
async function armTimeout(ctx, participants) {
  for (const index of participants) {
    ctx.environments[index].PBFT_VIEW_TIMEOUT_MS = "3000";
    await ctx.stop(index); await ctx.restart(index);
  }
}
function assertLiveConsensus(ctx, participants) {
  for (const index of participants) {
    assert.equal(ctx.validators[index].exited, false, `validator ${ctx.peers[index].address} exited during recovery`);
    const halt = ctx.validators[index].stderr.split("\n").find((line) => line.startsWith("PBFT scheduler halted:"));
    assert.ok(!halt, `validator ${ctx.peers[index].address}: ${halt}`);
  }
}
async function committed(ctx, { view, minimumView = "0", participants }) {
  const snapshot = await until(`${view === undefined ? `view >= ${minimumView}` : `view ${view}`} COMMITTED`, async () => {
    assertLiveConsensus(ctx, participants);
    const value = await ctx.lifecycle.readBatch({ batchRecordId: ctx.pending.record.batchRecordId });
    return value.record.status === "COMMITTED" ? value : null;
  });
  const certificateView = snapshot.quorumCertificate.view;
  if (view !== undefined) assert.equal(certificateView, view);
  assert.ok(BigInt(certificateView) >= BigInt(minimumView), "QC must come from an eligible recovery view");
  assert.equal(snapshot.record.epoch.toString(), ctx.statement.epoch);
  assert.equal(snapshot.record.batchId, ctx.pending.record.batchId);
  assert.equal(snapshot.tree.messageRoot, ctx.pending.tree.messageRoot);
  assert.deepEqual(snapshot.members, ctx.pending.members); assert.deepEqual(snapshot.batch, ctx.pending.batch);
  assert.deepEqual(snapshot.tree, ctx.pending.tree);
  await verifyQuorumCertificate(snapshot.quorumCertificate, { peers: ctx.peers,
    expected: { ...ctx.statement, view: certificateView, proposalDigest: undefined } });
  await until("all live validators recognize final QC", async () => {
    assertLiveConsensus(ctx, participants);
    const states = await Promise.all(participants.map((index) => ctx.states[index].store.readViewStates()));
    return states.every((rows) => rows.some((row) => row.epoch === ctx.statement.epoch && row.finalized));
  });
  for (const index of participants) {
    const response = await ctx.request(index, "/pbft/qc/submit", snapshot.quorumCertificate);
    assert.equal(response.status, 200); assert.equal(response.body.qcDigest, snapshot.quorumCertificate.qcDigest);
  }
  await ctx.assertSource(true);
  return snapshot;
}
async function crashAndRecover(ctx, phase) {
  const all = [0, 1, 2, 3];
  let oldProposal = null;
  let oldPrepare = null;
  let oldCommit = null;
  if (phase !== "before") {
    await ctx.propose(all);
    oldProposal = (await ctx.states[ctx.backups[0]].store.readPrePrepare(ctx.statement.epoch, "0")).envelope;
    if (phase !== "proposal") {
      const count = phase === "partial" ? 2 : 3;
      for (const index of all.slice(0, count)) {
        const vote = await ctx.cast(index, "prepare"); oldPrepare ??= vote.record.vote;
      }
      for (const index of all) {
        const state = await ctx.states[index].store.readPrepareState(ctx.statement.epoch, "0");
        assert.equal(state.voteCount, count); assert.equal(Boolean(state.prepared), count === 3);
      }
      if (phase === "commit") for (const index of all.slice(0, 2)) {
        const vote = await ctx.cast(index, "commit"); oldCommit ??= vote.record.vote;
      }
    }
  }
  await ctx.stop(ctx.primary); await ctx.assertAlive(ctx.backups);
  const newPrimary = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, ctx.statement.epoch, "1"));
  assert.ok(ctx.backups.includes(newPrimary));
  for (const index of ctx.backups) {
    const selected = await ctx.request(index, "/pbft/primary", { epoch: ctx.statement.epoch, view: "1" });
    assert.equal(selected.body.primaryIdentity, ctx.peers[newPrimary].address);
  }
  // Stop delivery at the actual persisted VIEW_CHANGE boundary, then restart a sender.
  for (const from of ctx.backups) for (const to of ctx.backups) if (from !== to) {
    ctx.gate.blockRoute(ctx.peers[from].address, ctx.peers[to].address, "/pbft/view-change");
  }
  await armTimeout(ctx, ctx.backups);
  const voter = ctx.backups[0];
  const durable = await until("persisted local VIEW_CHANGE", async () =>
    (await ctx.states[voter].store.readViewChanges(ctx.statement.epoch, "1")).find((vote) => vote.voterIdentity === ctx.peers[voter].address));
  assert.equal(await ctx.states[voter].store.currentView(ctx.statement.epoch), "0");
  if (["prepared", "commit"].includes(phase)) {
    assert.ok(durable.preparedCertificate); assert.equal(durable.preparedCertificate.proposal.messageRoot, ctx.statement.messageRoot);
  } else assert.equal(durable.preparedCertificate, null);
  await ctx.stop(voter); await ctx.restart(voter);
  assert.deepEqual((await ctx.states[voter].store.readViewChanges(ctx.statement.epoch, "1")).find((vote) => vote.voterIdentity === ctx.peers[voter].address), durable);
  assert.equal(await ctx.states[voter].store.currentView(ctx.statement.epoch), "0");
  ctx.gate.heal();
  const result = await committed(ctx, { view: "1", participants: ctx.backups });
  assert.ok(result.quorumCertificate.commits.every((vote) => vote.voterIdentity !== ctx.peers[ctx.primary].address));
  const receiver = ctx.backups.find((index) => index !== newPrimary);
  const newView = await ctx.states[receiver].store.readNewView(ctx.statement.epoch, "1");
  assert.equal(newView.selectedProposal.messageRoot, ctx.statement.messageRoot);
  assert.equal(newView.viewChanges.length, 3);
  if (["prepared", "commit"].includes(phase)) assert.ok(newView.viewChanges.some((vote) => vote.preparedCertificate));
  for (const [route, message] of [["pre-prepare", oldProposal], ["prepare", oldPrepare], ["commit", oldCommit]]) {
    if (!message) continue;
    const response = await ctx.request(receiver, `/pbft/${route}`, message);
    assert.equal(response.status, 422); assert.equal(response.body.reason, "STALE_VIEW");
  }
  // A correctly signed NEW_VIEW with a substituted root remains invalid.
  const unsafe = { ...newView, selectedProposal: { ...newView.selectedProposal, messageRoot: `0x${"ac".repeat(32)}` } };
  unsafe.newViewDigest = newViewDigest(unsafe);
  unsafe.signature = await validatorAccount(ctx.keys[newPrimary]).signMessage({ message: { raw: unsafe.newViewDigest } });
  const rejected = await ctx.request(receiver, "/pbft/new-view", unsafe);
  assert.equal(rejected.status, 422); assert.equal(rejected.body.reason, "UNSAFE_SELECTED_PROPOSAL");
  await ctx.assertSource(true, unsafe.selectedProposal.messageRoot);
  await ctx.stop(receiver); await ctx.restart(receiver);
  assert.equal(await ctx.states[receiver].store.currentView(ctx.statement.epoch), "1");
  assert.deepEqual(await ctx.states[receiver].store.readNewView(ctx.statement.epoch, "1"), newView);
  console.log(`VALID: primary OS process crash (${phase}) recovered via signed timeout quorum and NEW_VIEW; history, restarted intent, safe root, and final QC retained`);
}
function holdCommits(ctx) {
  for (const from of ctx.peers) for (const to of ctx.peers) if (from.address !== to.address) {
    ctx.gate.blockRoute(from.address, to.address, "/pbft/commit");
  }
}
async function waitEntered(ctx, view, participants) {
  await until(`durable NEW_VIEW ${view} on every designated live node`, async () => {
    assertLiveConsensus(ctx, participants);
    const states = await Promise.all(participants.map((index) => ctx.states[index].store.readViewStates()));
    return states.every((rows) => rows.some((row) => row.epoch === ctx.statement.epoch && row.current_view === view));
  });
  assert.equal((await ctx.lifecycle.readBatch({ batchRecordId: ctx.pending.record.batchRecordId })).record.status, "CONSENSUS_PENDING");
}

async function repeated(ctx) {
  const epoch = ctx.statement.epoch;
  const one = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, epoch, "1"));
  const two = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, epoch, "2"));
  holdCommits(ctx);
  await ctx.stop(ctx.primary);
  // New primary can publish NEW_VIEW, but its PRE-PREPARE delivery stalls.
  for (const peer of ctx.peers) if (peer.address !== ctx.peers[one].address) ctx.gate.blockRoute(ctx.peers[one].address, peer.address, "/pbft/pre-prepare");
  await armTimeout(ctx, ctx.backups);
  const message = await until("first accepted NEW_VIEW", () => ctx.states[one].store.readNewView(epoch, "1"));
  assert.equal(message.primaryIdentity, ctx.peers[one].address);
  // Return the original process so the second transition never assumes two faults.
  ctx.environments[ctx.primary].PBFT_VIEW_TIMEOUT_MS = "3000";
  await ctx.restart(ctx.primary);
  assert.notEqual(one, two);
  await waitEntered(ctx, "2", [0, 1, 2, 3]);
  assert.ok(ctx.peerProxies.some((proxy) => proxy.records.some((record) =>
    record.from === ctx.peers[one].address && record.route === "/pbft/pre-prepare" && record.blocked)));
  ctx.gate.heal();
  const result = await committed(ctx, { view: "2", participants: [0, 1, 2, 3] });
  assert.equal(result.record.batchId, ctx.pending.record.batchId);
  const second = await ctx.states[two].store.readNewView(epoch, "2");
  assert.equal(second.primaryIdentity, ctx.peers[two].address);
  for (const index of [0, 1, 2, 3]) assert.equal(await ctx.states[index].store.currentView(epoch), "2");
  await ctx.stop(two); await ctx.restart(two);
  assert.equal(await ctx.states[two].store.currentView(epoch), "2");
  assert.deepEqual(await ctx.states[two].store.readNewView(epoch, "2"), second);
  console.log("VALID: failed initial primary and stalled replacement advanced through views 1 and 2 with the same batch/root and durable monotonic restart state");
}
async function lostNewView(ctx) {
  const epoch = ctx.statement.epoch;
  const one = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, epoch, "1"));
  const lag = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, epoch, "2"));
  holdCommits(ctx);
  await ctx.stop(ctx.primary);
  ctx.gate.blockRoute(ctx.peers[one].address, ctx.peers[lag].address, "/pbft/new-view");
  await armTimeout(ctx, ctx.backups);
  const original = await until("published NEW_VIEW with one missed backup", () => {
    assertLiveConsensus(ctx, ctx.backups);
    return ctx.states[one].store.readNewView(epoch, "1");
  });
  for (const from of ctx.backups) for (const to of ctx.backups) if (from !== to) {
    ctx.gate.blockRoute(ctx.peers[from].address, ctx.peers[to].address, "/pbft/view-change");
  }
  const timedOut = await until("original new primary timed out while backup still lagged", async () => {
    assertLiveConsensus(ctx, ctx.backups);
    const rows = await ctx.states[one].store.readViewStates();
    return rows.find((row) => row.epoch === epoch && row.current_view === "1" && row.changing_view && BigInt(row.target_view) >= 2n);
  });
  const intents = await ctx.states[one].store.readViewChanges(epoch, timedOut.target_view);
  assert.ok(intents.some((vote) => vote.voterIdentity === ctx.peers[one].address), "timeout must have a durable signed local intent");
  assert.equal(await ctx.states[lag].store.currentView(epoch), "0");
  ctx.gate.allowRoute(ctx.peers[one].address, ctx.peers[lag].address, "/pbft/new-view");
  const replayed = await until("persisted NEW_VIEW replay reached the lagging backup", () => {
    assertLiveConsensus(ctx, ctx.backups);
    return ctx.states[lag].store.readNewView(epoch, "1");
  });
  assert.deepEqual(replayed, original, "recovery must replay the exact durable NEW_VIEW");
  await authenticateNewView(ctx.states[lag].config, replayed, proposalIdentity(ctx.statement));
  assert.ok(ctx.peerProxies.some((proxy) => proxy.records.some((record) => record.from === ctx.peers[one].address &&
    record.to === ctx.peers[lag].address && record.route === "/pbft/new-view" && record.delivery === "BLOCKED")),
  "the scenario must actually lose a NEW_VIEW delivery");
  assert.equal((await ctx.lifecycle.readBatch({ batchRecordId: ctx.pending.record.batchRecordId })).record.status, "CONSENSUS_PENDING");
  // Timers keep running while delivery is blocked. Healing must restore actual
  // consensus, without requiring every node to stop at the first target view.
  ctx.gate.heal();
  const result = await committed(ctx, { minimumView: "2", participants: ctx.backups });
  const qc = result.quorumCertificate;
  assert.equal(qc.commits.length, 3);
  assert.ok(qc.commits.every((vote) => vote.voterIdentity !== ctx.peers[ctx.primary].address));
  for (const vote of qc.commits) {
    const index = ctx.peers.findIndex((peer) => peer.address === vote.voterIdentity);
    const evidence = await ctx.states[index].store.readNewView(epoch, qc.view);
    assert.ok(evidence, "each QC signer must retain its accepted NEW_VIEW for the signing view");
    await authenticateNewView(ctx.states[index].config, evidence, proposalIdentity(ctx.statement));
  }
  assert.deepEqual(await ctx.states[lag].store.readNewView(epoch, "1"), original);
  console.log(`VALID: exact delayed NEW_VIEW replayed after timeout; healed live validators committed one safe root with a three-signer view ${qc.view} QC`);
}

async function unpublishedPrimary(ctx) {
  const epoch = ctx.statement.epoch;
  const one = ctx.peers.findIndex((peer) => peer.address === deterministicPrimary(ctx.peers, epoch, "1"));
  holdCommits(ctx);
  await ctx.stop(ctx.primary);
  await ctx.restart(ctx.primary); // Return the original identity before stopping its replacement.
  await ctx.stop(one);
  const live = [0, 1, 2, 3].filter((index) => index !== one);
  await ctx.assertAlive(live);
  await armTimeout(ctx, live);
  await until("three intents for an unavailable candidate primary", async () => {
    const votes = await Promise.all(live.map((index) => ctx.states[index].store.readViewChanges(epoch, "1")));
    return votes.every((entries) => entries.length === 3);
  });
  for (const index of live) {
    assert.equal(await ctx.states[index].store.currentView(epoch), "0");
    assert.equal(await ctx.states[index].store.readNewView(epoch, "1"), null);
  }
  await waitEntered(ctx, "2", live);
  ctx.gate.heal();
  const result = await committed(ctx, { view: "2", participants: live });
  assert.ok(result.quorumCertificate.commits.every((vote) => vote.voterIdentity !== ctx.peers[one].address));
  console.log("VALID: unavailable candidate never published NEW_VIEW; durable next-target quorum activated view 2 without changing batch/root or exceeding one offline process");
}

async function reportRecoveryState(ctx) {
  const epoch = ctx.statement.epoch;
  console.error(`Recovery diagnostics before cleanup: epoch=${epoch}`);
  for (let index = 0; index < ctx.states.length; index++) {
    const { store } = ctx.states[index];
    const process = ctx.validators[index];
    console.error(JSON.stringify({ validator: ctx.peers[index].address, pid: process.child.pid, exited: process.exited,
      schedulerHalt: process.stderr.split("\n").find((line) => line.startsWith("PBFT scheduler halted:")) ?? null }));
    try {
      const state = (await store.readViewStates()).find((row) => row.epoch === epoch);
      if (!state) { console.error("No local epoch state"); continue; }
      console.error(JSON.stringify({ currentView: state.current_view, targetView: state.target_view,
        changingView: state.changing_view, finalized: state.finalized, progressRevision: state.progress_revision,
        progressAt: state.progress_at, viewChangeAt: state.view_change_at }));
      const reads = [
        ["certifiedTargets", () => store.readViewChangeTargets(epoch)],
        ["pendingIntentSigners", async () => (await store.readViewChanges(epoch, state.target_view)).map((vote) => vote.voterIdentity)],
        ["activeNewView", async () => {
          const message = await store.readNewView(epoch, state.current_view);
          return message ? { view: message.view, primary: message.primaryIdentity, signers: message.viewChanges.map((vote) => vote.voterIdentity) } : null;
        }],
        ["activeCommit", async () => {
          const result = await store.readCommitState(epoch, state.current_view);
          return { voteCount: result.voteCount, hasQuorum: Boolean(result.quorum), hasCertificate: Boolean(result.certificate) };
        }],
      ];
      for (const [label, read] of reads) {
        try { console.error(JSON.stringify({ [label]: await read() })); }
        catch (error) { console.error(`${label} unavailable (${error.code ?? error.name})`); }
      }
    } catch (error) { console.error(`Local recovery state unavailable (${error.code ?? error.name})`); }
  }
  try {
    const snapshot = await ctx.lifecycle.readBatch({ batchRecordId: ctx.pending.record.batchRecordId });
    console.error(JSON.stringify({ sourceStatus: snapshot.record.status, qcView: snapshot.quorumCertificate?.view ?? null }));
  } catch (error) { console.error(`Source recovery state unavailable (${error.code ?? error.name})`); }
}

export async function verifyViewChanges({ sourceConfig, sourcePool, snapshot, pidFile }) {
  const original = await sourceState(sourcePool, sourceConfig.databaseSchema);
  const orphanIds = new Set(original.source_messages.filter((row) => row.status === "REORGED").map((row) => row.message_id));
  assert.ok(orphanIds.size);
  const phases = ["before", "proposal", "partial", "prepared", "commit", "repeated", "lost_new_view", "unpublished_primary"];
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index];
    const ctx = await createScenario({ name: `view_${phase}`, epoch: snapshot.record.epoch + BigInt(10 + index),
      sourceConfig, template: snapshot, orphanIds, pidFile });
    let failed = false;
    try {
      if (phase === "repeated") await repeated(ctx);
      else if (phase === "lost_new_view") await lostNewView(ctx);
      else if (phase === "unpublished_primary") await unpublishedPrimary(ctx);
      else await crashAndRecover(ctx, phase);
    }
    catch (error) {
      failed = true;
      console.error(`VIEW RECOVERY FAILED (${phase}): ${error.message}`);
      await reportRecoveryState(ctx);
      throw error;
    }
    finally {
      try { await ctx.close(); }
      catch (error) {
        if (!failed) throw error;
        console.error(`Cleanup also failed: ${error.message}`);
      }
    }
    assert.deepEqual(await sourceState(sourcePool, sourceConfig.databaseSchema), original);
  }
  console.log("VALID: all view-change cases preserved original committed QC, REORGED C, Message E, memberships, proofs, cursor and canonical source history");
}
