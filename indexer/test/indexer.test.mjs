import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateScanRange,
  createIndexer,
  sortSourceLogs,
  validateChainSource,
} from "../src/indexer.mjs";

const CONFIG = {
  chainDomain: 10_011n,
  sourceGateway: "0x0000000000000000000000000000000000001001",
  sourceGatewayStartBlock: 1n,
  blockRange: 2n,
  pollIntervalMs: 10,
  databaseSchema: "unused_in_unit_test",
};

test("calculates bounded scan ranges", () => {
  assert.deepEqual(calculateScanRange(10n, 20n, 5n), { fromBlock: 10n, toBlock: 14n });
  assert.deepEqual(calculateScanRange(18n, 20n, 5n), { fromBlock: 18n, toBlock: 20n });
  assert.equal(calculateScanRange(21n, 20n, 5n), undefined);
  assert.throws(() => calculateScanRange(1n, 2n, 0n), /greater than zero/);
});

test("sorts logs by block number and log index", () => {
  const logs = [
    { blockNumber: 9n, logIndex: 2 },
    { blockNumber: 8n, logIndex: 5 },
    { blockNumber: 9n, logIndex: 1 },
  ];

  assert.deepEqual(
    sortSourceLogs(logs).map((log) => [log.blockNumber, log.logIndex]),
    [
      [8n, 5],
      [9n, 1],
      [9n, 2],
    ],
  );
});

test("one-shot indexing scans only to its startup snapshot head", async () => {
  const queriedRanges = [];
  const committedRanges = [];
  let headReads = 0;
  let cursor = 1n;

  const publicClient = {
    async getBlockNumber() {
      headReads += 1;
      return headReads === 1 ? 5n : 100n;
    },
    async getLogs({ fromBlock, toBlock }) {
      queriedRanges.push([fromBlock, toBlock]);
      return [];
    },
  };
  const store = {
    async loadOrInitializeCursor() {
      return cursor;
    },
    async persistRange(_scope, range) {
      committedRanges.push([range.fromBlock, range.toBlock]);
      cursor = range.toBlock + 1n;
      return { inserted: range.rows.length, duplicates: 0, nextBlock: cursor };
    },
  };
  const logger = { log() {} };
  const result = await createIndexer({
    config: CONFIG,
    pool: undefined,
    publicClient,
    store,
    logger,
  }).catchUpOnce();

  assert.equal(headReads, 1);
  assert.deepEqual(queriedRanges, [
    [1n, 2n],
    [3n, 4n],
    [5n, 5n],
  ]);
  assert.deepEqual(committedRanges, queriedRanges);
  assert.equal(result.snapshotHead, 5n);
  assert.equal(result.nextBlock, 6n);
  assert.equal(result.insertedRows, 0);
  assert.equal(result.duplicateRows, 0);
});

test("validates RPC chain identity and SourceGateway bytecode", async () => {
  await validateChainSource(
    {
      async request({ method }) {
        assert.equal(method, "eth_chainId");
        return "0x271b";
      },
      async getBytecode() {
        return "0x6000";
      },
    },
    CONFIG,
  );

  await assert.rejects(
    validateChainSource(
      {
        async request() {
          return "0x271c";
        },
        async getBytecode() {
          return "0x6000";
        },
      },
      CONFIG,
    ),
    /Chain A domain mismatch/,
  );

  await assert.rejects(
    validateChainSource(
      {
        async request() {
          return "0x271b";
        },
        async getBytecode() {
          return "0x";
        },
      },
      CONFIG,
    ),
    /no contract bytecode/,
  );
});
