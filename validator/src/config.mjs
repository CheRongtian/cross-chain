import { isIP } from "node:net";
import { normalizeAddress, toUint256 } from "../../indexer/src/canonical-message.mjs";
import { loadDatabaseConfig, validateSchemaName } from "../../indexer/src/config.mjs";
import { loadValidatorSetResolver } from "./validator-sets.mjs";
import { validatorAccount } from "./identity.mjs";

function required(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${name} is required`);
  return value.trim();
}

export function httpUrl(value, name) {
  let url;
  try { url = new URL(required(value, name)); } catch { throw new Error(`${name} must be an HTTP(S) URL`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query, or fragment`);
  }
  if (url.pathname !== "/") throw new Error(`${name} must identify an endpoint origin`);
  return url.origin;
}

function uint(value, name) {
  const text = required(value, name);
  if (!/^[0-9]+$/.test(text)) throw new Error(`${name} must be a decimal uint256`);
  return toUint256(text, name);
}

function schema(value, name) {
  const text = validateSchemaName(required(value, name));
  if (text.length > 63) throw new Error(`${name} exceeds PostgreSQL identifier length`);
  return text;
}

export function loadValidatorConfig(environment = process.env) {
  const privateKey = required(environment.VALIDATOR_PRIVATE_KEY, "VALIDATOR_PRIVATE_KEY");
  const validatorAddress = validatorAccount(privateKey).address.toLowerCase();
  const listenHost = required(environment.VALIDATOR_LISTEN_HOST, "VALIDATOR_LISTEN_HOST");
  if (listenHost !== "localhost" && isIP(listenHost) === 0) throw new Error("VALIDATOR_LISTEN_HOST must be localhost or an IP address");
  const portText = required(environment.VALIDATOR_LISTEN_PORT, "VALIDATOR_LISTEN_PORT");
  const listenPort = Number(portText);
  if (!/^[0-9]+$/.test(portText) || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) {
    throw new Error("VALIDATOR_LISTEN_PORT must be between 1 and 65535");
  }
  const sourceDb = loadDatabaseConfig({ DATABASE_URL: environment.SOURCE_DATABASE_URL, INDEXER_DB_SCHEMA: schema(environment.SOURCE_DB_SCHEMA, "SOURCE_DB_SCHEMA") });
  const localDb = loadDatabaseConfig({ DATABASE_URL: environment.VALIDATOR_DATABASE_URL, INDEXER_DB_SCHEMA: schema(environment.VALIDATOR_DB_SCHEMA, "VALIDATOR_DB_SCHEMA") });
  if (sourceDb.databaseSchema === localDb.databaseSchema) {
    const source = new URL(sourceDb.databaseUrl);
    const local = new URL(localDb.databaseUrl);
    const sourceName = decodeURIComponent(source.pathname.slice(1) || source.username);
    const localName = decodeURIComponent(local.pathname.slice(1) || local.username);
    if (source.hostname.toLowerCase() === local.hostname.toLowerCase() &&
        (source.port || "5432") === (local.port || "5432") && sourceName === localName) {
      throw new Error("source and validator state must use distinct databases or schemas");
    }
  }
  const chainDomain = uint(environment.CHAIN_A_DOMAIN, "CHAIN_A_DOMAIN");
  if (chainDomain === 0n) throw new Error("CHAIN_A_DOMAIN must be positive");
  const sourceGateway = normalizeAddress(required(environment.SOURCE_GATEWAY_ADDRESS, "SOURCE_GATEWAY_ADDRESS"));
  const chainRpcUrl = httpUrl(environment.CHAIN_A_RPC_URL, "CHAIN_A_RPC_URL");
  const finalityBlockDepth = uint(environment.FINALITY_BLOCK_DEPTH, "FINALITY_BLOCK_DEPTH");
  const validatorSets = loadValidatorSetResolver(environment);
  let peers;
  try { peers = JSON.parse(required(environment.VALIDATOR_PEERS, "VALIDATOR_PEERS")); } catch { throw new Error("VALIDATOR_PEERS must be a JSON array"); }
  if (!Array.isArray(peers) || peers.length < 4) throw new Error("VALIDATOR_PEERS must contain at least four unique endpoint identities");
  const addresses = new Set();
  const endpoints = new Set();
  peers = peers.map((peer) => {
    if (!peer || typeof peer !== "object" || Array.isArray(peer) || Object.keys(peer).sort().join(",") !== "address,url") {
      throw new Error("each validator peer must contain only address and url");
    }
    const address = normalizeAddress(peer.address, "peer validator identity");
    const url = httpUrl(peer.url, "peer URL");
    if (addresses.has(address) || endpoints.has(url)) throw new Error("validator identities and peer URLs must be unique");
    addresses.add(address); endpoints.add(url);
    return { address, url };
  });
  for (const set of validatorSets.history) {
    if (set.validators.some((address) => !addresses.has(address))) throw new Error("validator history has a member without an endpoint");
  }
  if (!validatorSets.history.some((set) => set.validators.includes(validatorAddress))) throw new Error("local identity is not in validator history");
  const self = peers.find((peer) => peer.address === validatorAddress);
  if (!self) throw new Error("derived validator identity has no configured endpoint");
  const ownHost = listenHost.includes(":") ? `[${listenHost}]` : listenHost;
  if (self.url !== new URL(`http://${ownHost}:${listenPort}`).origin) throw new Error("self peer URL must match the HTTP listen endpoint");
  const timeoutText = environment.PBFT_VIEW_TIMEOUT_MS ?? "30000";
  const viewTimeoutMs = Number(timeoutText);
  if (!/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(viewTimeoutMs) || viewTimeoutMs > 2147483647) {
    throw new Error("PBFT_VIEW_TIMEOUT_MS must be a positive timer interval at most 2147483647");
  }
  return {
    viewTimeoutMs, validatorSets,
    privateKey, validatorAddress, listenHost, listenPort, peers,
    sourceDatabaseUrl: sourceDb.databaseUrl, sourceDatabaseSchema: sourceDb.databaseSchema,
    databaseUrl: localDb.databaseUrl, databaseSchema: localDb.databaseSchema,
    chainDomain, sourceGateway, chainRpcUrl, finalityBlockDepth,
  };
}

export function loadValidatorDatabaseConfig(environment = process.env) {
  return loadDatabaseConfig({
    DATABASE_URL: environment.VALIDATOR_DATABASE_URL,
    INDEXER_DB_SCHEMA: schema(environment.VALIDATOR_DB_SCHEMA, "VALIDATOR_DB_SCHEMA"),
  });
}
