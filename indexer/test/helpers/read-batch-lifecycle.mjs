import { createValidatorSetResolver } from "../../../validator/src/validator-sets.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createDatabasePool } from "../../src/db.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";

// Test-only transport for checking that no parent-process memory is needed.
const config = loadConfig();
const pool = createDatabasePool(config);
try {
  const committee = process.env.EXPECTED_VALIDATOR_COMMITTEE
    ? JSON.parse(process.env.EXPECTED_VALIDATOR_COMMITTEE) : undefined;
  const validatorSets = process.env.EXPECTED_VALIDATOR_SET_HISTORY ? createValidatorSetResolver(JSON.parse(process.env.EXPECTED_VALIDATOR_SET_HISTORY)) : undefined;
  const snapshot = await createBatchLifecycle({ config, pool, committee, validatorSets }).readBatch({
    batchRecordId: process.argv[2],
  });
  process.stdout.write(JSON.stringify(snapshot, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  ));
} finally {
  await pool.end();
}
