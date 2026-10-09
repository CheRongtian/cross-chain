import { privateKeyToAccount } from "viem/accounts";

export function validatorAccount(privateKey) {
  if (typeof privateKey !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error("VALIDATOR_PRIVATE_KEY must be a valid secp256k1 private key");
  }
  try {
    return privateKeyToAccount(privateKey);
  } catch {
    // Never forward a crypto error that might include the supplied secret.
    throw new Error("VALIDATOR_PRIVATE_KEY must be a valid secp256k1 private key");
  }
}

export function publicIdentity(config) {
  return {
    validatorAddress: config.validatorAddress,
    protocolVersion: "1",
    sourceDomain: config.chainDomain.toString(),
    sourceGateway: config.sourceGateway,
    finalityBlockDepth: config.finalityBlockDepth.toString(),
  };
}
