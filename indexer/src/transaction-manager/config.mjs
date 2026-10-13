import { loadRelayerConfig, publicRelayerConfig } from "../relayer/config.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";

export class TransactionError extends Error {
  constructor(code) { super(code); this.name = "TransactionError"; this.code = code; }
}

export function loadTransactionConfig(environment = process.env) {
  const config = loadRelayerConfig(environment);
  const destinationConfirmations = protocolInteger(environment.DESTINATION_CONFIRMATIONS ?? "3", "destination confirmations");
  if (destinationConfirmations === 0n) throw new TransactionError("INVALID_DESTINATION_CONFIRMATIONS");
  function positive(value, label) {
    const result = protocolInteger(value,label);
    if (result === 0n) throw new TransactionError(`INVALID_${label.toUpperCase().replaceAll(" ","_")}`);
    return result;
  }
  function milliseconds(value,label) {
    const result = positive(value,label);
    if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new TransactionError("INVALID_RETRY_INTERVAL");
    return Number(result);
  }
  const rebroadcastIntervalMs = milliseconds(environment.TX_REBROADCAST_INTERVAL_MS ?? "5000","rebroadcast interval");
  const replacementAfterMs = milliseconds(environment.TX_REPLACEMENT_AFTER_MS ?? "60000","replacement interval");
  const feeBumpNumerator = positive(environment.TX_FEE_BUMP_NUMERATOR ?? "9","fee bump numerator");
  const feeBumpDenominator = positive(environment.TX_FEE_BUMP_DENOMINATOR ?? "8","fee bump denominator");
  const count = positive(environment.TX_MAX_ATTEMPTS ?? "4","maximum attempts");
  const maxFeePerGasCap = positive(environment.TX_MAX_FEE_PER_GAS ?? "100000000000","max fee cap");
  const maxPriorityFeePerGasCap = positive(environment.TX_MAX_PRIORITY_FEE_PER_GAS ?? "10000000000","priority fee cap");
  if (replacementAfterMs < rebroadcastIntervalMs || feeBumpNumerator <= feeBumpDenominator || count > 1000n || maxPriorityFeePerGasCap > maxFeePerGasCap) throw new TransactionError("INVALID_RETRY_POLICY");
  return { ...config,destinationConfirmations,rebroadcastIntervalMs,replacementAfterMs,feeBumpNumerator,feeBumpDenominator,
    maxAttempts: Number(count),maxFeePerGasCap,maxPriorityFeePerGasCap };
}

export function publicTransactionConfig(config) {
  return Object.freeze({ ...publicRelayerConfig(config),destinationConfirmations: config.destinationConfirmations.toString(),
    rebroadcastIntervalMs: config.rebroadcastIntervalMs,replacementAfterMs: config.replacementAfterMs,
    feeBumpNumerator: config.feeBumpNumerator.toString(),feeBumpDenominator: config.feeBumpDenominator.toString(),
    maxAttempts: config.maxAttempts,maxFeePerGasCap: config.maxFeePerGasCap.toString(),maxPriorityFeePerGasCap: config.maxPriorityFeePerGasCap.toString() });
}
