import { createServer } from "node:http";
import { normalizeAddress, normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";
import { connectPeer, signHandshake } from "./handshake.mjs";
import { publicIdentity } from "./identity.mjs";

export const MAX_REQUEST_BYTES = 4096;
class InputError extends Error {}

async function readBody(request, keys) {
  if (request.headers["content-type"]?.split(";")[0].trim() !== "application/json") throw new InputError("JSON content type required");
  if (request.headers["content-length"] !== undefined && Number(request.headers["content-length"]) > MAX_REQUEST_BYTES) {
    throw new InputError("request body too large");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw new InputError("request body too large");
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw new InputError("malformed JSON"); }
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).sort().join(",") !== [...keys].sort().join(",")) {
    throw new InputError("unexpected request fields");
  }
  return body;
}

export function createValidatorServer({ config, service, store, authenticatePeer = connectPeer, checkReady = async () => {}, logger = console }) {
  let ready = true;
  const server = createServer(async (request, response) => {
    function send(status, body) {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    }
    try {
      if (request.method === "GET" && request.url === "/health") {
        let available = ready;
        if (available) {
          try { await checkReady(); } catch { available = false; }
        }
        return send(available ? 200 : 503, { alive: true, ready: available, pid: process.pid, validatorAddress: config.validatorAddress });
      }
      if (request.method === "GET" && request.url === "/identity") return send(200, publicIdentity(config));
      if (!ready) return send(503, { error: "validator is stopping" });
      if (request.method === "GET" && request.url === "/observations") return send(200, { observations: await store.readObservations() });
      if (request.method === "POST" && request.url === "/handshake") {
        const body = await readBody(request, ["requesterAddress", "challenge"]);
        let requester;
        try { requester = normalizeAddress(body.requesterAddress); normalizeBytes32(body.challenge); }
        catch { throw new InputError("invalid handshake identity or challenge"); }
        if (requester === config.validatorAddress || !config.peers.some((peer) => peer.address === requester)) {
          throw new InputError("unknown or self handshake requester");
        }
        return send(200, await signHandshake(config, body.challenge));
      }
      if (request.method === "POST" && request.url === "/connect-peer") {
        const body = await readBody(request, ["peerAddress"]);
        let address;
        try { address = normalizeAddress(body.peerAddress); } catch { throw new InputError("invalid peer identity"); }
        if (address === config.validatorAddress || !config.peers.some((peer) => peer.address === address)) throw new InputError("unknown or self validator peer");
        return send(200, await authenticatePeer(config, address));
      }
      if (request.method === "POST" && request.url === "/validate-batch") {
        const body = await readBody(request, ["batchId"]);
        let batchId;
        try { batchId = normalizeBytes32(body.batchId, "batch ID"); } catch { throw new InputError("invalid batch ID"); }
        const result = await service.validate(batchId);
        return send(result.result === "VALID" ? 200 : 422, result);
      }
      send(404, { error: "unknown validator endpoint" });
    } catch (error) {
      if (response.destroyed) return;
      // Internal database/RPC errors and configuration secrets are never reflected over HTTP.
      if (!(error instanceof InputError)) {
        let message = error.message;
        for (const secret of [config.privateKey, config.databaseUrl, config.sourceDatabaseUrl]) {
          if (secret) message = message.replaceAll(secret, "<redacted>");
        }
        logger.error(`Validator operation failed closed: ${message}`);
      }
      send(error instanceof InputError ? 400 : 503,
        { error: error instanceof InputError ? error.message : "validator operation failed closed" });
    }
  });
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  return {
    server,
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.listenPort, config.listenHost, () => { server.removeListener("error", reject); resolve(); });
      });
    },
    async close() {
      ready = false;
      if (!server.listening) return;
      const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
