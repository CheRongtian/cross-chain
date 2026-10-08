import { normalizeBytes32, toUint256 } from "./canonical-message.mjs";

export class CanonicalDivergenceError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalDivergenceError";
  }
}

export class CanonicalHistoryBootstrapError extends Error {
  constructor(message) {
    super(message);
    this.name = "CanonicalHistoryBootstrapError";
  }
}

export class NoCommonAncestorError extends Error {
  constructor(message = "No common ancestor found within persisted canonical history. Manual intervention is required.") {
    super(message);
    this.name = "NoCommonAncestorError";
  }
}

export class FinalizedSourceReorgError extends Error {
  constructor(forkBlock, finalizedMessages) {
    super(
      `source reorg from block ${forkBlock} reaches ${finalizedMessages} FINALIZED message occurrence(s); automatic recovery aborted`,
    );
    this.name = "FinalizedSourceReorgError";
    this.forkBlock = BigInt(forkBlock);
    this.finalizedMessages = finalizedMessages;
  }
}

export function normalizeCanonicalBlock(block) {
  if (block === null || block === undefined) {
    throw new Error("canonical block is missing");
  }
  if (block.number === null || block.number === undefined) {
    throw new Error("canonical block is missing number");
  }

  return {
    number: toUint256(block.number, "canonical block number"),
    hash: normalizeBytes32(block.hash, "canonical block hash"),
    parentHash: normalizeBytes32(block.parentHash, "canonical parent block hash"),
  };
}

export function validateCanonicalBlockSequence(
  blocks,
  { fromBlock, toBlock, predecessor } = {},
) {
  const normalizedFrom = toUint256(fromBlock, "canonical range start block");
  const normalizedTo = toUint256(toBlock, "canonical range end block");
  if (normalizedTo < normalizedFrom) {
    throw new Error("canonical range end block must not precede its start block");
  }

  const normalized = blocks.map(normalizeCanonicalBlock);
  const expectedLength = normalizedTo - normalizedFrom + 1n;
  if (BigInt(normalized.length) !== expectedLength) {
    throw new Error(
      `canonical block range ${normalizedFrom}-${normalizedTo} must contain every block`,
    );
  }

  for (let index = 0; index < normalized.length; index += 1) {
    const expectedNumber = normalizedFrom + BigInt(index);
    const block = normalized[index];
    if (block.number !== expectedNumber) {
      throw new Error(
        `canonical block range expected block ${expectedNumber}, received ${block.number}`,
      );
    }

    const previous = index === 0 ? predecessor : normalized[index - 1];
    if (previous !== undefined && block.parentHash !== normalizeCanonicalBlock(previous).hash) {
      throw new CanonicalDivergenceError(
        `canonical parent mismatch at block ${block.number}: expected ${normalizeCanonicalBlock(previous).hash}, received ${block.parentHash}`,
      );
    }
  }

  return normalized;
}

export async function fetchCanonicalBlock(publicClient, blockNumber) {
  const normalizedNumber = toUint256(blockNumber, "canonical block number");
  const block = await publicClient.getBlock({ blockNumber: normalizedNumber });
  const normalized = normalizeCanonicalBlock(block);
  if (normalized.number !== normalizedNumber) {
    throw new Error(
      `RPC returned canonical block ${normalized.number} for requested block ${normalizedNumber}`,
    );
  }
  return normalized;
}

export async function fetchCanonicalBlockRange(publicClient, fromBlock, toBlock) {
  const normalizedFrom = toUint256(fromBlock, "canonical range start block");
  const normalizedTo = toUint256(toBlock, "canonical range end block");
  if (normalizedTo < normalizedFrom) {
    throw new Error("canonical range end block must not precede its start block");
  }

  const blocks = [];
  for (let blockNumber = normalizedFrom; blockNumber <= normalizedTo; blockNumber += 1n) {
    blocks.push(await fetchCanonicalBlock(publicClient, blockNumber));
  }
  return validateCanonicalBlockSequence(blocks, {
    fromBlock: normalizedFrom,
    toBlock: normalizedTo,
  });
}

export async function findCommonAncestor({
  storedBlocks,
  probeBlock,
  getCanonicalBlock,
}) {
  const probe = toUint256(probeBlock, "common ancestor probe block");
  let expectedNumber = probe;

  for (const stored of storedBlocks) {
    const normalizedStored = normalizeCanonicalBlock(stored);
    if (normalizedStored.number !== expectedNumber) {
      throw new NoCommonAncestorError(
        `Persisted canonical history is incomplete at block ${expectedNumber}. Manual intervention is required.`,
      );
    }

    const current = normalizeCanonicalBlock(await getCanonicalBlock(expectedNumber));
    if (current.number !== expectedNumber) {
      throw new Error(
        `RPC returned block ${current.number} while searching for canonical block ${expectedNumber}`,
      );
    }
    if (current.hash === normalizedStored.hash) {
      return normalizedStored;
    }

    if (expectedNumber === 0n) {
      break;
    }
    expectedNumber -= 1n;
  }

  throw new NoCommonAncestorError();
}
