import { loadDatabaseConfig } from "../config.mjs";
import { normalizeAddress } from "../canonical-message.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { loadValidatorSetResolver } from "../../../validator/src/validator-sets.mjs";

export function loadDeliveryConfig(environment = process.env) {
  const chainDomain = protocolInteger(environment.CHAIN_A_DOMAIN, "Chain A domain");
  if (chainDomain === 0n) throw new Error("CHAIN_A_DOMAIN must be positive");
  return { ...loadDatabaseConfig(environment), chainDomain,
    sourceGateway: normalizeAddress(environment.SOURCE_GATEWAY_ADDRESS, "source gateway"),
    validatorSets: loadValidatorSetResolver(environment) };
}
