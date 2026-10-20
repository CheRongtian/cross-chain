import { createServer } from "node:http";
import { deliveryJson } from "../delivery/package.mjs";
import { normalizeBytes32 } from "../canonical-message.mjs";
import { MessageQueryError, publicQueryError } from "./errors.mjs";

export function createMessageQueryServer({ config, query }) {
  const server = createServer(async (request, response) => {
    const send = (status, value, headers = {}) => {
      const body = deliveryJson(value);
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
      response.end(body);
    };
    try {
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
