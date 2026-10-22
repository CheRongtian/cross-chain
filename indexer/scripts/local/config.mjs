// Script-layer configuration for the owned local deployment.
import { randomUUID } from "node:crypto";
import { join,resolve } from "node:path";
import { ROOT,freePort,freePorts } from "./tools.mjs";

export const LOCAL_DEVELOPMENT_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
export const validatorKey = index => "0x" + BigInt(index + 1).toString(16).padStart(64,"0");
function port(value,fallback) {
  const number = Number(value || fallback);
  if (!Number.isInteger(number) || number < 1 || number > 65535) throw new Error("Local listener ports must be between 1 and 65535");
  return number;
}
function rpcPort(value,fallback) {
  if (!value) return fallback;
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The owned local chains require plain http://127.0.0.1:<port> endpoints");
  }
  return port(url.port,80);
}
export async function localConfiguration({ isolated = false } = {}) {
  const runId = randomUUID();
  const parent = resolve(ROOT,".run",isolated ? "verification" : "local");
  const ports = isolated ? await freePorts(17) : [
    rpcPort(process.env.CHAIN_A_RPC_URL,4545),rpcPort(process.env.CHAIN_B_RPC_URL,9545),
    port(process.env.MESSAGE_QUERY_API_PORT,8080),port(process.env.PROMETHEUS_PORT,9090),port(process.env.GRAFANA_PORT,3000),
    ...Array.from({ length: 4 },(_,i) => port(Number(process.env.LOCAL_VALIDATOR_BASE_PORT || 31001) + i,31001 + i)),
    ...Array.from({ length: 5 },(_,i) => port(Number(process.env.LOCAL_METRICS_BASE_PORT || 9101) + i,9101 + i)),await freePort(),
  ];
  if (new Set(ports).size !== ports.length) throw new Error("Local listener ports overlap; choose distinct ports");
  const [chainA,chainB,api,prometheus,grafana,...remaining] = ports;
  return { runId,parent,directory: join(parent,runId),isolated,
    ports: { chainA,chainB,api,prometheus,grafana,validators: remaining.slice(0,4),metrics: remaining.slice(4,9),control: remaining[9],rpcGates: remaining.slice(10) },
    schema: "local_" + runId.replaceAll("-","").slice(0,16),
    chainA: `http://127.0.0.1:${chainA}`,chainB: `http://127.0.0.1:${chainB}`,
    api: `http://127.0.0.1:${api}`,prometheus: `http://127.0.0.1:${prometheus}`,grafana: `http://127.0.0.1:${grafana}`,
    control: `http://127.0.0.1:${remaining[9]}`,
  };
}
