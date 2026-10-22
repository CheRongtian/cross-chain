import assert from "node:assert/strict";
import { createRelayerCheckpoint } from "../lib/relayer-polling.mjs";

// Acknowledged pauses and one-shot target barriers live only in the script
// layer. Waiting at afterPrepared leaves the production lease renewer running.
export function createWorkerControl({ isolated,identity }) {
  let paused = false; let inFlight; let armed; let blocked; let release; let cancel;
  const errors = [];
  const counts = { preparations: 0,signatures: 0,estimates: 0,feeQuotes: 0 };
  const allowed = () => assert.equal(isolated,true,"fault control requires verification ownership");
  const status = () => ({ ...identity,pid: process.pid,paused,blocked,errors: [...errors],counts: { ...counts } });
  return {
    counts,
    recordError(error) {
      if (error.code !== "RPC_UNAVAILABLE") throw error;
      errors.push({ code: error.code,observations: (error.observations ?? []).map(value =>
        ({ endpointLabel: value.endpointLabel,outcome: value.outcome,errorClass: value.errorClass })) });
      if (errors.length > 64) errors.shift();
    },
    async checkpoint(name,{ id,...evidence }) {
      if (!armed || armed.id !== id || !armed.shouldPause(name)) return;
      assert.equal(blocked,undefined);
      const waiting = new Promise((resolve,reject) => { release = resolve; cancel = reject; });
      blocked = { name,id,...evidence };
      try { await waiting; } finally { blocked = undefined; release = undefined; cancel = undefined; }
    },
    close() { cancel?.(new Error("Local worker control stopped")); },
    handlers: {
      status,
      async pause() { allowed(); paused = true; await inFlight; return status(); },
      async arm({ id }) {
        allowed(); assert.equal(paused,true); assert.equal(inFlight,undefined); assert.equal(blocked,undefined);
        armed = { id,shouldPause: createRelayerCheckpoint({ mode: "leased-recovery-poll",checkpoint: "signed-persisted" }) };
        return status();
      },
      async resume() { allowed(); paused = false; release?.(); return { resumed: true }; },
      async clear() { allowed(); armed = undefined; release?.(); paused = false; return { cleared: true }; },
    },
    async run(pass) {
      if (paused) return;
      assert.equal(inFlight,undefined);
      inFlight = pass();
      try { await inFlight; } finally { inFlight = undefined; }
    },
  };
}
