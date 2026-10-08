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

function blockHash(number) {
  return `0x${number.toString(16).padStart(64, "0")}`;
}

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
  const reconciliationHeads = [];
  let headReads = 0;
  let cursor = 1n;

  const publicClient = {
    async request({ method }) {
      assert.equal(method, "eth_blockNumber");
      headReads += 1;
      return headReads === 1 ? "0x5" : "0x64";
    },
    async getBlock({ blockNumber }) {
      return {
        number: blockNumber,
        hash: blockHash(blockNumber + 1n),
        parentHash: blockHash(blockNumber),
      };
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
      committedRanges.push({
        range: [range.fromBlock, range.toBlock],
        blocks: range.blocks.map((block) => block.number),
      });
      cursor = range.toBlock + 1n;
      return { inserted: range.rows.length, duplicates: 0, nextBlock: cursor };
    },
  };
  const reconciler = {
    async reconcile({ headBlock }) {
      reconciliationHeads.push(headBlock);
      return { detected: false, headBlock };
    },
  };
  const logger = { log() {} };
  const result = await createIndexer({
    config: CONFIG,
    pool: undefined,
    publicClient,
    store,
    reconciler,
    logger,
  }).catchUpOnce();

  assert.equal(headReads, 1);
  assert.deepEqual(queriedRanges, [
    [1n, 2n],
    [3n, 4n],
    [5n, 5n],
  ]);
  assert.deepEqual(committedRanges, [
    { range: [1n, 2n], blocks: [1n, 2n] },
    { range: [3n, 4n], blocks: [3n, 4n] },
    { range: [5n, 5n], blocks: [5n] },
  ]);
  assert.deepEqual(reconciliationHeads, [5n]);
  assert.equal(result.snapshotHead, 5n);
  assert.equal(result.nextBlock, 6n);
  assert.equal(result.insertedRows, 0);
  assert.equal(result.duplicateRows, 0);
});

test("reloads a cursor rewound by canonical reconciliation", async () => {
  const cursorReads = [8n, 5n];
  const scanned = [];
  const publicClient = {
    async request() {
      return "0x6";
    },
    async getBlock({ blockNumber }) {
      return {
        number: blockNumber,
        hash: blockHash(blockNumber + 1n),
        parentHash: blockHash(blockNumber),
      };
    },
    async getLogs({ fromBlock, toBlock }) {
      scanned.push([fromBlock, toBlock]);
      return [];
    },
  };
  const store = {
    async loadOrInitializeCursor() {
      return cursorReads.shift();
    },
    async persistRange(_scope, range) {
      return { inserted: 0, duplicates: 0, nextBlock: range.toBlock + 1n };
    },
  };

  const result = await createIndexer({
    config: CONFIG,
    pool: undefined,
    publicClient,
    store,
    reconciler: {
      async reconcile() {
        return { detected: true, forkBlock: 5n, rewoundNextBlock: 5n };
      },
    },
    logger: { log() {} },
  }).catchUpOnce();

  assert.equal(result.initialNextBlock, 8n);
  assert.equal(result.nextBlock, 7n);
  assert.deepEqual(scanned, [[5n, 6n]]);
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
