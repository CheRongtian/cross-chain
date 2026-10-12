import { loadRelayerConfig, publicRelayerConfig } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export class TransactionError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function loadTransactionConfig(environment = process.env) {
  const config = loadRelayerConfig(environment);
  const destinationConfirmations = protocolInteger(environment.DESTINATION_CONFIRMATIONS ?? "3", "destination confirmations");
  if (destinationConfirmations === 0n) throw new TransactionError("INVALID_DESTINATION_CONFIRMATIONS");
  return { ...config, destinationConfirmations };
}

export function publicTransactionConfig(config) {
  return Object.freeze({ ...publicRelayerConfig(config), destinationConfirmations: config.destinationConfirmations.toString() });
}
