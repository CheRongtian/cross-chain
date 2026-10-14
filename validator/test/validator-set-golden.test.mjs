import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canonicalCommittee, committeeDigest, COMMITTEE_TYPE } from "../src/committee.mjs";
import { createValidatorSetResolver } from "../src/validator-sets.mjs";
import { validatorAccount } from "../src/identity.mjs";
import { developmentKeys } from "./helpers/fixtures.mjs";

const vector = JSON.parse(readFileSync(new URL("../../test-vectors/validator-sets.json", import.meta.url), "utf8"));
const trustedHistory = vector.history.map(({ canonicalValidators, ...entry }) => entry);

function permutations(addresses) {
  if (addresses.length === 0) return [[]];
  return addresses.flatMap((address, index) => permutations(addresses.filter((_, other) => other !== index))
    .map((remaining) => [address, ...remaining]));
}

test("shared committee vectors match the actual five development identities and existing digest format", () => {
  assert.equal(vector.committeeType, COMMITTEE_TYPE);
  assert.equal(vector.committeeVersion, 1);
  assert.equal(vector.digestAbi, "bytes32,uint8,address[4]");
  assert.deepEqual(vector.digestFields, ["committeeTypeHash", "committeeVersion", "canonicalValidators"]);
  assert.equal(vector.quorum, 3);
  const identities = developmentKeys(5).map((key) => validatorAccount(key).address.toLowerCase());
  assert.deepEqual(vector.directory, identities);
  assert.deepEqual(vector.history[0].validators, identities.slice(0, 4));
  assert.deepEqual(vector.history[1].validators, identities.slice(1));
  const resolver = createValidatorSetResolver(trustedHistory);
  for (const entry of vector.history) {
    assert.match(entry.validatorEpoch, /^(0|[1-9][0-9]*)$/);
    assert.match(entry.committeeDigest, /^0x[0-9a-f]{64}$/);
    const actual = resolver.resolveByValidatorEpoch(entry.validatorEpoch);
    assert.deepEqual(actual.validators, entry.canonicalValidators);
    assert.equal(actual.committeeDigest, entry.committeeDigest);
  }
  assert.notEqual(vector.history[0].committeeDigest, vector.history[1].committeeDigest);
});

test("all 24 permutations of each golden committee retain its independently frozen ordering and digest", () => {
  for (const entry of vector.history) {
    const inputs = permutations(entry.validators);
    assert.equal(inputs.length, 24);
    for (const input of inputs) {
      assert.deepEqual(canonicalCommittee(input), entry.canonicalValidators);
      assert.equal(committeeDigest(input), entry.committeeDigest);
    }
  }
});

test("exact large historical epochs retain the same committee encoding independently of batch sequencing", () => {
  const initial = (1n << 200n) + 7n;
  const resolver = createValidatorSetResolver([
    { ...trustedHistory[0], validatorEpoch: initial.toString(), activationBatchEpoch: "23" },
    { ...trustedHistory[0], validatorEpoch: (initial + 1n).toString(), activationBatchEpoch: "24" },
  ]);
  assert.equal(resolver.resolveForBatchEpoch("23").validatorEpoch, initial.toString());
  assert.equal(resolver.resolveForBatchEpoch("24").validatorEpoch, (initial + 1n).toString());
  assert.equal(resolver.resolveByValidatorEpoch(initial.toString()).committeeDigest, vector.history[0].committeeDigest);
  assert.equal(resolver.resolveByValidatorEpoch((initial + 1n).toString()).committeeDigest, vector.history[0].committeeDigest);
  assert.throws(() => resolver.resolveByValidatorEpoch("23"), /UNKNOWN_VALIDATOR_EPOCH/);
});

test("a frozen digest cannot authorize changed members or a different claimed committee digest", () => {
  const changed = [...trustedHistory[0].validators];
  changed[3] = vector.directory[4];
  assert.notEqual(committeeDigest(changed), vector.history[0].committeeDigest);
  assert.throws(() => createValidatorSetResolver([{ ...trustedHistory[0], validators: changed }]), /WRONG_COMMITTEE/);
  assert.throws(() => createValidatorSetResolver([
    { ...trustedHistory[0], committeeDigest: vector.history[1].committeeDigest },
  ]), /WRONG_COMMITTEE/);
});
