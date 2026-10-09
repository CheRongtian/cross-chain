import { loadConfig } from "../../src/config.mjs";
import { createDatabasePool } from "../../src/db.mjs";
import { createBatchLifecycle } from "../../src/batch-lifecycle.mjs";

// Test-only transport for checking that no parent-process memory is needed.
const config = loadConfig();
const pool = createDatabasePool(config);
try {
  const snapshot = await createBatchLifecycle({ config, pool }).readBatch({
    batchRecordId: process.argv[2],
  });
  process.stdout.write(JSON.stringify(snapshot, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  ));
} finally {
  await pool.end();
}
