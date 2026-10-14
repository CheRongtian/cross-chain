import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { canonicalCommittee, COMMITTEE_TYPE } from "../validator/src/committee.mjs";
import { createValidatorSetResolver } from "../validator/src/validator-sets.mjs";

// Fixed public deployment history shared with the Foundry and validator golden tests.
// Expected digests are frozen evidence; this exporter checks them and never regenerates them.
const vector = JSON.parse(readFileSync(new URL("../test-vectors/validator-sets.json", import.meta.url), "utf8"));
assert.equal(vector.committeeType, COMMITTEE_TYPE);
assert.equal(vector.committeeVersion, 1);
assert.equal(vector.quorum, 3);
assert.equal(vector.history.length, 2);
const resolver = createValidatorSetResolver(vector.history.map(({ canonicalValidators, ...entry }) => {
  assert.deepEqual(canonicalCommittee(entry.validators), canonicalValidators);
  return entry;
}));
assert.deepEqual(resolver.history.map((entry) => entry.validatorEpoch), ["7", "8"]);
assert.deepEqual(vector.directory, [...vector.history[0].validators, vector.history[1].validators[3]]);

// Only validated public addresses, digests and exact decimal epochs enter the shell assignments.
for (const [index, label] of ["INITIAL", "ROTATED"].entries()) {
  const entry = resolver.history[index];
  console.log(`VALIDATOR_${label}_EPOCH=${entry.validatorEpoch}`);
  console.log(`VALIDATOR_${label}_MEMBERS='[${entry.validators.join(",")}]'`);
  console.log(`VALIDATOR_${label}_DIGEST=${entry.committeeDigest}`);
}
for (const [index, address] of vector.directory.entries()) {
  console.log(`VALIDATOR_IDENTITY_V${index + 1}=${address}`);
}
