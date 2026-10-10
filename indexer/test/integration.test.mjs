import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { normalizeAddress, normalizePayload } from "../src/canonical-message.mjs";
import { loadConfig } from "../src/config.mjs";
import {
  applyMigrations,
  createDatabasePool,
  createFinalityStore,
  readCursor,
  readIndexedSourceBlocks,
  readMessages,
  resetIndexerTables,
  tableName,
} from "../src/db.mjs";
import { createMessageBatcher } from "../src/message-batch.mjs";
import { buildMessageMerkleTree, verifyMessageMerkleProof } from "../src/message-merkle.mjs";
import { createBatchLifecycle } from "../src/batch-lifecycle.mjs";
import { decodeCrossChainMessageLog } from "../src/source-gateway-event.mjs";
import { verifyFourIndependentValidators } from "../../validator/test/helpers/four-process.mjs";
import { verifyValidatorFaults } from "../../validator/test/helpers/fault-scenarios.mjs";

const IDENTITY_APPLICATION_ABI = parseAbi([
  "function sendCrossChainMessage(uint256 destinationDomain, address destinationGateway, address destinationReceiver, bytes payload, uint256 deadline) returns (bytes32 messageId, uint256 nonce)",
]);
const execFileAsync = promisify(execFile);
const INDEXER_MAIN_PATH = fileURLToPath(new URL("../src/main.mjs", import.meta.url));
const LIFECYCLE_READER_PATH = fileURLToPath(new URL("./helpers/read-batch-lifecycle.mjs", import.meta.url));
const CONTRACTS_DIRECTORY = fileURLToPath(new URL("../../contracts/", import.meta.url));

function requireEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for the real Indexer integration test`);
  return value;
}

function assertPersistedEvent(row, event, expectedStatus) {
  assert.equal(row.message_id, event.messageId);
  assert.equal(row.version, Number(event.version));
  assert.equal(row.source_domain, event.sourceDomain.toString());
  assert.equal(row.source_gateway, event.sourceGateway);
  assert.equal(row.source_sender, event.sourceSender);
  assert.equal(row.destination_domain, event.destinationDomain.toString());
  assert.equal(row.destination_gateway, event.destinationGateway);
  assert.equal(row.destination_receiver, event.destinationReceiver);
  assert.equal(row.nonce, event.nonce.toString());
  assert.equal(`0x${row.payload.toString("hex")}`, event.payload);
  assert.equal(row.payload_hash, event.payloadHash);
  assert.equal(row.deadline, event.deadline.toString());
  assert.equal(row.source_block_number, event.sourceBlockNumber.toString());
  assert.equal(row.source_block_hash, event.sourceBlockHash);
  assert.equal(row.source_tx_hash, event.sourceTransactionHash);
  assert.equal(row.source_log_index, event.sourceLogIndex.toString());
  assert.equal(row.status, expectedStatus);
  assert.ok(row.observed_at instanceof Date);
}

test("recovers source workers and seals durable batches from real finalized messages", async () => {
  const config = loadConfig();
  assert.equal(
    config.finalityBlockDepth,
    2n,
    "the real finality integration test requires FINALITY_BLOCK_DEPTH=2",
  );
  const identityApplication = normalizeAddress(
    requireEnvironment("IDENTITY_APPLICATION_ADDRESS"),
    "IdentityApplicationA address",
  );
  const destinationDomain = BigInt(requireEnvironment("INDEXER_INTEGRATION_DESTINATION_DOMAIN"));
  const destinationGateway = normalizeAddress(
    requireEnvironment("INDEXER_INTEGRATION_DESTINATION_GATEWAY"),
    "integration destination gateway",
  );
  const destinationReceiver = normalizeAddress(
    requireEnvironment("INDEXER_INTEGRATION_DESTINATION_RECEIVER"),
    "integration destination receiver",
  );
  const privateKey = requireEnvironment("INDEXER_INTEGRATION_PRIVATE_KEY");
  assert.match(privateKey, /^0x[0-9a-fA-F]{64}$/, "INDEXER_INTEGRATION_PRIVATE_KEY must be a private key");
  assert.ok(config.chainDomain <= BigInt(Number.MAX_SAFE_INTEGER), "integration chain domain exceeds viem chain ID range");

  const chain = defineChain({
    id: Number(config.chainDomain),
    name: "Configured Chain A",
    nativeCurrency: { name: "Test Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [config.chainRpcUrl] } },
  });
  const account = privateKeyToAccount(privateKey);
  const publicClient = createPublicClient({ chain, transport: http(config.chainRpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(config.chainRpcUrl) });
  const scope = { chainDomain: config.chainDomain, sourceGateway: config.sourceGateway };
  const schemaIdentifier = `"${config.databaseSchema}"`;
  const activeWorkers = new Set();

  async function runOneShotProcess(mode) {
    const result = await execFileAsync(process.execPath, [INDEXER_MAIN_PATH, mode, "--once"], {
      env: process.env,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.stdout;
  }

  async function runContinuousProcessUntilKilled(mode, durableMarker) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [INDEXER_MAIN_PATH, mode], {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      activeWorkers.add(child);

      let stdout = "";
      let stderr = "";
      let markerSeen = false;
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 30_000);

      child.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(text);
        if (!markerSeen && durableMarker.test(stdout)) {
          markerSeen = true;
          child.kill("SIGKILL");
        }
      });
      child.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        stderr += text;
        process.stderr.write(text);
      });
      child.once("error", (error) => {
        clearTimeout(timeout);
        activeWorkers.delete(child);
        reject(error);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timeout);
        activeWorkers.delete(child);
        if (timedOut) {
          reject(new Error(`timed out waiting for ${mode} durable marker`));
          return;
        }
        if (!markerSeen) {
          reject(
            new Error(
              `${mode} exited before its durable marker (code ${code}, signal ${signal}): ${stderr}`,
            ),
          );
          return;
        }
        if (signal !== "SIGKILL") {
          reject(
            new Error(
              `${mode} was expected to stop through SIGKILL, received code ${code} and signal ${signal}`,
            ),
          );
          return;
        }
        resolve(stdout);
      });
    });
  }

  async function produceMessage(payload) {
    const latestBlock = await publicClient.getBlock();
    const deadline = latestBlock.timestamp + 3600n;
    const transactionHash = await walletClient.writeContract({
      address: identityApplication,
      abi: IDENTITY_APPLICATION_ABI,
      functionName: "sendCrossChainMessage",
      args: [destinationDomain, destinationGateway, destinationReceiver, normalizePayload(payload), deadline],
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
    const gatewayLog = receipt.logs.find(
      (log) => normalizeAddress(log.address, "receipt log address") === config.sourceGateway,
    );
    assert.ok(gatewayLog, "CrossChainMessage log was not found in the integration transaction receipt");

    return decodeCrossChainMessageLog(gatewayLog, {
      expectedGateway: config.sourceGateway,
      expectedSourceDomain: config.chainDomain,
    });
  }

  async function mineBlock() {
    await publicClient.request({ method: "evm_mine" });
    return BigInt(await publicClient.request({ method: "eth_blockNumber" }));
  }

  async function rewindTestCursor(pool, nextBlock) {
    const result = await pool.query(
      `UPDATE ${schemaIdentifier}."indexer_cursors"
          SET next_block = $3, updated_at = CURRENT_TIMESTAMP
        WHERE chain_domain = $1 AND source_gateway = $2`,
      [config.chainDomain.toString(), config.sourceGateway, nextBlock.toString()],
    );
    assert.equal(result.rowCount, 1, "test cursor rewind must update exactly one row");
  }

  let activePool = createDatabasePool(config);
  try {
    await applyMigrations(activePool, config.databaseSchema);
    await resetIndexerTables(activePool, config.databaseSchema);
    await activePool.end();
    activePool = undefined;

    const messageA = await produceMessage("0x6d6573736167652061");
    const firstIndexOutput = await runContinuousProcessUntilKilled(
      "indexer",
      /New cursor next block:/,
    );

    activePool = createDatabasePool(config);
    let rows = await readMessages(activePool, config.databaseSchema);
    let cursor = await readCursor(activePool, config.databaseSchema, scope);

    assert.match(firstIndexOutput, /Rows inserted: 1/);
    assert.match(firstIndexOutput, /Duplicates skipped: 0/);
    assert.equal(rows.length, 1);
    assertPersistedEvent(rows[0], messageA, "OBSERVED");
    assert.ok(BigInt(cursor.next_block) > messageA.sourceBlockNumber);
    const firstObservedAt = rows[0].observed_at.getTime();

    console.log("VALID: Message A persisted as OBSERVED");
    console.log(`VALID: Indexer cursor persisted at block ${cursor.next_block}`);
    console.log("VALID: Indexer was terminated abruptly after its durable range commit");

    const closedPool = activePool;
    await closedPool.end();
    activePool = undefined;
    await assert.rejects(
      readCursor(closedPool, config.databaseSchema, scope),
      /end|closed|pool/i,
    );
    console.log("EXPECTED FAILURE: closed PostgreSQL client rejected a new operation");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    const blocksAfterClientRecovery = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    assert.equal(rows.length, 1);
    assertPersistedEvent(rows[0], messageA, "OBSERVED");
    assert.ok(BigInt(cursor.next_block) > messageA.sourceBlockNumber);
    assert.ok(
      blocksAfterClientRecovery.some(
        (block) => block.block_number === messageA.sourceBlockNumber.toString(),
      ),
    );
    console.log("VALID: fresh PostgreSQL client recovered message, cursor, and block history");

    await activePool.end();
    activePool = undefined;

    const firstFinalityOutput = await runContinuousProcessUntilKilled(
      "finality",
      /OBSERVED -> FINALIZING: 1/,
    );

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    assert.match(firstFinalityOutput, /OBSERVED -> FINALIZING: 1/);
    assertPersistedEvent(rows[0], messageA, "FINALIZING");
    assert.ok(rows[0].finalizing_at instanceof Date);
    assert.equal(rows[0].finalized_at, null);
    assert.equal(
      (await createFinalityStore(activePool, config.databaseSchema).listBatchEligibleMessages(scope)).length,
      0,
    );
    const messageAFinalizingAt = rows[0].finalizing_at.getTime();

    console.log("VALID: Message A moved from OBSERVED to FINALIZING");
    console.log("VALID: FINALIZING messages are not batch eligible");
    console.log("VALID: Finality Watcher was terminated after persisting FINALIZING");

    await activePool.end();
    activePool = undefined;

    const messageB = await produceMessage("0x6d6573736167652062");
    const secondIndexOutput = await runOneShotProcess("indexer");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    const blocksBeforeRepeatedRestart = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    assert.match(secondIndexOutput, /Rows inserted: 1/);
    assert.equal(rows.length, 2);
    assertPersistedEvent(rows[0], messageA, "FINALIZING");
    assertPersistedEvent(rows[1], messageB, "OBSERVED");
    assert.equal(rows[0].finalizing_at.getTime(), messageAFinalizingAt);
    assert.equal(rows[1].finalizing_at, null);
    const cursorAfterOfflineRecovery = cursor.next_block;
    const canonicalIdentityBeforeRestart = blocksBeforeRepeatedRestart.map((block) => ({
      number: block.block_number,
      hash: block.block_hash,
      parentHash: block.parent_hash,
    }));

    console.log("VALID: restarted Indexer discovered Message B emitted while offline");
    console.log("VALID: Message A remained a single persisted occurrence");

    await activePool.end();
    activePool = undefined;

    const repeatedRestartOutputA = await runOneShotProcess("indexer");
    const repeatedRestartOutputB = await runOneShotProcess("indexer");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    const blocksAfterRepeatedRestart = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    assert.match(
      repeatedRestartOutputA,
      new RegExp(`Cursor next block: ${cursorAfterOfflineRecovery}`),
    );
    assert.match(
      repeatedRestartOutputB,
      new RegExp(`Cursor next block: ${cursorAfterOfflineRecovery}`),
    );
    assert.equal(rows.length, 2);
    assert.equal(cursor.next_block, cursorAfterOfflineRecovery);
    assert.deepEqual(
      blocksAfterRepeatedRestart.map((block) => ({
        number: block.block_number,
        hash: block.block_hash,
        parentHash: block.parent_hash,
      })),
      canonicalIdentityBeforeRestart,
    );
    console.log("VALID: repeated Indexer restarts preserved message and block identity");

    await activePool.end();
    activePool = undefined;

    const secondFinalityOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    assert.match(secondFinalityOutput, /OBSERVED -> FINALIZING: 1/);
    assert.match(secondFinalityOutput, /FINALIZING unchanged: 1/);
    assert.equal(rows.length, 2);
    assertPersistedEvent(rows[0], messageA, "FINALIZING");
    assertPersistedEvent(rows[1], messageB, "FINALIZING");
    assert.equal(rows[0].finalizing_at.getTime(), messageAFinalizingAt);
    const messageBFinalizingAt = rows[1].finalizing_at.getTime();

    console.log("VALID: restarted Finality Watcher resumed persisted FINALIZING state");
    console.log("VALID: Message B independently entered FINALIZING");

    await activePool.end();
    activePool = undefined;

    const exactBoundaryHead = await mineBlock();
    assert.equal(exactBoundaryHead, messageA.sourceBlockNumber + config.finalityBlockDepth);
    const boundaryFinalityOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    const finalityStore = createFinalityStore(activePool, config.databaseSchema);
    let batchEligible = await finalityStore.listBatchEligibleMessages(scope);
    assert.match(boundaryFinalityOutput, /FINALIZING -> FINALIZED: 1/);
    assert.match(boundaryFinalityOutput, /FINALIZING unchanged: 1/);
    assertPersistedEvent(rows[0], messageA, "FINALIZED");
    assertPersistedEvent(rows[1], messageB, "FINALIZING");
    assert.ok(rows[0].finalized_at instanceof Date);
    assert.equal(rows[0].finalized_at_head, exactBoundaryHead.toString());
    assert.deepEqual(batchEligible.map((row) => row.message_id), [messageA.messageId]);
    const messageAFinalizedAt = rows[0].finalized_at.getTime();

    console.log("VALID: Message A finalized at the exact configured depth boundary");
    console.log("VALID: only Message A is batch eligible");

    await activePool.end();
    activePool = undefined;

    const stableFinalityOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    assert.match(stableFinalityOutput, /Candidates checked: 1/);
    assert.match(stableFinalityOutput, /FINALIZING unchanged: 1/);
    assert.equal(rows[0].status, "FINALIZED");
    assert.equal(rows[0].finalized_at.getTime(), messageAFinalizedAt);
    assert.equal(rows[0].finalized_at_head, exactBoundaryHead.toString());
    assert.equal(rows[1].status, "FINALIZING");
    assert.equal(rows[1].finalizing_at.getTime(), messageBFinalizingAt);

    console.log("VALID: FINALIZED state and metadata remained stable on another watcher pass");

    await rewindTestCursor(activePool, messageA.sourceBlockNumber);
    await activePool.end();
    activePool = undefined;

    const rescanOutput = await runOneShotProcess("indexer");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    assert.match(rescanOutput, /Rows inserted: 0/);
    assert.match(rescanOutput, /Duplicates skipped: 2/);
    assert.equal(rows.length, 2);
    assertPersistedEvent(rows[0], messageA, "FINALIZED");
    assertPersistedEvent(rows[1], messageB, "FINALIZING");
    assert.equal(rows[0].observed_at.getTime(), firstObservedAt);
    assert.equal(rows[0].finalized_at.getTime(), messageAFinalizedAt);
    assert.equal(rows[0].finalized_at_head, exactBoundaryHead.toString());
    assert.equal(rows[1].finalizing_at.getTime(), messageBFinalizingAt);
    assert.ok(BigInt(cursor.next_block) > exactBoundaryHead);

    console.log("VALID: rescan preserved the FINALIZED row and finality metadata");
    console.log("VALID: duplicate source events did not create additional rows");

    await activePool.end();
    activePool = undefined;

    const messageBBoundaryHead = await mineBlock();
    assert.equal(messageBBoundaryHead, messageB.sourceBlockNumber + config.finalityBlockDepth);
    const secondBoundaryOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    batchEligible = await createFinalityStore(
      activePool,
      config.databaseSchema,
    ).listBatchEligibleMessages(scope);
    assert.match(secondBoundaryOutput, /FINALIZING -> FINALIZED: 1/);
    assert.deepEqual(rows.map((row) => row.status), ["FINALIZED", "FINALIZED"]);
    assert.deepEqual(batchEligible.map((row) => row.message_id), [
      messageA.messageId,
      messageB.messageId,
    ]);

    console.log("VALID: Message B finalized independently at its exact depth boundary");
    console.log("VALID: both finalized messages are batch eligible in source order");

    await activePool.end();
    activePool = undefined;

    const persistedRestartCursor = BigInt(cursor.next_block);
    const commonAncestor = BigInt(await publicClient.request({ method: "eth_blockNumber" }));
    const commonAncestorBlock = await publicClient.getBlock({ blockNumber: commonAncestor });
    const snapshotId = await publicClient.request({ method: "evm_snapshot" });
    assert.match(snapshotId, /^0x[0-9a-fA-F]+$/);

    console.log(`Creating old source branch after common ancestor ${commonAncestor}`);
    const messageC = await produceMessage("0x6d6573736167652063");
    const restartOutput = await runOneShotProcess("indexer");

    const oldBranchFinalityOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    assert.match(restartOutput, new RegExp(`Cursor next block: ${persistedRestartCursor}`));
    assert.match(oldBranchFinalityOutput, /OBSERVED -> FINALIZING: 1/);
    assert.equal(rows.length, 3);
    assertPersistedEvent(rows[0], messageA, "FINALIZED");
    assertPersistedEvent(rows[1], messageB, "FINALIZED");
    assertPersistedEvent(rows[2], messageC, "FINALIZING");
    assert.ok(BigInt(cursor.next_block) > messageC.sourceBlockNumber);
    const oldMessageFinalizingAt = rows[2].finalizing_at.getTime();

    console.log("VALID: Indexer resumed from the persisted cursor");
    console.log("VALID: old-branch Message C entered FINALIZING");

    await activePool.end();
    activePool = undefined;

    const oldEmptyBlock = await mineBlock();
    const oldEmptyBlockOutput = await runOneShotProcess("indexer");

    activePool = createDatabasePool(config);
    let indexedBlocks = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    assert.match(oldEmptyBlockOutput, /CrossChainMessage logs found: 0/);
    assert.equal(indexedBlocks.at(-1).block_number, oldEmptyBlock.toString());
    assert.equal(BigInt(cursor.next_block), oldEmptyBlock + 1n);
    const oldMessageBlockHash = messageC.sourceBlockHash;
    const oldEmptyBlockHash = indexedBlocks.at(-1).block_hash;

    console.log("VALID: old-branch empty block metadata persisted");

    await activePool.end();
    activePool = undefined;

    const reverted = await publicClient.request({
      method: "evm_revert",
      params: [snapshotId],
    });
    assert.equal(reverted, true);
    assert.equal(
      BigInt(await publicClient.request({ method: "eth_blockNumber" })),
      commonAncestor,
    );

    console.log("Reverted Chain A to the stable snapshot");
    const messageD = await produceMessage("0x6d6573736167652064");
    const replacementEmptyBlock = await mineBlock();
    assert.equal(messageD.sourceBlockNumber, messageC.sourceBlockNumber);
    assert.equal(replacementEmptyBlock, oldEmptyBlock);
    assert.notEqual(messageD.sourceBlockHash, oldMessageBlockHash);

    console.log("Running Finality Watcher before Indexer on the replacement branch");
    const watcherRecoveryOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    indexedBlocks = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    const oldOccurrence = rows.find(
      (row) => row.source_block_hash === oldMessageBlockHash,
    );
    assert.match(watcherRecoveryOutput, /Source reorg detected/);
    assert.match(watcherRecoveryOutput, new RegExp(`Common ancestor: ${commonAncestor}`));
    assert.match(watcherRecoveryOutput, /Unfinalized messages marked REORGED: 1/);
    assert.match(watcherRecoveryOutput, /Candidates checked: 0/);
    assert.ok(oldOccurrence);
    assertPersistedEvent(oldOccurrence, messageC, "REORGED");
    assert.ok(oldOccurrence.reorged_at instanceof Date);
    assert.equal(oldOccurrence.finalizing_at.getTime(), oldMessageFinalizingAt);
    assert.equal(oldOccurrence.finalized_at, null);
    assert.equal(BigInt(cursor.next_block), commonAncestor + 1n);
    assert.equal(indexedBlocks.at(-1).block_number, commonAncestor.toString());
    assert.equal(indexedBlocks.at(-1).block_hash, commonAncestorBlock.hash.toLowerCase());
    assert.ok(indexedBlocks.every((block) => block.block_hash !== oldEmptyBlockHash));
    assert.equal(
      (await createFinalityStore(
        activePool,
        config.databaseSchema,
      ).listBatchEligibleMessages(scope)).some(
        (row) => row.source_block_hash === oldMessageBlockHash,
      ),
      false,
    );

    console.log("VALID: Finality Watcher found the common ancestor before promotion");
    console.log("VALID: old Message C is preserved as REORGED and not batch eligible");
    console.log("VALID: cursor rewound and old canonical block tracking was removed");

    await activePool.end();
    activePool = undefined;

    const replacementIndexOutput = await runOneShotProcess("indexer");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    cursor = await readCursor(activePool, config.databaseSchema, scope);
    indexedBlocks = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    const replacementOccurrence = rows.find(
      (row) => row.source_block_hash === messageD.sourceBlockHash,
    );
    assert.match(
      replacementIndexOutput,
      new RegExp(`Cursor next block: ${commonAncestor + 1n}`),
    );
    assert.ok(replacementOccurrence);
    assertPersistedEvent(replacementOccurrence, messageD, "OBSERVED");
    assert.equal(rows.length, 4);
    assert.equal(BigInt(cursor.next_block), replacementEmptyBlock + 1n);
    assert.equal(indexedBlocks.at(-1).block_number, replacementEmptyBlock.toString());
    assert.notEqual(indexedBlocks.at(-1).block_hash, oldEmptyBlockHash);

    console.log("VALID: replacement canonical branch re-indexed through its empty block");
    console.log("VALID: Message D persisted as a distinct canonical occurrence");
    console.log("VALID: new Indexer process resumed from the reorg-rewound cursor");

    await activePool.end();
    activePool = undefined;

    const replacementFinalizingOutput = await runOneShotProcess("finality");
    assert.match(replacementFinalizingOutput, /OBSERVED -> FINALIZING: 1/);
    const replacementBoundaryHead = await mineBlock();
    assert.equal(
      replacementBoundaryHead,
      messageD.sourceBlockNumber + config.finalityBlockDepth,
    );
    const replacementFinalizedOutput = await runOneShotProcess("finality");

    activePool = createDatabasePool(config);
    rows = await readMessages(activePool, config.databaseSchema);
    batchEligible = await createFinalityStore(
      activePool,
      config.databaseSchema,
    ).listBatchEligibleMessages(scope);
    const oldAfterFinality = rows.find(
      (row) => row.source_block_hash === oldMessageBlockHash,
    );
    const replacementAfterFinality = rows.find(
      (row) => row.source_block_hash === messageD.sourceBlockHash,
    );
    assert.match(replacementFinalizedOutput, /FINALIZING -> FINALIZED: 1/);
    assert.equal(oldAfterFinality.status, "REORGED");
    assert.equal(oldAfterFinality.reorged_at.getTime(), oldOccurrence.reorged_at.getTime());
    assertPersistedEvent(replacementAfterFinality, messageD, "FINALIZED");
    assert.equal(
      batchEligible.some((row) => row.source_block_hash === oldMessageBlockHash),
      false,
    );
    assert.equal(
      batchEligible.some((row) => row.source_block_hash === messageD.sourceBlockHash),
      true,
    );

    console.log("VALID: replacement Message D progressed to FINALIZED");
    console.log("VALID: old REORGED Message C remained terminal");

    const sourceStateBeforeBatching = await readMessages(activePool, config.databaseSchema);
    const cursorBeforeBatching = await readCursor(activePool, config.databaseSchema, scope);
    const blocksBeforeBatching = await readIndexedSourceBlocks(
      activePool,
      config.databaseSchema,
      scope,
    );
    const batchEpoch = 23n;
    const batcher = createMessageBatcher({ config, pool: activePool });
    const batch = await batcher.buildBatch({ epoch: batchEpoch });
    assert.ok(batch, "finalized source messages must produce a batch");
    assert.deepEqual(batch.messageIds, [messageA.messageId, messageB.messageId, messageD.messageId]);
    assert.deepEqual(
      batch.messages.map((message) => message.sourceBlockNumber),
      [messageA.sourceBlockNumber, messageB.sourceBlockNumber, messageD.sourceBlockNumber],
    );
    assert.ok(batch.messages.every((message) => message.status === "FINALIZED"));
    assert.equal(
      batch.messages.some((message) => message.sourceBlockHash === oldMessageBlockHash),
      false,
    );
    assert.deepEqual(await batcher.buildBatch({ epoch: batchEpoch }), batch);
    const tree = buildMessageMerkleTree(batch);
    assert.equal(tree.leafCount, 3);
    assert.deepEqual(buildMessageMerkleTree(batch), tree);
    for (let index = 0; index < batch.messages.length; index += 1) {
      assert.equal(verifyMessageMerkleProof({
        batch,
        message: batch.messages[index],
        proof: tree.proofs[index],
        messageRoot: tree.messageRoot,
      }), true);
    }
    assert.equal(tree.proofs.some((proof) => proof.messageId === messageC.messageId), false);
    const validProofInput = {
      batch,
      message: batch.messages[0],
      proof: tree.proofs[0],
      messageRoot: tree.messageRoot,
    };
    assert.equal(verifyMessageMerkleProof({
      ...validProofInput,
      message: { ...batch.messages[0], nonce: batch.messages[0].nonce + 1n },
    }), false);
    assert.equal(verifyMessageMerkleProof({
      ...validProofInput,
      messageRoot: `0x${"ff".repeat(32)}`,
    }), false);
    assert.equal(verifyMessageMerkleProof({ ...validProofInput, proof: tree.proofs[1] }), false);
    assert.equal(verifyMessageMerkleProof({
      ...validProofInput,
      message: { ...messageC, status: "REORGED" },
    }), false);

    const freshBatchPool = createDatabasePool(config);
    try {
      const rebuilt = await createMessageBatcher({ config, pool: freshBatchPool }).buildBatch({
        epoch: batchEpoch,
      });
      assert.deepEqual(rebuilt, batch);
      const rebuiltTree = buildMessageMerkleTree(rebuilt);
      assert.deepEqual(rebuiltTree, tree);
      for (let index = 0; index < rebuilt.messages.length; index += 1) {
        assert.equal(verifyMessageMerkleProof({
          batch: rebuilt,
          message: rebuilt.messages[index],
          proof: rebuiltTree.proofs[index],
          messageRoot: rebuiltTree.messageRoot,
        }), true);
      }
    } finally {
      await freshBatchPool.end();
    }

    const lifecycle = createBatchLifecycle({ config, pool: activePool });
    const collected = await lifecycle.collectEligible({ initialEpoch: batchEpoch });
    const lifecycleId = collected.snapshot.record.batchRecordId;
    assert.equal(collected.snapshot.record.status, "BUILDING");
    assert.equal(collected.snapshot.record.batchId, null);
    assert.equal(collected.assignedCount, 3);
    assert.deepEqual(collected.snapshot.members.map((member) => member.messageId).sort(), [...batch.messageIds].sort());
    const sealed = await lifecycle.sealBatch({
      batchRecordId: lifecycleId,
      expectedBatchId: batch.batchId,
      expectedMessageRoot: tree.messageRoot,
    });
    assert.equal(sealed.record.status, "SEALED");
    assert.deepEqual(sealed.batch, batch);
    assert.deepEqual(sealed.tree, tree);
    assert.deepEqual(sealed.members.map((member) => member.position), [0n, 1n, 2n]);
    assert.deepEqual(await lifecycle.sealBatch({ batchRecordId: lifecycleId }), sealed);
    await assert.rejects(activePool.query(
      `UPDATE ${tableName(config.databaseSchema, "message_batch_members")}
          SET canonical_position = 99 WHERE batch_record_id = $1`,
      [lifecycleId],
    ), /membership is immutable/);

    function transportValue(value) {
      return JSON.parse(JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item));
    }
    const sealedProcessRead = await execFileAsync(process.execPath, [LIFECYCLE_READER_PATH, lifecycleId], { env: process.env });
    process.stderr.write(sealedProcessRead.stderr);
    assert.deepEqual(JSON.parse(sealedProcessRead.stdout), transportValue(sealed));
    // Pass only public reconstructed snapshot data to a test-local EVM. No chain deployment.
    const restoredSealed = JSON.parse(sealedProcessRead.stdout);
    assert.equal(restoredSealed.record.status, "SEALED");
    assert.equal(restoredSealed.record.messageCount, String(restoredSealed.tree.leafCount));
    const solidityInput = JSON.stringify({
      status: restoredSealed.record.status,
      batchId: restoredSealed.record.batchId,
      messageRoot: restoredSealed.record.messageRoot,
      leafCount: restoredSealed.tree.leafCount,
      messageIds: restoredSealed.batch.messageIds,
      leaves: restoredSealed.tree.leaves,
      proofs: restoredSealed.tree.proofs,
    });
    let solidityResult;
    try {
      solidityResult = await execFileAsync("forge", [
        // Forge filters complete ABI signatures, including the literal parentheses.
        "test", "--match-contract", "MessageMerkleTest", "--match-test", "^testRealSealedSnapshot\\(\\)$", "-vv",
      ], {
        cwd: CONTRACTS_DIRECTORY,
        env: { ...process.env, MERKLE_SEALED_SNAPSHOT_JSON: solidityInput, NO_COLOR: "1" },
      });
    } catch (error) {
      process.stdout.write(error.stdout ?? "");
      process.stderr.write(error.stderr ?? "");
      throw error;
    }
    process.stdout.write(solidityResult.stdout);
    process.stderr.write(solidityResult.stderr);
    const plainSolidityOutput = solidityResult.stdout.replace(/\u001b\[[0-9;]*m/g, "");
    assert.match(plainSolidityOutput, /\[PASS\]\s+testRealSealedSnapshot\(/, "real sealed Solidity test must execute and pass, not skip");
    console.log("VALID: fresh-process SEALED A/B/D leaves and proofs accepted by the Solidity Merkle primitive");
    const pending = await lifecycle.markConsensusPending({ batchRecordId: lifecycleId });
    assert.equal(pending.record.status, "CONSENSUS_PENDING");
    assert.equal(pending.record.committedAt, null);
    assert.deepEqual(await lifecycle.markConsensusPending({ batchRecordId: lifecycleId }), pending);
    const pendingProcessRead = await execFileAsync(process.execPath, [LIFECYCLE_READER_PATH, lifecycleId], { env: process.env });
    process.stderr.write(pendingProcessRead.stderr);
    assert.deepEqual(JSON.parse(pendingProcessRead.stdout), transportValue(pending));
    await assert.rejects(activePool.query(
      `UPDATE ${tableName(config.databaseSchema, "message_batches")}
          SET status = 'COMMITTED', committed_at = CURRENT_TIMESTAMP WHERE batch_record_id = $1`,
      [lifecycleId],
    ), /PBFT quorum authorization/);
    assert.deepEqual(await readMessages(activePool, config.databaseSchema), sourceStateBeforeBatching);
    assert.deepEqual(await readCursor(activePool, config.databaseSchema, scope), cursorBeforeBatching);
    assert.deepEqual(
      await readIndexedSourceBlocks(activePool, config.databaseSchema, scope),
      blocksBeforeBatching,
    );
    console.log("VALID: real finalized Message A, B, and D entered the ordered batch");
    console.log("VALID: old REORGED Message C was excluded from batch membership");
    console.log("VALID: repeated construction and a fresh builder produced the same batch ID");
    console.log("VALID: deterministic batching preserved all source lifecycle metadata");
    console.log(`Deterministic batch epoch: ${batch.epoch}`);
    console.log(`Deterministic batch ID: ${batch.batchId}`);
    console.log("VALID: real finalized Message A, B, and D inclusion proofs verified");
    console.log("VALID: fresh batch and Merkle builders reproduced the root and every proof");
    console.log("VALID: tampered message, wrong root, wrong proof, and REORGED occurrence rejected");
    console.log("VALID: Merkle computation preserved all source lifecycle and canonical block data");
    console.log(`Deterministic Message Root: ${tree.messageRoot}`);
    console.log("VALID: real finalized A/B/D persisted as BUILDING and atomically SEALED");
    console.log("VALID: sealed batch and root matched the deterministic builders");
    console.log("VALID: fresh processes recovered SEALED and CONSENSUS_PENDING snapshots");
    console.log("VALID: sealed membership mutation and unauthorized COMMITTED transition rejected");

    const messageE = await produceMessage("0x6d6573736167652065");
    await runOneShotProcess("indexer");
    await runOneShotProcess("finality");
    for (let successor = 0n; successor < config.finalityBlockDepth; successor += 1n) {
      await mineBlock();
    }
    await runOneShotProcess("finality");
    const afterNewMessage = await readMessages(activePool, config.databaseSchema);
    assert.equal(afterNewMessage.length, sourceStateBeforeBatching.length + 1);
    assert.deepEqual(afterNewMessage.slice(0, sourceStateBeforeBatching.length), sourceStateBeforeBatching);
    const eRow = afterNewMessage.find((row) => row.message_id === messageE.messageId);
    assert.ok(eRow);
    assertPersistedEvent(eRow, messageE, "FINALIZED");
    const beforeRolloverBlocks = await readIndexedSourceBlocks(activePool, config.databaseSchema, scope);
    const beforeRolloverCursor = await readCursor(activePool, config.databaseSchema, scope);
    const rollover = await lifecycle.collectEligible();
    assert.equal(rollover.assignedCount, 1);
    assert.equal(rollover.snapshot.record.epoch, batchEpoch + 1n);
    assert.equal(rollover.snapshot.record.status, "BUILDING");
    assert.equal(rollover.snapshot.record.batchId, null);
    assert.equal(rollover.snapshot.record.messageRoot, null);
    assert.deepEqual(rollover.snapshot.members.map((member) => member.messageId), [messageE.messageId]);
    const oldAfterRollover = await lifecycle.readBatch({ batchRecordId: lifecycleId });
    assert.deepEqual(oldAfterRollover, pending);
    assert.deepEqual(oldAfterRollover.tree.proofs, tree.proofs);
    for (let index = 0; index < batch.messages.length; index += 1) {
      assert.equal(verifyMessageMerkleProof({ batch: oldAfterRollover.batch, message: batch.messages[index], proof: oldAfterRollover.tree.proofs[index], messageRoot: oldAfterRollover.tree.messageRoot }), true);
    }
    assert.deepEqual(await readMessages(activePool, config.databaseSchema), afterNewMessage);
    assert.deepEqual(await readIndexedSourceBlocks(activePool, config.databaseSchema, scope), beforeRolloverBlocks);
    assert.deepEqual(await readCursor(activePool, config.databaseSchema, scope), beforeRolloverCursor);
    console.log("VALID: real Message E finalized after sealing and entered the next BUILDING epoch");
    console.log("VALID: old membership, batch ID, root, and proofs remained unchanged after rollover");
    const consensus = await verifyFourIndependentValidators({ sourceConfig: config, sourcePool: activePool,
      snapshot: oldAfterRollover, pidFile: requireEnvironment("VALIDATOR_VERIFICATION_PID_FILE") });
    const committedProcessRead = await execFileAsync(process.execPath, [LIFECYCLE_READER_PATH, lifecycleId], {
      env: { ...process.env, EXPECTED_VALIDATOR_COMMITTEE: JSON.stringify(consensus.committee) },
    });
    process.stderr.write(committedProcessRead.stderr);
    assert.deepEqual(JSON.parse(committedProcessRead.stdout), transportValue(consensus.snapshot));
    console.log("VALID: fresh source-reader process reconstructed COMMITTED A/B/D and independently verified the persisted QC");
    await verifyValidatorFaults({ sourceConfig: config, sourcePool: activePool, snapshot: consensus.snapshot,
      pidFile: requireEnvironment("VALIDATOR_VERIFICATION_PID_FILE") });
  } finally {
    for (const worker of activeWorkers) {
      worker.kill("SIGKILL");
    }
    if (activePool !== undefined) {
      await activePool.end();
    }
  }
});
