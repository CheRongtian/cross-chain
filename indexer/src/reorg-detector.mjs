import {
  CanonicalHistoryBootstrapError,
  FinalizedSourceReorgError,
  NoCommonAncestorError,
  fetchCanonicalBlock,
  fetchCanonicalBlockRange,
  findCommonAncestor,
} from "./canonical-block.mjs";
import { toUint256 } from "./canonical-message.mjs";
import { createCanonicalStore, createDatabaseStore } from "./db.mjs";

function minimum(left, right) {
  return left < right ? left : right;
}

export function createCanonicalReconciler({
  config,
  pool,
  publicClient,
  canonicalStore = createCanonicalStore(pool, config.databaseSchema),
  cursorStore = createDatabaseStore(pool, config.databaseSchema),
  logger = console,
}) {
  const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };

  async function bootstrap(headBlock, cursorNextBlock) {
    const startBlock = toUint256(
      config.sourceGatewayStartBlock,
      "SourceGateway start block",
    );
    const anchorBlock = startBlock === 0n ? 0n : startBlock - 1n;

    if (cursorNextBlock === startBlock && anchorBlock > headBlock) {
      return { bootstrapped: false, blocksPersisted: 0 };
    }

    let throughBlock;
    if (cursorNextBlock === 0n) {
      throughBlock = 0n;
    } else {
      throughBlock = cursorNextBlock - 1n;
    }
    if (throughBlock < anchorBlock) {
      throughBlock = anchorBlock;
    }
    if (throughBlock > headBlock) {
      throw new CanonicalHistoryBootstrapError(
        "Pre-existing canonical history extends beyond the current Chain A head. Automatic bootstrap is unsafe because canonical block history was not persisted before migration 004.",
      );
    }

    const blocks = await fetchCanonicalBlockRange(publicClient, anchorBlock, throughBlock);
    const result = await canonicalStore.bootstrapCanonicalHistory(scope, {
      expectedNextBlock: cursorNextBlock,
      blocks,
    });
    return { bootstrapped: true, blocksPersisted: result.blocksPersisted };
  }

  return {
    async reconcile({ headBlock }) {
      const normalizedHead = toUint256(headBlock, "canonical reconciliation head");
      const cursorNextBlock = await cursorStore.loadOrInitializeCursor(
        scope,
        config.sourceGatewayStartBlock,
      );
      let history = await canonicalStore.readCanonicalHistoryState(scope);
      let bootstrapResult = { bootstrapped: false, blocksPersisted: 0 };

      if (history.count === 0) {
        bootstrapResult = await bootstrap(normalizedHead, cursorNextBlock);
        history = await canonicalStore.readCanonicalHistoryState(scope);
      }

      if (history.count === 0) {
        return {
          detected: false,
          headBlock: normalizedHead,
          oldIndexedHead: undefined,
          commonAncestor: undefined,
          forkBlock: undefined,
          reorgedMessages: 0,
          rewoundNextBlock: cursorNextBlock,
          ...bootstrapResult,
        };
      }

      const oldIndexedHead = history.lastBlock;
      const probeBlock = minimum(oldIndexedHead, normalizedHead);
      const storedProbe = await canonicalStore.readCanonicalBlock(scope, probeBlock);
      if (storedProbe === undefined) {
        throw new NoCommonAncestorError(
          `Persisted canonical history does not contain current probe block ${probeBlock}. Manual intervention is required.`,
        );
      }
      const currentProbe = await fetchCanonicalBlock(publicClient, probeBlock);

      if (oldIndexedHead <= normalizedHead && storedProbe.hash === currentProbe.hash) {
        return {
          detected: false,
          headBlock: normalizedHead,
          oldIndexedHead,
          commonAncestor: oldIndexedHead,
          forkBlock: undefined,
          reorgedMessages: 0,
          rewoundNextBlock: cursorNextBlock,
          ...bootstrapResult,
        };
      }

      const storedBlocks = await canonicalStore.readCanonicalBlocksDescending(
        scope,
        probeBlock,
      );
      const commonAncestorBlock = await findCommonAncestor({
        storedBlocks,
        probeBlock,
        getCanonicalBlock: (blockNumber) => fetchCanonicalBlock(publicClient, blockNumber),
      });
      const commonAncestor = commonAncestorBlock.number;
      const forkBlock = commonAncestor + 1n;

      logger.log("Source reorg detected");
      logger.log(`Old indexed head: ${oldIndexedHead}`);
      logger.log(`Current chain head: ${normalizedHead}`);
      logger.log(`Common ancestor: ${commonAncestor}`);
      logger.log(`Fork block: ${forkBlock}`);

      let recovered;
      try {
        recovered = await canonicalStore.recoverCanonicalReorg(scope, {
          commonAncestor: commonAncestorBlock,
          forkBlock,
        });
      } catch (error) {
        if (error instanceof FinalizedSourceReorgError) {
          logger.error("FINALITY INTEGRITY VIOLATION");
          logger.error(
            "A source reorg reached a message that had already satisfied the configured finality policy.",
          );
          logger.error("Automatic recovery aborted.");
        }
        throw error;
      }

      logger.log(`Unfinalized messages marked REORGED: ${recovered.reorgedMessages}`);
      logger.log(`Cursor rewound to: ${recovered.rewoundNextBlock}`);

      return {
        detected: true,
        headBlock: normalizedHead,
        oldIndexedHead,
        commonAncestor,
        forkBlock,
        reorgedMessages: recovered.reorgedMessages,
        rewoundNextBlock: recovered.rewoundNextBlock,
        deletedCanonicalBlocks: recovered.deletedCanonicalBlocks,
        ...bootstrapResult,
      };
    },
  };
}
