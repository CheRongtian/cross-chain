import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { safeRelayerMessage } from "../../src/relayer/config.mjs";
import { loadTransactionConfig } from "../../src/transaction-manager/config.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { createRelayerWorker } from "../../src/relayer/service.mjs";

// Deterministic verification-only send failure. No production fault flag exists.
const config = loadTransactionConfig();
const pool = createDatabasePool(config);
try {
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  const rpc = { ...createTransactionRpc(config),async broadcast() {
    throw Object.assign(new Error("expected injected Relayer RPC submission failure"),{ code: "ECONNREFUSED" });
  } };
  const transactionManager = createTransactionManager({ config,pool,queue,rpc,legacy: repository });
  await createRelayerWorker({ config,pool,queue,transactionManager }).runOnce();
  throw new Error("injected submission failure unexpectedly succeeded");
} catch (error) {
  console.error(safeRelayerMessage(error,config));
  process.exitCode = 1;
} finally { await pool.end(); }
