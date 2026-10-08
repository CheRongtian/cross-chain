import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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
  applyMigration,
  createDatabasePool,
  readCursor,
  readMessages,
  resetIndexerTables,
} from "../src/db.mjs";
import { decodeCrossChainMessageLog } from "../src/source-gateway-event.mjs";

const IDENTITY_APPLICATION_ABI = parseAbi([
  "function sendCrossChainMessage(uint256 destinationDomain, address destinationGateway, address destinationReceiver, bytes payload, uint256 deadline) returns (bytes32 messageId, uint256 nonce)",
]);
const execFileAsync = promisify(execFile);
const INDEXER_MAIN_PATH = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

function requireEnvironment(name) {
  const value = process.env[name];
  assert.ok(value, `${name} is required for the real Indexer integration test`);
  return value;
}

function assertPersistedEvent(row, event) {
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
  assert.equal(row.status, "OBSERVED");
  assert.ok(row.observed_at instanceof Date);
}

test("persists real SourceGateway events and resumes from the stored cursor", async () => {
  const config = loadConfig();
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

  async function runOneShotProcess() {
    const result = await execFileAsync(process.execPath, [INDEXER_MAIN_PATH, "--once"], {
      env: process.env,
    });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    return result.stdout;
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

  let activePool = createDatabasePool(config);
  try {
    await applyMigration(activePool, config.databaseSchema);
    await resetIndexerTables(activePool, config.databaseSchema);
    await activePool.end();
    activePool = undefined;

    const messageA = await produceMessage("0x6d6573736167652061");
    await runOneShotProcess();

    activePool = createDatabasePool(config);
    const rowsAfterFirstRun = await readMessages(activePool, config.databaseSchema);
    const cursorAfterFirstRun = await readCursor(activePool, config.databaseSchema, scope);

    assert.equal(rowsAfterFirstRun.length, 1);
    assertPersistedEvent(rowsAfterFirstRun[0], messageA);
    assert.ok(BigInt(cursorAfterFirstRun.next_block) > messageA.sourceBlockNumber);
    const persistedRestartCursor = BigInt(cursorAfterFirstRun.next_block);

    console.log("VALID: Message A persisted as OBSERVED");
    console.log("VALID: canonical message ID and source event metadata persisted");
    console.log(`VALID: Indexer cursor persisted at block ${persistedRestartCursor}`);

    await activePool.end();
    activePool = undefined;

    const messageB = await produceMessage("0x6d6573736167652062");

    const secondRunOutput = await runOneShotProcess();

    activePool = createDatabasePool(config);
    const rowsAfterRestart = await readMessages(activePool, config.databaseSchema);
    const cursorAfterRestart = await readCursor(activePool, config.databaseSchema, scope);

    assert.match(secondRunOutput, new RegExp(`Cursor next block: ${persistedRestartCursor}`));
    assert.equal(rowsAfterRestart.length, 2);
    assertPersistedEvent(rowsAfterRestart[0], messageA);
    assertPersistedEvent(rowsAfterRestart[1], messageB);
    assert.ok(BigInt(cursorAfterRestart.next_block) > messageB.sourceBlockNumber);

    console.log("VALID: Indexer resumed from the persisted cursor");
    console.log("VALID: Message B persisted as OBSERVED after restart");
    console.log(`VALID: cursor advanced to block ${cursorAfterRestart.next_block}`);
  } finally {
    if (activePool !== undefined) {
      await activePool.end();
    }
  }
});
