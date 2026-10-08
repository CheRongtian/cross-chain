import { loadDatabaseConfig } from "./config.mjs";
import { checkDatabaseConnection, createDatabasePool } from "./db.mjs";

const config = loadDatabaseConfig();
const pool = createDatabasePool(config);

try {
  await checkDatabaseConnection(pool);
  console.log("PostgreSQL connection verified.");
} finally {
  await pool.end();
}
