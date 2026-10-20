import { createServer } from "node:http";
import { processMetrics } from "./registry.mjs";

export async function serveMetrics(request, response, metrics = processMetrics) {
  if (request.url !== "/metrics") return false;
  try {
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { allow: "GET, HEAD", "content-type": "text/plain; charset=utf-8" }); response.end("Method not allowed\n"); return true;
    }
    const body = await metrics.registry.metrics();
    if (!response.destroyed) {
      response.writeHead(200, { "content-type": metrics.registry.contentType, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(request.method === "HEAD" ? undefined : body);
    }
  } catch {
    if (!response.destroyed && !response.headersSent) {
      response.writeHead(503, { "content-type": "text/plain; charset=utf-8" }); response.end("Metrics temporarily unavailable\n");
    }
  }
  return true;
}

// Existing HTTP processes call serveMetrics on their own port. CLI workers
// may opt into this minimal same-process listener; no separate daemon exists.
export async function startWorkerMetrics({ environment = process.env, metrics = processMetrics, logger = console } = {}) {
  const raw = environment.METRICS_PORT;
  if (raw == null || raw === "") return { async close() {} };
  const host = environment.METRICS_HOST ?? "127.0.0.1";
  if (!["127.0.0.1", "::1", "localhost"].includes(host) || !/^[0-9]+$/.test(raw) || Number(raw) > 65535) throw new Error("Invalid metrics listener configuration");
  const server = createServer(async (request, response) => {
    if (!await serveMetrics(request, response, metrics) && !response.destroyed) { response.writeHead(404); response.end(); }
  });
  const close = async () => {
    if (!server.listening) return;
    const done = new Promise(resolve => server.close(resolve)); server.closeAllConnections(); await done;
  };
  // A bind error disables only this observation surface, not a protocol worker.
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(Number(raw), host, resolve); });
    server.removeAllListeners("error"); server.on("error", () => logger.warn("Metrics listener unavailable"));
    logger.log(`Metrics endpoint: http://${host === "::1" ? "[::1]" : host}:${server.address().port}/metrics`);
  } catch { logger.warn("Metrics listener unavailable; protocol processing continues"); }
  return { server, close };
}
