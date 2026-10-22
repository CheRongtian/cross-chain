import {
  CanonicalHistoryBootstrapError,
  CanonicalHistoryChangedError,
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
      for (;;) {
        try {
          return await reconcileSnapshot(normalizedHead);
        } catch (error) {
          if (!(error instanceof CanonicalHistoryChangedError)) throw error;
          logger.log("Canonical history changed during source reconciliation; reconciling the same fixed snapshot again");
        }
      }
    },
  };

  async function reconcileSnapshot(normalizedHead) {
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
    // A caller's old snapshot cannot prove the source chain has regressed.
    // Refresh only regression evidence, never the caller's evaluation head.
    let recoveryHead = normalizedHead;
    if (oldIndexedHead > normalizedHead) {
      recoveryHead = toUint256(
        await publicClient.request({ method: "eth_blockNumber" }),
        "source regression confirmation head",
      );
    }
    let probeBlock = minimum(oldIndexedHead, minimum(normalizedHead, recoveryHead));
    let storedProbe = await canonicalStore.readCanonicalBlock(scope, probeBlock);
    if (storedProbe === undefined) {
      const latestHistory = await canonicalStore.readCanonicalHistoryState(scope);
      if (latestHistory.lastBlock !== history.lastBlock || latestHistory.firstBlock !== history.firstBlock ||
          latestHistory.count !== history.count) throw new CanonicalHistoryChangedError();
      throw new NoCommonAncestorError(
        `Persisted canonical history does not contain current probe block ${probeBlock}. Manual intervention is required.`,
      );
    }
    const currentProbe = await fetchCanonicalBlock(publicClient, probeBlock);

    if (storedProbe.hash === currentProbe.hash && recoveryHead >= oldIndexedHead) {
      if (oldIndexedHead > normalizedHead) {
        logger.log(`Canonical history advanced beyond fixed snapshot ${normalizedHead}: indexed head ${oldIndexedHead}`);
        logger.log("Snapshot prefix remains canonical; preserving newer blocks, messages and cursor");
      }
      return {
        detected: false,
        headBlock: normalizedHead,
        oldIndexedHead,
        commonAncestor: probeBlock,
        forkBlock: undefined,
        reorgedMessages: 0,
        rewoundNextBlock: await cursorStore.loadOrInitializeCursor(scope, config.sourceGatewayStartBlock),
        ...bootstrapResult,
      };
    }

    // A confirmed rollback may leave valid blocks between the fixed snapshot
    // and the actual lower chain head. Preserve that still-canonical suffix.
    if (storedProbe.hash === currentProbe.hash && recoveryHead > probeBlock) {
      probeBlock = recoveryHead;
      storedProbe = await canonicalStore.readCanonicalBlock(scope, probeBlock);
      if (storedProbe === undefined) throw new CanonicalHistoryChangedError();
    }

    const expectedHead = await canonicalStore.readCanonicalBlock(scope, oldIndexedHead);
    if (expectedHead === undefined) throw new CanonicalHistoryChangedError();

    const storedBlocks = await canonicalStore.readCanonicalBlocksDescending(
      scope,
      probeBlock,
    );
    let commonAncestorBlock;
    try {
      commonAncestorBlock = await findCommonAncestor({
        storedBlocks,
        probeBlock,
        getCanonicalBlock: (blockNumber) => fetchCanonicalBlock(publicClient, blockNumber),
      });
    } catch (error) {
      if (error instanceof NoCommonAncestorError) {
        const latestHistory = await canonicalStore.readCanonicalHistoryState(scope);
        const latestProbe = await canonicalStore.readCanonicalBlock(scope, probeBlock);
        const latestHead = await canonicalStore.readCanonicalBlock(scope, oldIndexedHead);
        if (latestHistory.lastBlock !== history.lastBlock || latestHistory.firstBlock !== history.firstBlock ||
            latestHistory.count !== history.count || latestProbe?.hash !== storedProbe.hash ||
            latestHead?.hash !== expectedHead.hash) {
          throw new CanonicalHistoryChangedError("canonical history changed during ancestor search");
        }
      }
      throw error;
    }
    const commonAncestor = commonAncestorBlock.number;
    const forkBlock = commonAncestor + 1n;

    if (commonAncestor === probeBlock && recoveryHead >= oldIndexedHead) {
      throw new CanonicalHistoryChangedError("source divergence disappeared during ancestor search");
    }
    if (recoveryHead < oldIndexedHead) {
      const confirmedHead = toUint256(
        await publicClient.request({ method: "eth_blockNumber" }),
        "source rollback confirmation head",
      );
      if (confirmedHead !== recoveryHead) {
        throw new CanonicalHistoryChangedError("source rollback head changed before recovery");
      }
    }

    logger.log("Source reorg detected");
    logger.log(`Old indexed head: ${oldIndexedHead}`);
    logger.log(`Fixed reconciliation snapshot: ${normalizedHead}`);
    logger.log(`Recovery evidence chain head: ${recoveryHead}`);
    logger.log(`Common ancestor: ${commonAncestor}`);
    logger.log(`Fork block: ${forkBlock}`);

    let recovered;
    try {
      recovered = await canonicalStore.recoverCanonicalReorg(scope, {
        commonAncestor: commonAncestorBlock,
        forkBlock,
        expectedState: { nextBlock: cursorNextBlock, head: expectedHead, probe: storedProbe },
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
  }
}
