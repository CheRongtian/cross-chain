import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { loadDeliveryConfig } from "../delivery/config.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export class RelayerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function normalizeWorkerId(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) throw new RelayerError("INVALID_RELAYER_WORKER_ID");
  return value;
}
export function normalizeLeaseDuration(value) {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value) || BigInt(value) > 3600000n) throw new RelayerError("INVALID_RELAYER_LEASE_DURATION");
  return Number(value);
}

export function loadRelayerConfig(environment = process.env) {
  const delivery = loadDeliveryConfig(environment);
  let configured;
  try {
    configured = environment.CHAIN_B_RPC_URLS === undefined ? [environment.CHAIN_B_RPC_URL] : JSON.parse(environment.CHAIN_B_RPC_URLS);
  } catch { throw new RelayerError("INVALID_DESTINATION_RPC_URLS"); }
  if (!Array.isArray(configured) || !configured.length) throw new RelayerError("INVALID_DESTINATION_RPC_URLS");
  const destinationRpcUrls = configured.map(value => {
    if (typeof value !== "string" || !/^https?:\/\//i.test(value) || value.trim() !== value) throw new RelayerError("INVALID_DESTINATION_RPC_URL");
    let url;
    try { url = new URL(value); } catch { throw new RelayerError("INVALID_DESTINATION_RPC_URL"); }
    if (!["http:","https:"].includes(url.protocol) || url.hash) throw new RelayerError("INVALID_DESTINATION_RPC_URL");
    return url.href;
  });
  if (new Set(destinationRpcUrls).size !== destinationRpcUrls.length) throw new RelayerError("DUPLICATE_DESTINATION_RPC_ENDPOINT");
  let destinationGenesisHash;
  try { destinationGenesisHash = normalizeBytes32(environment.CHAIN_B_GENESIS_HASH,"destination genesis"); }
  catch { throw new RelayerError("INVALID_DESTINATION_GENESIS_HASH"); }
  const timeout = environment.RPC_REQUEST_TIMEOUT_MS ?? "10000";
  if (typeof timeout !== "string" || !/^[1-9][0-9]*$/.test(timeout) || BigInt(timeout) > 2147483647n) throw new RelayerError("INVALID_RPC_REQUEST_TIMEOUT");
  const rpcRequestTimeoutMs = Number(timeout);
  // Retain the primary address for the existing historical direct-send adapter.
  const destinationRpcUrl = destinationRpcUrls[0];
  const destinationDomain = protocolInteger(environment.CHAIN_B_CHAIN_ID,"destination chain ID");
  // viem's Ethereum chain ID boundary is a safe integer; protocol fields stay bigint.
  if (destinationDomain === 0n || destinationDomain > BigInt(Number.MAX_SAFE_INTEGER)) throw new RelayerError("UNSUPPORTED_DESTINATION_CHAIN_ID");
  const privateKey = environment.RELAYER_A_PRIVATE_KEY;
  let relayerAddress;
  try {
    if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error();
    relayerAddress = normalizeAddress(privateKeyToAccount(privateKey).address);
  } catch { throw new RelayerError("INVALID_RELAYER_PRIVATE_KEY"); }
  const limit = environment.RELAYER_MAX_JOBS_PER_RUN ?? "100";
  if (typeof limit !== "string" || !/^[1-9][0-9]*$/.test(limit)) throw new RelayerError("INVALID_RELAYER_LIMIT");
  const maxJobs = deliveryLimit(Number(limit));
  const workerId = normalizeWorkerId(environment.RELAYER_WORKER_ID ?? "relayer-a");
  const leaseMs = normalizeLeaseDuration(environment.RELAYER_LEASE_MS ?? "30000");
  return { ...delivery,destinationRpcUrl,destinationRpcUrls: Object.freeze(destinationRpcUrls),destinationGenesisHash,
    rpcRequestTimeoutMs,destinationDomain,privateKey,relayerAddress,maxJobs,workerId,leaseMs };
}

export function publicRelayerConfig(config) {
  return Object.freeze({ relayerAddress: config.relayerAddress,sourceDomain: config.chainDomain.toString(),
    sourceGateway: config.sourceGateway,destinationDomain: config.destinationDomain.toString(),maxJobs: config.maxJobs,
    workerId: config.workerId,leaseMs: config.leaseMs,destinationGenesisHash: config.destinationGenesisHash,rpcRequestTimeoutMs: config.rpcRequestTimeoutMs,
    rpcEndpoints: config.destinationRpcUrls.map((_,index) => ({ label: `rpc-${index}`,priority: index })) });
}

export function safeRelayerMessage(error,config) {
  let message = error?.message ?? String(error);
  for (const secret of [config?.privateKey,config?.databaseUrl,config?.destinationRpcUrl,...(config?.destinationRpcUrls ?? [])]) {
    if (secret) message = message.split(secret).join("<redacted>");
  }
  return message;
}
