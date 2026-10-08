import { loadConfig } from "./config.mjs";
import { applyMigrations, createDatabasePool } from "./db.mjs";
import { createFinalityWatcher } from "./finality-watcher.mjs";
import { createChainClient, createIndexer, validateChainSource } from "./indexer.mjs";

const argumentsList = process.argv.slice(2);
const mode = ["indexer", "finality"].includes(argumentsList[0]) ? argumentsList[0] : "indexer";
const modeArguments = mode === argumentsList[0] ? argumentsList.slice(1) : argumentsList;
if (modeArguments.some((argument) => argument !== "--once") || modeArguments.length > 1) {
  throw new Error("usage: node src/main.mjs [indexer|finality] [--once]");
}

const oneShot = modeArguments[0] === "--once";
const config = loadConfig();
const pool = createDatabasePool(config);
const publicClient = createChainClient(config);
const controller = new AbortController();

process.once("SIGINT", () => controller.abort());
process.once("SIGTERM", () => controller.abort());

try {
  await applyMigrations(pool, config.databaseSchema);
  await validateChainSource(publicClient, config);
  if (mode === "indexer") {
    const indexer = createIndexer({ config, pool, publicClient });
    if (oneShot) {
      await indexer.catchUpOnce();
    } else {
      await indexer.runContinuous({ signal: controller.signal });
    }
  } else {
    const watcher = createFinalityWatcher({ config, pool, publicClient });
    if (oneShot) {
      await watcher.runFinalityPass();
    } else {
      await watcher.runContinuous({ signal: controller.signal });
    }
  }
} finally {
  await pool.end();
}
