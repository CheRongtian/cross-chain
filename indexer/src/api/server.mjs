import { createServer } from "node:http";
import { deliveryJson } from "../delivery/package.mjs";
import { normalizeBytes32 } from "../canonical-message.mjs";
import { MessageQueryError, publicQueryError } from "./errors.mjs";
import { explorerHeaders, isExplorerPath, readExplorerAsset } from "./static-assets.mjs";
import { processMetrics } from "../metrics/registry.mjs";
import { serveMetrics } from "../metrics/http.mjs";

export function createMessageQueryServer({ config, query, metrics = processMetrics }) {
  const server = createServer(async (request, response) => {
    const send = (status, value, headers = {}) => {
      const body = deliveryJson(value);
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      response.end(body);
    };
    try {
      if (await serveMetrics(request, response, metrics)) return;
      const path = request.url.split("?", 1)[0];
      if (isExplorerPath(path)) {
        if (!["GET", "HEAD"].includes(request.method)) return send(405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET, HEAD" });
        const asset = await readExplorerAsset(path);
        response.writeHead(200, { ...explorerHeaders, "content-type": asset.contentType, "content-length": asset.body.length });
        return response.end(request.method === "HEAD" ? undefined : asset.body);
      }
      if (request.method !== "GET") return send(405, { error: "METHOD_NOT_ALLOWED" }, { allow: "GET" });
      const match = /^\/api\/v1\/messages\/([^/?]*)$/.exec(request.url);
      if (!match) return send(404, { error: "ENDPOINT_NOT_FOUND" });
      let id;
      try { id = normalizeBytes32(match[1], "message ID"); }
      catch { throw new MessageQueryError("INVALID_MESSAGE_ID", 400); }
      return send(200, await query.getMessageLifecycle(id));
    } catch (error) {
      if (response.destroyed) return;
      const safe = publicQueryError(error); send(safe.status, safe.body);
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  return { server, async listen() {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.listenPort, config.listenHost, () => { server.removeListener("error", reject); resolve(); });
    });
  }, async close() {
    if (!server.listening) return;
    const closed = new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    server.closeAllConnections(); await closed;
  } };
}
