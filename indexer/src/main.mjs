import { loadConfig } from "./config.mjs";
import { applyMigrations, createDatabasePool } from "./db.mjs";
import { createChainClient, createIndexer, validateChainSource } from "./indexer.mjs";

const argumentsList = process.argv.slice(2);
if (argumentsList.some((argument) => argument !== "--once") || argumentsList.length > 1) {
  throw new Error("usage: node src/main.mjs [--once]");
}

const oneShot = argumentsList[0] === "--once";
const config = loadConfig();
const pool = createDatabasePool(config);
const publicClient = createChainClient(config);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await applyMigrations(pool, config.databaseSchema);
  await validateChainSource(publicClient, config);
  const indexer = createIndexer({ config, pool, publicClient });

  if (oneShot) {
    await indexer.catchUpOnce();
  } else {
    await indexer.runContinuous({ signal: controller.signal });
  }
} finally {
  await pool.end();
}
