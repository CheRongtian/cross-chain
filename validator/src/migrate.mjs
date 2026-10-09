import { loadValidatorDatabaseConfig } from "./config.mjs";
import { applyValidatorMigrations, createValidatorPool } from "./db.mjs";

const config = loadValidatorDatabaseConfig();
const pool = createValidatorPool(config);
try {
  await applyValidatorMigrations(pool, config.databaseSchema);
  console.log(`Validator migration applied to ${config.databaseSchema}`);
} finally { await pool.end(); }
