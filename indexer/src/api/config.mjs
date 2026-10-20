import { isIP } from "node:net";
import { loadDeliveryConfig } from "../delivery/config.mjs";
import { loadDatabaseConfig, validateSchemaName } from "../config.mjs";
import { normalizeAddress } from "../canonical-message.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export function loadMessageQueryConfig(environment = process.env) {
  const base = loadDeliveryConfig(environment);
  const listenHost = environment.MESSAGE_QUERY_API_HOST ?? "127.0.0.1";
  if (listenHost !== "localhost" && isIP(listenHost) === 0) throw new Error("invalid MESSAGE_QUERY_API_HOST");
  const text = environment.MESSAGE_QUERY_API_PORT ?? "8080";
  const listenPort = Number(text);
  if (!/^[0-9]+$/.test(text) || !Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error("invalid MESSAGE_QUERY_API_PORT");
  const finalityBlockDepth = protocolInteger(environment.FINALITY_BLOCK_DEPTH, "finality depth");
  const destinationConfirmations = protocolInteger(environment.DESTINATION_CONFIRMATIONS ?? "3", "destination confirmations");
  if (destinationConfirmations === 0n) throw new Error("invalid DESTINATION_CONFIRMATIONS");
  let stores;
  try { stores = JSON.parse(environment.MESSAGE_QUERY_VALIDATOR_STORES ?? "[]"); }
  catch { throw new Error("invalid MESSAGE_QUERY_VALIDATOR_STORES"); }
  if (!Array.isArray(stores)) throw new Error("invalid MESSAGE_QUERY_VALIDATOR_STORES");
  const identities = new Set();
  const validatorStores = stores.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value) || !value.validatorAddress || !value.databaseSchema ||
      Object.keys(value).some(key => !["validatorAddress", "databaseSchema", "databaseUrl"].includes(key))) throw new Error("invalid validator read store");
    const validatorAddress = normalizeAddress(value.validatorAddress);
    if (identities.has(validatorAddress) || !base.validatorSets.history.some(set => set.validators.includes(validatorAddress))) throw new Error("invalid validator read identity");
    identities.add(validatorAddress);
    const database = loadDatabaseConfig({ DATABASE_URL: value.databaseUrl ?? base.databaseUrl, INDEXER_DB_SCHEMA: value.databaseSchema });
    if (validateSchemaName(database.databaseSchema).length > 63) throw new Error("invalid validator read schema");
    return { ...database, validatorAddress };
  });
  const productionDestinationGateway = environment.PRODUCTION_DESTINATION_GATEWAY_ADDRESS ? normalizeAddress(environment.PRODUCTION_DESTINATION_GATEWAY_ADDRESS) : null;
  const identityApplicationAddress = environment.IDENTITY_APPLICATION_ADDRESS ? normalizeAddress(environment.IDENTITY_APPLICATION_ADDRESS) : null;
  if (identityApplicationAddress === `0x${"0".repeat(40)}`) throw new Error("invalid IDENTITY_APPLICATION_ADDRESS");
  return { ...base, listenHost, listenPort, finalityBlockDepth, destinationConfirmations, validatorStores, productionDestinationGateway, identityApplicationAddress };
}

export const publicMessageQueryConfig = config => ({ host: config.listenHost, port: config.listenPort,
  authority: "OBSERVATIONAL", sourceDomain: config.chainDomain.toString(), sourceGateway: config.sourceGateway,
  validatorReaders: config.validatorStores.length });
