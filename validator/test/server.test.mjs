import assert from "node:assert/strict";
import test from "node:test";
import { createValidatorServer, MAX_REQUEST_BYTES } from "../src/server.mjs";
import { configuration } from "./helpers/fixtures.mjs";

test("HTTP inputs are bounded/reference-only; public identity has no secret; readiness is truthful", async () => {
  const config = { ...configuration(), listenPort: 0 };
  const requested = [];
  let available = true;
  const runtime = createValidatorServer({ config,
    service: { async validate(batchId) { requested.push(batchId); return { result: "VALID", batchId }; } },
    store: { async readObservations() { return []; } },
    checkReady: async () => { if (!available) throw new Error("database unavailable"); },
  });
  await runtime.listen();
  const url = `http://127.0.0.1:${runtime.server.address().port}`;
  async function post(route, body) {
    return fetch(`${url}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body,
      signal: AbortSignal.timeout(5000) });
  }
  try {
    const identityText = await (await fetch(`${url}/identity`)).text();
    assert.ok(!identityText.includes(config.privateKey));
    assert.ok(!identityText.includes("databaseUrl"));
    const health = await (await fetch(`${url}/health`)).json();
    assert.equal(health.alive, true); assert.equal(health.ready, true);
    available = false;
    const unavailable = await fetch(`${url}/health`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).ready, false);
    available = true;
    const batchId = `0x${"ab".repeat(32)}`;
    assert.equal((await post("/validate-batch", JSON.stringify({ batchId }))).status, 200);
    assert.deepEqual(requested, [batchId]);
    for (const body of ["{", "[]", "null", JSON.stringify({ batchId: "0x00" }), JSON.stringify({ batchId, root: batchId })]) {
      assert.equal((await post("/validate-batch", body)).status, 400);
    }
    assert.equal((await post("/validate-batch", "x".repeat(MAX_REQUEST_BYTES + 1))).status, 400);
    assert.equal((await post("/handshake", JSON.stringify({ requesterAddress: config.peers[1].address, challenge: "0x00" }))).status, 400);
    assert.equal((await post("/handshake", JSON.stringify({ requesterAddress: "0x0000000000000000000000000000000000009999", challenge: batchId }))).status, 400);
    assert.equal((await post("/connect-peer", JSON.stringify({ peerAddress: config.validatorAddress }))).status, 400);
    const signed = await post("/handshake", JSON.stringify({ requesterAddress: config.peers[1].address, challenge: batchId }));
    assert.equal(signed.status, 200);
    assert.ok(!(await signed.text()).includes(config.privateKey));
    assert.deepEqual(requested, [batchId]);
  } finally { await runtime.close(); }
});
