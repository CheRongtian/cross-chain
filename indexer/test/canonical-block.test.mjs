import assert from "node:assert/strict";
import test from "node:test";

import {
  CanonicalDivergenceError,
  NoCommonAncestorError,
  findCommonAncestor,
  normalizeCanonicalBlock,
  validateCanonicalBlockSequence,
} from "../src/canonical-block.mjs";

function hash(value) {
  return `0x${value.toString(16).padStart(64, "0")}`;
}

function block(number, hashValue = number + 1n, parentHashValue = number) {
  return {
    number,
    hash: hash(hashValue),
    parentHash: hash(parentHashValue),
  };
}

test("normalizes canonical block metadata without Number conversion", () => {
  const number = (1n << 200n) + 7n;
  assert.deepEqual(
    normalizeCanonicalBlock({
      number: number.toString(),
      hash: `0x${"AB".repeat(32)}`,
      parentHash: `0x${"CD".repeat(32)}`,
    }),
    {
      number,
      hash: `0x${"ab".repeat(32)}`,
      parentHash: `0x${"cd".repeat(32)}`,
    },
  );
});

test("validates every block in a contiguous range including eventless blocks", () => {
  const predecessor = block(9n, 10n, 9n);
  const blocks = [
    block(10n, 11n, 10n),
    block(11n, 12n, 11n),
    block(12n, 13n, 12n),
  ];

  assert.deepEqual(
    validateCanonicalBlockSequence(blocks, {
      fromBlock: 10n,
      toBlock: 12n,
      predecessor,
    }),
    blocks,
  );
});

test("rejects broken parent-hash continuity", () => {
  assert.throws(
    () =>
      validateCanonicalBlockSequence(
        [block(10n, 11n, 10n), block(11n, 12n, 999n)],
        { fromBlock: 10n, toBlock: 11n },
      ),
    CanonicalDivergenceError,
  );
});

test("rejects a range that omits an empty block", () => {
  assert.throws(
    () =>
      validateCanonicalBlockSequence(
        [block(10n, 11n, 10n), block(12n, 13n, 12n)],
        { fromBlock: 10n, toBlock: 12n },
      ),
    /must contain every block/,
  );
});

test("finds a one-block fork common ancestor", async () => {
  const stored = [block(11n, 111n, 10n), block(10n, 10n, 9n)];
  const current = new Map([
    [11n, block(11n, 211n, 10n)],
    [10n, block(10n, 10n, 9n)],
  ]);

  const ancestor = await findCommonAncestor({
    storedBlocks: stored,
    probeBlock: 11n,
    getCanonicalBlock: async (number) => current.get(number),
  });
  assert.equal(ancestor.number, 10n);
});

test("finds a multi-block fork through an eventless block", async () => {
  const stored = [
    block(13n, 113n, 112n),
    block(12n, 112n, 111n),
    block(11n, 111n, 10n),
    block(10n, 10n, 9n),
  ];
  const current = new Map([
    [13n, block(13n, 213n, 212n)],
    [12n, block(12n, 212n, 211n)],
    [11n, block(11n, 211n, 10n)],
    [10n, block(10n, 10n, 9n)],
  ]);

  const ancestor = await findCommonAncestor({
    storedBlocks: stored,
    probeBlock: 13n,
    getCanonicalBlock: async (number) => current.get(number),
  });
  assert.equal(ancestor.number, 10n);
});

test("supports common ancestor search after head regression", async () => {
  const stored = [block(11n, 111n, 10n), block(10n, 10n, 9n)];
  const ancestor = await findCommonAncestor({
    storedBlocks: stored,
    probeBlock: 11n,
    getCanonicalBlock: async (number) =>
      number === 11n ? block(11n, 211n, 10n) : block(10n, 10n, 9n),
  });
  assert.equal(ancestor.number, 10n);
});

test("fails closed when no common ancestor exists in persisted history", async () => {
  await assert.rejects(
    findCommonAncestor({
      storedBlocks: [block(11n, 111n, 110n), block(10n, 110n, 9n)],
      probeBlock: 11n,
      getCanonicalBlock: async (number) => block(number, number + 1000n, number + 999n),
    }),
    NoCommonAncestorError,
  );
});
