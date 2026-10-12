import { createDatabasePool } from "../db.mjs";
import { loadDeliveryConfig } from "./config.mjs";
import { createDeliveryProjector } from "./projector.mjs";

// This worker consumes migrated source persistence and never opens a chain RPC.
const config = loadDeliveryConfig();
const pool = createDatabasePool(config);
try {
  const result = await createDeliveryProjector({ config, pool }).projectCommittedBatches();
  console.log(`Delivery batches materialized: ${result.materializedBatches}`);
  console.log(`READY delivery jobs created: ${result.createdJobs}`);
} catch (error) {
  const message = error.message.replaceAll(config.databaseUrl, "<redacted>");
  console.error(`Delivery projection failed: ${message}`);
  process.exitCode = 1;
} finally { await pool.end(); }
