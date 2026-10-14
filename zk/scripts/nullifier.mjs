export function requireNullifierCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fieldElement(value, fieldPrime, label) {
  const parsed = BigInt(value);
  requireNullifierCondition(parsed >= 0n && parsed < fieldPrime, `${label} must be a BN254 scalar field element`);
  return parsed;
}

export function resolveActionContext(actionName, nullifierConfig) {
  const actionContext = nullifierConfig.actionContexts[actionName];
  requireNullifierCondition(
    Number.isInteger(actionContext) && actionContext > 0,
    `unsupported nullifier action context: ${actionName}`,
  );
  return BigInt(actionContext);
}

export function computeNullifier(poseidon, credentialIdField, context, nullifierConfig, fieldPrime) {
  const inputs = [
    fieldElement(nullifierConfig.nullifierVersion, fieldPrime, "nullifierVersion"),
    fieldElement(credentialIdField, fieldPrime, "credentialIdField"),
    fieldElement(context.applicationDomain, fieldPrime, "applicationDomain"),
    fieldElement(context.policyEpoch, fieldPrime, "policyEpoch"),
    fieldElement(context.actionContext, fieldPrime, "actionContext"),
    fieldElement(context.forwardIntentDigestHi ?? 0n, fieldPrime, "forwardIntentDigestHi"),
    fieldElement(context.forwardIntentDigestLo ?? 0n, fieldPrime, "forwardIntentDigestLo"),
  ];
  requireNullifierCondition(inputs[5] < (1n << 128n) && inputs[6] < (1n << 128n), "forward intent limbs must fit uint128");
  requireNullifierCondition(inputs[4] !== 1n || (inputs[5] === 0n && inputs[6] === 0n), "verify-only intent limbs must be zero");

  requireNullifierCondition(nullifierConfig.algorithm === "Poseidon", "nullifier must use Poseidon");
  requireNullifierCondition(nullifierConfig.arity === inputs.length, "nullifier Poseidon arity is inconsistent");

  return BigInt(poseidon.F.toObject(poseidon(inputs)));
}
