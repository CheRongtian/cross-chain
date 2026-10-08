import { createFinalityStore } from "./db.mjs";
import { createChainClient, readChainHead } from "./indexer.mjs";
import { createCanonicalReconciler } from "./reorg-detector.mjs";

function waitForPoll(intervalMs, signal) {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, intervalMs);
    signal?.addEventListener("abort", finish, { once: true });
  });
}

export function createFinalityWatcher({
  config,
  pool,
  publicClient = createChainClient(config),
  store = createFinalityStore(pool, config.databaseSchema),
  reconciler,
  logger = console,
}) {
  const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };
  const canonicalReconciler = reconciler ?? createCanonicalReconciler({
    config,
    pool,
    publicClient,
    logger,
  });

  return {
    async runFinalityPass() {
      const headBlock = await readChainHead(publicClient);
      await canonicalReconciler.reconcile({ headBlock });
      const result = await store.advanceFinality(scope, {
        headBlock,
        finalityBlockDepth: config.finalityBlockDepth,
      });

      logger.log(`Finality head: ${result.headBlock}`);
      logger.log(`Configured block depth: ${config.finalityBlockDepth}`);
      logger.log(`Candidates checked: ${result.candidatesChecked}`);
      logger.log(`OBSERVED -> FINALIZING: ${result.observedToFinalizing}`);
      logger.log(`OBSERVED -> FINALIZED: ${result.observedToFinalized}`);
      logger.log(`FINALIZING -> FINALIZED: ${result.finalizingToFinalized}`);
      logger.log(`FINALIZING unchanged: ${result.unchangedFinalizing}`);
      return result;
    },

    async runContinuous({ signal } = {}) {
      while (!signal?.aborted) {
        await this.runFinalityPass();
        if (signal?.aborted) {
          break;
        }
        await waitForPoll(config.finalityPollIntervalMs, signal);
      }
    },
  };
}
