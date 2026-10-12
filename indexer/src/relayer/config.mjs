import { privateKeyToAccount } from "viem/accounts";
import { normalizeAddress } from "../canonical-message.mjs";
import { loadDeliveryConfig } from "../delivery/config.mjs";
import { deliveryLimit } from "../delivery/package.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export class RelayerError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function loadRelayerConfig(environment = process.env) {
  const delivery = loadDeliveryConfig(environment);
  const destinationRpcUrl = environment.CHAIN_B_RPC_URL;
  let url;
  try { url = new URL(destinationRpcUrl); } catch { throw new RelayerError("INVALID_DESTINATION_RPC_URL"); }
  if (!["http:","https:"].includes(url.protocol)) throw new RelayerError("INVALID_DESTINATION_RPC_URL");
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
  return { ...delivery,destinationRpcUrl,destinationDomain,privateKey,relayerAddress,maxJobs };
}

export function publicRelayerConfig(config) {
  return Object.freeze({ relayerAddress: config.relayerAddress,sourceDomain: config.chainDomain.toString(),
    sourceGateway: config.sourceGateway,destinationDomain: config.destinationDomain.toString(),maxJobs: config.maxJobs });
}

export function safeRelayerMessage(error,config) {
  let message = error?.message ?? String(error);
  for (const secret of [config?.privateKey,config?.databaseUrl,config?.destinationRpcUrl]) {
    if (secret) message = message.split(secret).join("<redacted>");
  }
  return message;
}
