import { loadDatabaseConfig } from "./config.mjs";
import { applyMigrations, createDatabasePool } from "./db.mjs";

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  const migrations = await applyMigrations(pool, config.databaseSchema);
  console.log(`Applied Chain A Indexer migrations in schema ${config.databaseSchema}:`);
  for (const migration of migrations) {
    console.log(`- ${migration}`);
  }
} finally {
  await pool.end();
}
