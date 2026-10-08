import { normalizeAddress, toUint256 } from "./canonical-message.mjs";

const DEFAULT_BLOCK_RANGE = "2000";
const DEFAULT_POLL_INTERVAL_MS = "1000";
const DEFAULT_DATABASE_SCHEMA = "cross_chain_indexer";

function requireNonEmpty(value, name) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} is required`);
  }
  return value.trim();
}

function parseUrl(value, name, protocols) {
  const normalized = requireNonEmpty(value, name);
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }

  if (!protocols.includes(parsed.protocol)) {
    throw new Error(`${name} must use ${protocols.join(" or ")}`);
  }
  return normalized;
}

function parsePositiveInteger(value, name) {
  const normalized = requireNonEmpty(value, name);
  if (!/^[0-9]+$/.test(normalized)) {
    throw new Error(`${name} must be a positive integer`);
  }

  const result = Number(normalized);
  if (!Number.isSafeInteger(result) || result <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return result;
}

export function validateSchemaName(value) {
  const normalized = requireNonEmpty(value, "INDEXER_DB_SCHEMA");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) {
    throw new Error("INDEXER_DB_SCHEMA must be a PostgreSQL identifier");
  }
  return normalized;
}

export function loadDatabaseConfig(environment = process.env) {
  return {
    databaseUrl: parseUrl(environment.DATABASE_URL, "DATABASE_URL", ["postgres:", "postgresql:"]),
    databaseSchema: validateSchemaName(environment.INDEXER_DB_SCHEMA ?? DEFAULT_DATABASE_SCHEMA),
  };
}

export function loadConfig(environment = process.env) {
  const database = loadDatabaseConfig(environment);
  const chainDomain = toUint256(requireNonEmpty(environment.CHAIN_A_DOMAIN, "CHAIN_A_DOMAIN"), "Chain A domain");

  if (chainDomain === 0n) {
    throw new Error("CHAIN_A_DOMAIN must be greater than zero");
  }

  return {
    ...database,
    chainRpcUrl: parseUrl(environment.CHAIN_A_RPC_URL, "CHAIN_A_RPC_URL", ["http:", "https:"]),
    chainDomain,
    sourceGateway: normalizeAddress(
      requireNonEmpty(environment.SOURCE_GATEWAY_ADDRESS, "SOURCE_GATEWAY_ADDRESS"),
      "SourceGateway address",
    ),
    sourceGatewayStartBlock: toUint256(
      requireNonEmpty(environment.SOURCE_GATEWAY_START_BLOCK, "SOURCE_GATEWAY_START_BLOCK"),
      "SourceGateway start block",
    ),
    blockRange: BigInt(
      parsePositiveInteger(environment.INDEXER_BLOCK_RANGE ?? DEFAULT_BLOCK_RANGE, "INDEXER_BLOCK_RANGE"),
    ),
    pollIntervalMs: parsePositiveInteger(
      environment.INDEXER_POLL_INTERVAL_MS ?? DEFAULT_POLL_INTERVAL_MS,
      "INDEXER_POLL_INTERVAL_MS",
    ),
  };
}
