import { createServer } from "node:http";
import { MAX_REQUEST_BYTES } from "../../src/server.mjs";

// Verification-only transport state. It never changes protocol messages or persisted votes.
export function createTransportGate(identities) {
  const committee = new Set(identities);
  if (committee.size !== 4 || identities.length !== 4) throw new Error("fault gate requires four distinct identities");
  const blocked = new Map();
  const blockedRoutes = new Set();
  function check(from, to) {
    if (!committee.has(from) || !committee.has(to) || from === to) throw new Error("unknown or self transport edge");
  }
  function block(from, to) {
    check(from, to);
    if (!blocked.has(from)) blocked.set(from, new Set());
    blocked.get(from).add(to);
  }
  return {
    block,
    blockRoute(from, to, route) { check(from, to); blockedRoutes.add(`${from}:${to}:${route}`); },
    allowRoute(from, to, route) { check(from, to); blockedRoutes.delete(`${from}:${to}:${route}`); },
    isBlocked(from, to, route) { check(from, to); return (blocked.get(from)?.has(to) ?? false) || blockedRoutes.has(`${from}:${to}:${route}`); },
    heal() { blocked.clear(); blockedRoutes.clear(); },
    partition(groups) {
      if (!Array.isArray(groups) || groups.length !== 2 || groups.some((group) => !Array.isArray(group) || group.length !== 2) ||
          new Set(groups.flat()).size !== 4 || groups.flat().some((identity) => !committee.has(identity))) {
        throw new Error("partition must contain two disjoint groups of two committee identities");
      }
      blocked.clear(); blockedRoutes.clear();
      for (const from of groups[0]) for (const to of groups[1]) { block(from, to); block(to, from); }
    },
  };
}

// One proxy belongs to one directed edge, so sender identity never comes from untrusted body fields.
export async function createPeerProxy({ from, to, targetUrl, gate, signal, fetchImplementation = fetch }) {
  const records = [];
  const requests = new Set();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    requests.add(controller);
    const record = { from, to, route: request.url, blocked: gate.isBlocked(from, to, request.url), delivery: "PENDING" };
    records.push(record);
    try {
      if (record.blocked) {
        request.resume();
        record.delivery = "BLOCKED";
        response.writeHead(503, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "verification transport edge blocked" }));
        return;
      }
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_REQUEST_BYTES) throw new Error("proxy request body too large");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const remote = await fetchImplementation(`${targetUrl}${request.url}`, {
        method: request.method,
        headers: { "content-type": request.headers["content-type"] ?? "application/json", connection: "close" },
        body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
        signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(5000)]),
      });
      const output = Buffer.from(await remote.arrayBuffer());
      record.delivery = "FORWARDED";
      response.writeHead(remote.status, { "content-type": remote.headers.get("content-type") ?? "application/json" });
      response.end(output);
    } catch {
      record.delivery = "FAILED";
      if (!response.destroyed) { response.writeHead(502, { "content-type": "application/json" }); response.end(JSON.stringify({ error: "verification peer forwarding failed" })); }
    } finally { requests.delete(controller); }
  });
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  } catch (error) { server.close(); throw error; }
  let closing;
  return { records, url: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (!closing) closing = (async () => {
        for (const controller of requests) controller.abort();
        if (!server.listening) return;
        const closed = new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        server.closeAllConnections(); await closed;
      })();
      return closing;
    },
  };
}
