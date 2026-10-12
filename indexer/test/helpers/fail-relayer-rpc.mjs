import { createDatabasePool } from "../../src/db.mjs";
import { createDeliveryRepository } from "../../src/delivery/repository.mjs";
import { loadRelayerConfig, safeRelayerMessage } from "../../src/relayer/config.mjs";
import { createRelaySubmissionRepository } from "../../src/relayer/repository.mjs";
import { createSingleRelayer } from "../../src/relayer/service.mjs";
import { createDirectRpcSubmitter } from "../../src/relayer/submitter.mjs";

// Deterministic verification-only send failure. No production fault flag exists.
const config = loadRelayerConfig();
const pool = createDatabasePool(config);
try {
  const queue = createDeliveryRepository({ config,pool });
  const repository = createRelaySubmissionRepository({ config,pool,queue });
  const direct = createDirectRpcSubmitter(config);
  const submitter = { verifyChain: () => direct.verifyChain(),async submit() {
    throw new Error("expected injected Relayer RPC submission failure");
  } };
  await createSingleRelayer({ config,queue,repository,submitter }).runOnce();
  throw new Error("injected submission failure unexpectedly succeeded");
} catch (error) {
  console.error(safeRelayerMessage(error,config));
  process.exitCode = 1;
} finally { await pool.end(); }
