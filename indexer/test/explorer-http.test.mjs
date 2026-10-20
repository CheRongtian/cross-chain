import assert from "node:assert/strict";
import { test } from "node:test";
import { createMessageQueryServer } from "../src/api/server.mjs";
import { verifyExplorerAssets, verifyExplorerMessage, explorerAssetPaths } from "./helpers/explorer-integration.mjs";
import { explorerFixture } from "./helpers/explorer-fixtures.mjs";

test("real loopback server serves only allowlisted local Explorer assets while preserving independent API semantics", async () => {
  const { data, body } = await explorerFixture(); const calls = [];
  const runtime = createMessageQueryServer({ config: { listenHost: "127.0.0.1", listenPort: 0 }, query: {
    async getMessageLifecycle(id) { calls.push(id); return body; },
  } });
  await runtime.listen(); const origin = `http://127.0.0.1:${runtime.server.address().port}`;
  try {
    await verifyExplorerAssets(origin); assert.equal(calls.length, 0);
    for (const path of ["/", ...explorerAssetPaths]) {
      const response = await fetch(origin + path, { method: "HEAD" }); assert.equal(response.status, 200); assert.equal(await response.text(), "");
      assert.ok(response.headers.get("content-security-policy").includes("connect-src 'self'"));
      assert.equal((await fetch(origin + path, { method: "POST" })).status, 405);
    }
    for (const path of ["/../README.md", "/%2e%2e/README.md", "/assets/explorer/%2e%2e%2fREADME.md", "/assets/explorer/../../.env",
      "/.env", "/README.md", "/assets/explorer/", "/assets/explorer/not-allowlisted.js"]) {
      const response = await fetch(origin + path); assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "ENDPOINT_NOT_FOUND" });
    }
    assert.equal(calls.length, 0);
    await verifyExplorerMessage({ origin, body, source: data.source, expectedAuthorization: "AUTHORIZED" });
    assert.deepEqual(calls, [body.message.messageId]);
    const api = `${origin}/api/v1/messages/${body.message.messageId}`;
    assert.equal((await fetch(api, { method: "HEAD" })).status, 405);
    assert.equal((await fetch(`${origin}/api/v1/messages/0x01`)).status, 400);
    const response = await fetch(api); assert.equal(response.headers.get("content-type"), "application/json");
    assert.deepEqual(await response.json(), body);
  } finally { await runtime.close(); }
});
