import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDatabaseConfig, validateSchemaName } from "../config.mjs";
import { normalizeAddress } from "../canonical-message.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { loadValidatorSetResolver } from "../../../validator/src/validator-sets.mjs";
import { MessageQueryConfigurationError } from "./errors.mjs";

const PROJECT_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

export function loadMessageQueryConfig(environment = process.env) {
  const issues = [];
  // Parser exception messages may contain connection material or malformed
  // JSON. Retain only our own field names, and report every configuration issue
  // before creating pools, registering collectors or opening the listener.
  const read = (field, operation) => {
    try { return operation(); }
    catch { issues.push(`${field} is invalid`); return undefined; }
  };
  const required = (field, operation) => {
    if (typeof environment[field] !== "string" || environment[field].trim() === "") {
      issues.push(`${field} is required`); return undefined;
    }
    return read(field, operation);
  };

  const database = required("DATABASE_URL", () => loadDatabaseConfig({ DATABASE_URL: environment.DATABASE_URL }));
  const databaseSchema = environment.INDEXER_DB_SCHEMA === undefined ? database?.databaseSchema :
    read("INDEXER_DB_SCHEMA", () => validateSchemaName(environment.INDEXER_DB_SCHEMA));
  const chainDomain = required("CHAIN_A_DOMAIN", () => {
    const value = protocolInteger(environment.CHAIN_A_DOMAIN, "Chain A domain");
    if (value === 0n) throw new Error();
    return value;
  });
  const sourceGateway = required("SOURCE_GATEWAY_ADDRESS", () => normalizeAddress(environment.SOURCE_GATEWAY_ADDRESS));
  const finalityBlockDepth = required("FINALITY_BLOCK_DEPTH", () => protocolInteger(environment.FINALITY_BLOCK_DEPTH, "finality depth"));
  const destinationConfirmations = read("DESTINATION_CONFIRMATIONS", () => {
    const value = protocolInteger(environment.DESTINATION_CONFIRMATIONS ?? "3", "destination confirmations");
    if (value === 0n) throw new Error();
    return value;
  });

  const inlineHistory = environment.VALIDATOR_SET_HISTORY;
  const historyFile = environment.VALIDATOR_SET_HISTORY_FILE;
  let validatorSets;
  if (!inlineHistory && !historyFile) issues.push("set exactly one of VALIDATOR_SET_HISTORY or VALIDATOR_SET_HISTORY_FILE");
  else if (inlineHistory && historyFile) issues.push("VALIDATOR_SET_HISTORY and VALIDATOR_SET_HISTORY_FILE cannot both be set");
  else {
    validatorSets = read(historyFile ? "VALIDATOR_SET_HISTORY_FILE (readable JSON with valid validator history)" : "VALIDATOR_SET_HISTORY", () =>
      loadValidatorSetResolver({ ...environment,
        // npm --prefix indexer runs with indexer/ as cwd. Resolve API file
        // configuration against the same project root as its .env instead.
        VALIDATOR_SET_HISTORY_FILE: historyFile ? resolve(PROJECT_ROOT, historyFile) : historyFile,
      }));
  }

  const listenHost = read("MESSAGE_QUERY_API_HOST", () => {
    const value = environment.MESSAGE_QUERY_API_HOST ?? "127.0.0.1";
    if (value !== "localhost" && isIP(value) === 0) throw new Error();
    return value;
  });
  const listenPort = read("MESSAGE_QUERY_API_PORT", () => {
    const text = environment.MESSAGE_QUERY_API_PORT ?? "8080";
    const value = Number(text);
    if (!/^[0-9]+$/.test(text) || !Number.isInteger(value) || value < 1 || value > 65535) throw new Error();
    return value;
  });
  const stores = read("MESSAGE_QUERY_VALIDATOR_STORES", () => {
    const value = JSON.parse(environment.MESSAGE_QUERY_VALIDATOR_STORES ?? "[]");
    if (!Array.isArray(value)) throw new Error();
    return value;
  });
  const identities = new Set();
  const validatorStores = stores?.map((value, index) => read(`MESSAGE_QUERY_VALIDATOR_STORES[${index}]`, () => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !value.validatorAddress || !value.databaseSchema ||
      Object.keys(value).some(key => !["validatorAddress", "databaseSchema", "databaseUrl"].includes(key))) throw new Error();
    const validatorAddress = normalizeAddress(value.validatorAddress);
    if (identities.has(validatorAddress) || (validatorSets && !validatorSets.history.some(set => set.validators.includes(validatorAddress)))) throw new Error();
    identities.add(validatorAddress);
    const store = loadDatabaseConfig({ DATABASE_URL: value.databaseUrl ?? database?.databaseUrl, INDEXER_DB_SCHEMA: value.databaseSchema });
    if (store.databaseSchema.length > 63) throw new Error();
    return { ...store, validatorAddress };
  }));
  const productionDestinationGateway = environment.PRODUCTION_DESTINATION_GATEWAY_ADDRESS ?
    read("PRODUCTION_DESTINATION_GATEWAY_ADDRESS", () => normalizeAddress(environment.PRODUCTION_DESTINATION_GATEWAY_ADDRESS)) : null;
  const identityApplicationAddress = environment.IDENTITY_APPLICATION_ADDRESS ? read("IDENTITY_APPLICATION_ADDRESS", () => {
    const value = normalizeAddress(environment.IDENTITY_APPLICATION_ADDRESS);
    if (value === `0x${"0".repeat(40)}`) throw new Error();
    return value;
  }) : null;

  if (issues.length) throw new MessageQueryConfigurationError(issues);
  return { ...database, databaseSchema, chainDomain, sourceGateway, validatorSets, listenHost, listenPort,
    finalityBlockDepth, destinationConfirmations, validatorStores, productionDestinationGateway, identityApplicationAddress };
}

export const publicMessageQueryConfig = config => ({ host: config.listenHost, port: config.listenPort,
  authority: "OBSERVATIONAL", sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway,
  validatorReaders: config.validatorStores.length });
