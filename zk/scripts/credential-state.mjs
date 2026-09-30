import { createHash } from "node:crypto";

export function requireCondition(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

export function encodeString(value, domain, fieldPrime) {
  requireCondition(typeof value === "string" && value.length > 0, "encoded string must be non-empty");
  const digest = createHash("sha256")
    .update(domain, "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");
  return BigInt(`0x${digest}`) % fieldPrime;
}

export function encodeCredential(credential, encoding, fieldPrime) {
  const domains = encoding.stringEncoding.domains;
  const role = encoding.roleEncoding.values[credential.role];

  requireCondition(Number.isInteger(role) && role > 0, `unsupported role: ${credential.role}`);
  requireCondition(
    Number.isSafeInteger(credential.expiry) && credential.expiry >= 0,
    `invalid expiry: ${credential.expiry}`,
  );

  return {
    subject: encodeString(credential.subject, domains.subject, fieldPrime),
    issuer: encodeString(credential.issuer, domains.issuer, fieldPrime),
    role: BigInt(role),
    expiry: BigInt(credential.expiry),
    credentialId: encodeString(credential.credentialId, domains.credentialId, fieldPrime),
  };
}

export function computeCredentialCommitment(poseidon, encoded, preimageVersion) {
  const value = poseidon([
    BigInt(preimageVersion),
    encoded.subject,
    encoded.issuer,
    encoded.role,
    encoded.expiry,
    encoded.credentialId,
  ]);
  return BigInt(poseidon.F.toObject(value));
}

function poseidonValue(poseidon, inputs) {
  return BigInt(poseidon.F.toObject(poseidon(inputs)));
}

export function buildCredentialState(poseidon, credentialEntries, encoding, stateConfig) {
  const depth = stateConfig.treeDepth;
  const capacity = 2 ** depth;
  const configuredCapacity = stateConfig.capacity;
  const fieldPrime = BigInt(encoding.scalarField.prime);
  const leafVersion = BigInt(stateConfig.leafEncoding.stateLeafVersion);
  const emptyLeaf = BigInt(stateConfig.emptyLeaf);

  requireCondition(Number.isInteger(depth) && depth > 0, "credential state depth must be positive");
  requireCondition(configuredCapacity === capacity, "credential state capacity does not match its depth");
  requireCondition(stateConfig.leafEncoding.arity === 2, "active leaf Poseidon arity must be two");
  requireCondition(stateConfig.internalNodeEncoding.arity === 2, "internal node Poseidon arity must be two");

  const activeCredentials = credentialEntries
    .filter(({ credential }) => credential.status === "ACTIVE")
    .map(({ fixture, credential }) => {
      const encoded = encodeCredential(credential, encoding, fieldPrime);
      const credentialCommitment = computeCredentialCommitment(
        poseidon,
        encoded,
        encoding.commitment.preimageVersion,
      );
      const activeLeaf = poseidonValue(poseidon, [leafVersion, credentialCommitment]);

      return { fixture, credentialCommitment, activeLeaf };
    })
    .sort((left, right) => {
      if (left.credentialCommitment < right.credentialCommitment) return -1;
      if (left.credentialCommitment > right.credentialCommitment) return 1;
      return 0;
    });

  requireCondition(activeCredentials.length <= capacity, "active credential set exceeds tree capacity");

  for (let index = 1; index < activeCredentials.length; index += 1) {
    requireCondition(
      activeCredentials[index - 1].credentialCommitment !== activeCredentials[index].credentialCommitment,
      "active credential state contains a duplicate commitment",
    );
  }

  const leaves = Array(capacity).fill(emptyLeaf);

  for (const [index, entry] of activeCredentials.entries()) {
    entry.leafIndex = index;
    leaves[index] = entry.activeLeaf;
  }

  const levels = [leaves];

  for (let level = 0; level < depth; level += 1) {
    const children = levels[level];
    const parents = [];

    for (let index = 0; index < children.length; index += 2) {
      parents.push(poseidonValue(poseidon, [children[index], children[index + 1]]));
    }

    levels.push(parents);
  }

  const memberships = new Map();

  for (const entry of activeCredentials) {
    const statePathElements = [];
    const statePathIndices = [];
    let index = entry.leafIndex;

    for (let level = 0; level < depth; level += 1) {
      statePathElements.push(levels[level][index ^ 1]);
      statePathIndices.push(index & 1);
      index = Math.floor(index / 2);
    }

    memberships.set(entry.fixture, {
      credentialCommitment: entry.credentialCommitment,
      activeLeaf: entry.activeLeaf,
      leafIndex: entry.leafIndex,
      statePathElements,
      statePathIndices,
    });
  }

  return {
    depth,
    capacity,
    root: levels[depth][0],
    activeCredentials,
    memberships,
  };
}
