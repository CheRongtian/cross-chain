import { loadDatabaseConfig } from "./config.mjs";
import { applyMigration, createDatabasePool } from "./db.mjs";

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  await applyMigration(pool, config.databaseSchema);
  console.log(`Applied Chain A Indexer migration in schema ${config.databaseSchema}.`);
} finally {
  await pool.end();
}
