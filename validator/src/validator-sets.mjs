import { readFileSync } from "node:fs";
import { canonicalCommittee, committeeDigest, protocolInteger } from "./committee.mjs";
import { normalizeBytes32 } from "../../indexer/src/canonical-message.mjs";

export class ValidatorSetError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function createValidatorSetResolver(history) {
  if (!Array.isArray(history) || !history.length) throw new ValidatorSetError("INVALID_VALIDATOR_HISTORY");
  const sets = history.map((input) => {
    if (!input || !["activationBatchEpoch,validatorEpoch,validators", "activationBatchEpoch,committeeDigest,validatorEpoch,validators"].includes(Object.keys(input).sort().join(","))) {
      throw new ValidatorSetError("INVALID_VALIDATOR_SET");
    }
    const validatorEpoch = protocolInteger(input.validatorEpoch, "validator epoch").toString();
    const activationBatchEpoch = protocolInteger(input.activationBatchEpoch, "activation batch epoch").toString();
    if (!Array.isArray(input.validators) || input.validators.some((identity) => typeof identity !== "string")) throw new ValidatorSetError("INVALID_VALIDATOR_SET");
    const validators = canonicalCommittee(input.validators);
    const digest = committeeDigest(validators);
    if (input.committeeDigest !== undefined && normalizeBytes32(input.committeeDigest) !== digest) throw new ValidatorSetError("WRONG_COMMITTEE");
    return Object.freeze({ validatorEpoch, activationBatchEpoch, validators, committeeDigest: digest });
  }).sort((a, b) => BigInt(a.validatorEpoch) < BigInt(b.validatorEpoch) ? -1 : 1);
  for (let index = 1; index < sets.length; index++) {
    if (BigInt(sets[index].validatorEpoch) !== BigInt(sets[index - 1].validatorEpoch) + 1n) {
      throw new ValidatorSetError("NONCONTIGUOUS_VALIDATOR_EPOCH");
    }
    if (BigInt(sets[index].activationBatchEpoch) <= BigInt(sets[index - 1].activationBatchEpoch)) {
      throw new ValidatorSetError("RETROACTIVE_ACTIVATION");
    }
  }
  Object.freeze(sets);
  return Object.freeze({
    history: sets,
    resolveByValidatorEpoch(epoch) {
      const exact = protocolInteger(epoch, "validator epoch").toString();
      const set = sets.find((entry) => entry.validatorEpoch === exact);
      if (!set) throw new ValidatorSetError("UNKNOWN_VALIDATOR_EPOCH");
      return set;
    },
    resolveForBatchEpoch(epoch) {
      const exact = protocolInteger(epoch, "batch epoch");
      const set = [...sets].reverse().find((entry) => BigInt(entry.activationBatchEpoch) <= exact);
      if (!set) throw new ValidatorSetError("UNKNOWN_VALIDATOR_EPOCH");
      return set;
    },
  });
}

export function loadValidatorSetResolver(environment) {
  const inline = environment.VALIDATOR_SET_HISTORY;
  const path = environment.VALIDATOR_SET_HISTORY_FILE;
  if (Boolean(inline) === Boolean(path)) throw new ValidatorSetError("EXACTLY_ONE_VALIDATOR_HISTORY_REQUIRED");
  return createValidatorSetResolver(JSON.parse(inline || readFileSync(path, "utf8")));
}

export function consensusCommittee(config, input) {
  const resolver = config.validatorSets;
  if (!resolver) throw new ValidatorSetError("VALIDATOR_HISTORY_REQUIRED");
  const scheduled = resolver.resolveForBatchEpoch(input.epoch);
  if (input.protocolVersion === "3") {
    const set = resolver.resolveByValidatorEpoch(input.validatorEpoch);
    if (set.validatorEpoch !== scheduled.validatorEpoch) throw new ValidatorSetError("WRONG_VALIDATOR_EPOCH");
    if (input.committeeDigest !== set.committeeDigest) throw new ValidatorSetError("WRONG_COMMITTEE");
    return set;
  }
  // Legacy signatures did not sign a validator epoch. Their original committee
  // is explicitly configured by the initial history entry, never the latest set.
  return resolver.history[0];
}

export function consensusBinding(config, epoch) {
  const set = config.validatorSets.resolveForBatchEpoch(epoch);
  return { validatorEpoch: set.validatorEpoch, committeeDigest: set.committeeDigest };
}

export function consensusPeers(config, input) {
  const set = consensusCommittee(config, input);
  return set.validators.map((address) => {
    const peer = config.peers.find((entry) => entry.address === address);
    if (!peer) throw new ValidatorSetError("MISSING_VALIDATOR_ENDPOINT");
    return peer;
  });
}
