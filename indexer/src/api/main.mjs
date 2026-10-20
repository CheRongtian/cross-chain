import { createDatabasePool } from "../db.mjs";
import { loadMessageQueryConfig, publicMessageQueryConfig } from "./config.mjs";
import { createMessageQuery } from "./message-query.mjs";
import { createMessageQueryServer } from "./server.mjs";
import { publicQueryError } from "./errors.mjs";

const pools = []; let runtime;
try {
  const config = loadMessageQueryConfig();
  const ownPool = configuration => {
    const pool = createDatabasePool(configuration);
    pool.on("error", () => console.error("Message query database connection unavailable"));
    pools.push(pool); return pool;
  };
  const pool = ownPool(config);
  const validatorReaders = config.validatorStores.map(store => ({ config: store, pool: ownPool(store) }));
  runtime = createMessageQueryServer({ config, query: createMessageQuery({ config, pool, validatorReaders }) });
  const stopped = new Promise(resolve => { process.once("SIGINT", resolve); process.once("SIGTERM", resolve); });
  await runtime.listen();
  console.log("Read-only message query API ready:", publicMessageQueryConfig(config));
  await stopped;
} catch (error) {
  console.error(`Message query API stopped: ${publicQueryError(error).body.error}`);
  process.exitCode = 1;
} finally {
  const results = await Promise.allSettled([runtime?.close()]);
  results.push(...await Promise.allSettled(pools.map(pool => pool.end())));
  if (results.some(result => result.status === "rejected")) { console.error("Message query API cleanup failed"); process.exitCode = 1; }
}
