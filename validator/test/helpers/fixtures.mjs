import { readFile } from "node:fs/promises";
import { encodeAbiParameters, encodeEventTopics, parseAbiParameters } from "viem";
import { committeeDigest } from "../../src/committee.mjs";
import { validatorAccount } from "../../src/identity.mjs";
import { loadValidatorConfig } from "../../src/config.mjs";
import { buildMessageBatch } from "../../../indexer/src/message-batch.mjs";
import { buildMessageMerkleTree } from "../../../indexer/src/message-merkle.mjs";
import { CROSS_CHAIN_MESSAGE_EVENT } from "../../../indexer/src/source-gateway-event.mjs";

// Scalars are constructed only by test/verification runtime. No production key file exists.
export function developmentKeys(count = 4) {
  return Array.from({ length: count }, (_, index) => `0x${BigInt(index + 1).toString(16).padStart(64, "0")}`);
}

export function environment(overrides = {}, index = 0) {
  const keys = developmentKeys();
  const peers = keys.map((key, peerIndex) => ({ address: validatorAccount(key).address.toLowerCase(), url: `http://127.0.0.1:${31001 + peerIndex}` }));
  return {
    VALIDATOR_PRIVATE_KEY: keys[index], VALIDATOR_LISTEN_HOST: "127.0.0.1", VALIDATOR_LISTEN_PORT: String(31001 + index),
    VALIDATOR_PEERS: JSON.stringify(peers),
    VALIDATOR_SET_HISTORY_FILE: "",
    VALIDATOR_SET_HISTORY: JSON.stringify([{ validatorEpoch: "0", activationBatchEpoch: "0", validators: peers.map((peer) => peer.address), committeeDigest: committeeDigest(peers) }]),
    SOURCE_DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused", SOURCE_DB_SCHEMA: "validator_fixture_source",
    VALIDATOR_DATABASE_URL: "postgresql://fixture:placeholder@127.0.0.1/unused", VALIDATOR_DB_SCHEMA: `validator_fixture_local_${index}`,
    CHAIN_A_DOMAIN: "10011", SOURCE_GATEWAY_ADDRESS: "0x1111111111111111111111111111111111111111",
    CHAIN_A_RPC_URL: "http://127.0.0.1:4545", FINALITY_BLOCK_DEPTH: "2", ...overrides,
  };
}

export function configuration(overrides = {}, index = 0) { return loadValidatorConfig(environment(overrides, index)); }

export async function snapshotFixture(status = "CONSENSUS_PENDING") {
  const vectors = JSON.parse(await readFile(new URL("../../../test-vectors/merkle-golden-vectors.json", import.meta.url), "utf8"));
  const batch = buildMessageBatch(vectors.vectors[2].batch);
  const tree = buildMessageMerkleTree(batch);
  return {
    record: { batchRecordId: "1", batchId: batch.batchId, sourceDomain: batch.sourceDomain, sourceGateway: batch.sourceGateway,
      epoch: batch.epoch, messageCount: BigInt(batch.messages.length), messageRoot: tree.messageRoot, status },
    members: batch.messages.map((message, index) => ({ sourceMessageId: String(index + 1), messageId: message.messageId, position: BigInt(index) })),
    batch, tree, consensusBinding: { protocolVersion: "3", validatorEpoch: "0", committeeDigest: committeeDigest(developmentKeys().map((key) => validatorAccount(key).address.toLowerCase())) },
  };
}

export function rawLog(message) {
  return {
    address: message.sourceGateway, blockNumber: message.sourceBlockNumber, blockHash: message.sourceBlockHash,
    transactionHash: message.sourceTransactionHash, logIndex: Number(message.sourceLogIndex),
    topics: encodeEventTopics({ abi: [CROSS_CHAIN_MESSAGE_EVENT], eventName: "CrossChainMessage",
      args: { messageId: message.messageId, sourceSender: message.sourceSender, destinationDomain: message.destinationDomain } }),
    data: encodeAbiParameters(parseAbiParameters("uint8,uint256,address,address,address,uint256,bytes,uint256"), [
      Number(message.version), message.sourceDomain, message.sourceGateway, message.destinationGateway,
      message.destinationReceiver, message.nonce, message.payload, message.deadline,
    ]),
  };
}

export function chainFixture(snapshot, headNumber = snapshot.batch.messages[0].sourceBlockNumber + 2n) {
  const messages = snapshot.batch.messages;
  const sourceHash = messages[0].sourceBlockHash;
  const head = { number: headNumber, hash: headNumber === messages[0].sourceBlockNumber ? sourceHash : `0x${"99".repeat(32)}` };
  const calls = { latestHeads: 0, blocks: [], receipts: [] };
  return {
    calls, head,
    async request({ method }) {
      if (method !== "eth_chainId") throw new Error("unexpected RPC method");
      return `0x${messages[0].sourceDomain.toString(16)}`;
    },
    async getBytecode() { return "0x6000"; },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === "latest") { calls.latestHeads += 1; return { ...head }; }
      calls.blocks.push(blockNumber);
      if (blockNumber === head.number) return { ...head };
      const member = messages.find((message) => message.sourceBlockNumber === blockNumber);
      if (!member) throw new Error("unexpected block request");
      return { number: blockNumber, hash: member.sourceBlockHash };
    },
    async getTransactionReceipt({ hash }) {
      calls.receipts.push(hash);
      const message = messages.find((member) => member.sourceTransactionHash === hash);
      if (!message) throw new Error("unexpected receipt request");
      return { transactionHash: hash, blockNumber: message.sourceBlockNumber, blockHash: message.sourceBlockHash,
        status: "success", logs: [rawLog(message)] };
    },
  };
}
