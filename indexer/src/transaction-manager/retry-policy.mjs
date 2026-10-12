import { protocolInteger } from "../../../validator/src/committee.mjs";
import { TransactionError } from "./config.mjs";

export function replacementFees(previous, market, config) {
  const numerator = config.feeBumpNumerator;
  const denominator = config.feeBumpDenominator;
  const ceilBump = value => (value * numerator + denominator - 1n) / denominator;
  const oldPriority = protocolInteger(previous.maxPriorityFeePerGas, "priority fee");
  const oldMax = protocolInteger(previous.maxFeePerGas, "max fee");
  const priority = protocolInteger(market.maxPriorityFeePerGas, "market priority fee");
  const maximum = protocolInteger(market.maxFeePerGas, "market max fee");
  if (numerator <= denominator || denominator === 0n || maximum < priority) throw new TransactionError("INVALID_REPLACEMENT_FEES");
  const max = values => values.reduce((a,b) => a > b ? a : b);
  const maxPriorityFeePerGas = max([ceilBump(oldPriority),priority,oldPriority + 1n]);
  const maxFeePerGas = max([ceilBump(oldMax),maximum,oldMax + 1n,maxPriorityFeePerGas]);
  if (maxFeePerGas >= (1n << 256n) || maxPriorityFeePerGas >= (1n << 256n)) throw new TransactionError("REPLACEMENT_FEE_OVERFLOW");
  if (maxFeePerGas > config.maxFeePerGasCap || maxPriorityFeePerGas > config.maxPriorityFeePerGasCap) throw new TransactionError("FEE_CAP_EXCEEDED");
  return Object.freeze({ maxFeePerGas,maxPriorityFeePerGas });
}

export function operationTime(clock) {
  const now = clock.now();
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) throw new TransactionError("INVALID_RETRY_CLOCK");
  return now;
}

export function actionDate(now, interval = 0) {
  const value = now + interval;
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new TransactionError("INVALID_RETRY_CLOCK");
  return new Date(value);
}

export function replacementDue(attempt, now, config) {
  if (BigInt(attempt.broadcastAttemptCount) === 0n) return false;
  if (attempt.lastErrorClass === "REPLACEMENT_UNDERPRICED") return true;
  if (attempt.status !== "BROADCAST" || ["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(attempt.lastErrorClass)) return false;
  return now - new Date(attempt.broadcastAt ?? attempt.createdAt).getTime() >= config.replacementAfterMs;
}
