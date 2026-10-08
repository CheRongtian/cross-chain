import { createPublicClient, http } from "viem";

import { createDatabaseStore } from "./db.mjs";
import {
  CROSS_CHAIN_MESSAGE_EVENT,
  decodeCrossChainMessageLog,
  sourceEventToDatabaseRow,
} from "./source-gateway-event.mjs";

function requireNonNegativeBigInt(value, label) {
  const result = BigInt(value);
  if (result < 0n) {
    throw new Error(`${label} must be non-negative`);
  }
  return result;
}

export function calculateScanRange(nextBlock, snapshotHead, blockRange) {
  const fromBlock = requireNonNegativeBigInt(nextBlock, "next block");
  const head = requireNonNegativeBigInt(snapshotHead, "snapshot head");
  const range = BigInt(blockRange);

  if (range <= 0n) {
    throw new Error("block range must be greater than zero");
  }
  if (fromBlock > head) {
    return undefined;
  }

  const boundedEnd = fromBlock + range - 1n;
  return { fromBlock, toBlock: boundedEnd < head ? boundedEnd : head };
}

function logPosition(log, field) {
  if (log[field] === null || log[field] === undefined) {
    throw new Error(`source log is missing ${field}`);
  }
  return BigInt(log[field]);
}

export function sortSourceLogs(logs) {
  return [...logs].sort((left, right) => {
    const blockDifference = logPosition(left, "blockNumber") - logPosition(right, "blockNumber");
    if (blockDifference !== 0n) {
      return blockDifference < 0n ? -1 : 1;
    }

    const logDifference = logPosition(left, "logIndex") - logPosition(right, "logIndex");
    return logDifference === 0n ? 0 : logDifference < 0n ? -1 : 1;
  });
}

export function createChainClient(config) {
  return createPublicClient({ transport: http(config.chainRpcUrl) });
}

export async function validateChainSource(publicClient, config) {
  const actualChainId = BigInt(await publicClient.request({ method: "eth_chainId" }));
  if (actualChainId !== config.chainDomain) {
    throw new Error(
      `Chain A domain mismatch: configured ${config.chainDomain}, RPC returned ${actualChainId}`,
    );
  }

  const bytecode = await publicClient.getBytecode({ address: config.sourceGateway });
  if (bytecode === undefined || bytecode === "0x") {
    throw new Error(`no contract bytecode at configured SourceGateway ${config.sourceGateway}`);
  }
}

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

export function createIndexer({
  config,
  pool,
  publicClient = createChainClient(config),
  store = createDatabaseStore(pool, config.databaseSchema),
  logger = console,
}) {
  const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };

  return {
    async catchUpOnce() {
      const snapshotHead = await publicClient.getBlockNumber();
      let nextBlock = await store.loadOrInitializeCursor(scope, config.sourceGatewayStartBlock);
      const initialNextBlock = nextBlock;
      let persistedRows = 0;
      let scannedRanges = 0;

      logger.log(`Indexer chain domain: ${config.chainDomain}`);
      logger.log(`Indexer source gateway: ${config.sourceGateway}`);
      logger.log(`Cursor next block: ${nextBlock}`);
      logger.log(`One-shot snapshot head: ${snapshotHead}`);

      for (;;) {
        const range = calculateScanRange(nextBlock, snapshotHead, config.blockRange);
        if (range === undefined) {
          break;
        }

        logger.log(`Scanning blocks ${range.fromBlock}-${range.toBlock}`);
        const logs = await publicClient.getLogs({
          address: config.sourceGateway,
          event: CROSS_CHAIN_MESSAGE_EVENT,
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          strict: true,
        });
        const rows = sortSourceLogs(logs).map((log) =>
          sourceEventToDatabaseRow(
            decodeCrossChainMessageLog(log, {
              expectedGateway: config.sourceGateway,
              expectedSourceDomain: config.chainDomain,
            }),
          ),
        );

        logger.log(`CrossChainMessage logs found: ${rows.length}`);
        const committed = await store.persistRange(scope, {
          fromBlock: range.fromBlock,
          toBlock: range.toBlock,
          rows,
        });
        nextBlock = committed.nextBlock;
        persistedRows += committed.persistedRows;
        scannedRanges += 1;
        logger.log(`Rows persisted: ${committed.persistedRows}`);
        logger.log(`New cursor next block: ${nextBlock}`);
      }

      return { initialNextBlock, nextBlock, persistedRows, scannedRanges, snapshotHead };
    },

    async runContinuous({ signal } = {}) {
      while (!signal?.aborted) {
        await this.catchUpOnce();
        if (signal?.aborted) {
          break;
        }
        await waitForPoll(config.pollIntervalMs, signal);
      }
    },
  };
}
