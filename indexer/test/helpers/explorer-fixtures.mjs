import { queryProjectionFixture } from "./message-query-fixtures.mjs";
import { projectMessageLifecycle } from "../../src/api/message-query.mjs";
import { deliveryJson } from "../../src/delivery/package.mjs";

export async function explorerFixture(version = "3") {
  const data = await queryProjectionFixture(version);
  data.config.identityApplicationAddress = data.source.source_sender;
  const qc = data.snapshot.quorumCertificate;
  const committee = data.config.validatorSets.history[0];
  data.consensus = { pbft: { status: "COMMITTED", protocolVersion: version,
    validatorEpoch: qc.validatorEpoch ?? null, view: qc.view ?? null, committeeDigest: qc.committeeDigest,
    committee: committee.validators, committeeSize: 4, quorum: 3, primary: committee.validators[0],
    observations: committee.validators.map(validator => ({ validator, view: qc.view ?? null, currentView: qc.view ?? null,
      status: qc.commits.some(vote => vote.voterIdentity === validator) ? "COMMIT_QUORUM" : "NO_PROPOSAL",
      ownPrepare: false, ownCommit: qc.commits.some(vote => vote.voterIdentity === validator) })) },
  validatorVotes: qc.commits.map(vote => ({ phase: "COMMIT", signer: vote.voterIdentity, protocolVersion: version,
    epoch: vote.epoch, view: vote.view ?? null, validatorEpoch: vote.validatorEpoch ?? null, batchId: vote.batchId,
    messageRoot: vote.messageRoot, committeeDigest: qc.committeeDigest, proposalDigest: vote.proposalDigest,
    digest: vote.commitDigest, signature: vote.signature, observedBy: [vote.voterIdentity] })) };
  return { data, body: JSON.parse(deliveryJson(projectMessageLifecycle(data))) };
}

// A text-only DOM sink tests the actual renderer without a browser dependency.
// Markup APIs deliberately throw, so an unsafe renderer cannot pass silently.
export function textDocument() {
  class Element {
    constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.value = ""; this.listeners = new Map(); }
    set textContent(value) { this.value = String(value); this.children = []; }
    get textContent() { return this.value + this.children.map(child => child.textContent).join("\n"); }
    set innerHTML(value) { throw new Error("Markup assignment is forbidden"); }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.value = ""; this.children = children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    addEventListener(type, listener) { const values = this.listeners.get(type) ?? new Set(); values.add(listener); this.listeners.set(type, values); }
    removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
    dispatch(type, options = {}) {
      const event = { button: 0, currentTarget: this, preventDefault() { this.defaultPrevented = true; }, ...options };
      for (const listener of this.listeners.get(type) ?? []) listener(event);
      return event;
    }
    focus() { this.focused = true; }
  }
  return { createElement(tag) { return new Element(tag); } };
}
