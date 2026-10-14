import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, http } from "viem";
import { normalizeAddress } from "../../../indexer/src/canonical-message.mjs";
import { protocolInteger } from "../../src/committee.mjs";

// A verification reader of contract storage. It never derives registry authority from QCs.
export async function createValidatorRegistryChecks({ registryAddress, rpcUrl, history }) {
  const address = normalizeAddress(registryAddress, "ValidatorSetRegistry address");
  assert.ok(rpcUrl, "Chain B RPC URL is required for historical registry verification");
  const { abi } = JSON.parse(readFileSync(
    new URL("../../../contracts/out/ValidatorSetRegistry.sol/ValidatorSetRegistry.json", import.meta.url), "utf8",
  ));
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 10000 }) });
  assert.equal(await client.getChainId(), 2001, "ValidatorSetRegistry must be on Chain B");
  const read = (functionName, args = []) => client.readContract({ address, abi, functionName, args });
  const historicalRecords = new Map();

  async function assertHistory() {
    assert.equal(await read("hasValidatorHistory"), true);
    assert.equal(await read("initialValidatorEpoch"), protocolInteger(history[0].validatorEpoch));
    assert.equal(await read("latestValidatorEpoch"), protocolInteger(history.at(-1).validatorEpoch));
    for (const entry of history) {
      const epoch = protocolInteger(entry.validatorEpoch, "validator epoch");
      const [validators, quorum, committeeDigest] = await read("getValidatorSet", [epoch]);
      const actual = { validators: validators.map((member) => member.toLowerCase()), quorum, committeeDigest };
      assert.deepEqual(actual.validators, entry.validators, `Chain B epoch ${epoch} canonical committee drift`);
      assert.equal(actual.quorum, 3, `Chain B epoch ${epoch} quorum drift`);
      assert.equal(actual.committeeDigest, entry.committeeDigest, `Chain B epoch ${epoch} digest drift`);
      if (historicalRecords.has(epoch.toString())) {
        assert.deepEqual(actual, historicalRecords.get(epoch.toString()), `Chain B epoch ${epoch} history changed`);
      } else {
        historicalRecords.set(epoch.toString(), actual);
      }
      console.log(`VALID: actual validator trusted history / Chain B epoch ${epoch} committee ordering, quorum and digest match`);
    }
  }

  async function assertQcBinding(certificate) {
    const epoch = protocolInteger(certificate.validatorEpoch, "QC validator epoch");
    const expected = historicalRecords.get(epoch.toString());
    assert.ok(expected, "QC epoch must have a preconfigured historical registry record");
    const [validators, quorum, committeeDigest] = await read("getValidatorSet", [epoch]);
    assert.deepEqual(validators.map((member) => member.toLowerCase()), expected.validators);
    assert.equal(quorum, expected.quorum);
    assert.equal(committeeDigest, expected.committeeDigest);
    assert.equal(certificate.committeeDigest, committeeDigest);
    console.log(`VALID: existing QC validator epoch ${epoch} / committee digest resolves to immutable Chain B history`);
  }

  await assertHistory();
  return { assertHistory, assertQcBinding };
}
