import { keccak256, toHex } from "viem";
import { createDestinationRpcPool } from "../../src/transaction-manager/rpc-pool.mjs";
import { createTransactionRpc } from "../../src/transaction-manager/rpc.mjs";
import { transactionConfig } from "./transaction-fixtures.mjs";
import { transactionHarness } from "./transaction-fixtures.mjs";
import { createTransactionManager } from "../../src/transaction-manager/service.mjs";
import { verifySignedTransaction } from "../../src/transaction-manager/transaction.mjs";
import { fixtureHash } from "./delivery-fixtures.mjs";

export const rpcUnavailable = () => Object.assign(new Error("injected endpoint unavailable"),{ code: "ECONNREFUSED" });
export const rpcTimeout = () => Object.assign(new Error("injected ambiguous timeout"),{ name: "TimeoutError" });
export const rpcRejection = message => Object.assign(new Error(message),{ code: -32000 });
export const rpcHttpError = (status,message = "controlled destination HTTP failure") =>
  Object.assign(new Error(message),{ name: "HttpRequestError",status });
export const rpcProviderLimit = (code = -32007) =>
  Object.assign(new Error("controlled provider request limit"),{ name: "RpcRequestError",code });
export function transactionBody(intent,attempt,blockNumber = null,blockHash = null) {
  return { hash: attempt.transactionHash,from: intent.senderAddress,to: intent.destinationGateway,input: intent.calldata,
    nonce: toHex(BigInt(attempt.nonce)),value: "0x0",type: "0x2",chainId: toHex(BigInt(intent.chainId)),
    gas: toHex(BigInt(attempt.gasLimit)),maxFeePerGas: toHex(BigInt(attempt.maxFeePerGas)),
    maxPriorityFeePerGas: toHex(BigInt(attempt.maxPriorityFeePerGas)),blockNumber: blockNumber === null ? null : toHex(blockNumber),blockHash };
}

export function destinationRpcFixture({ config = transactionConfig({ CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]' }),onBroadcast } = {}) {
  const transactions = new Map(); const receipts = new Map();
  const nodes = config.destinationRpcUrls.map((_,index) => ({
    index,available: true,chainId: config.destinationDomain,genesisHash: config.destinationGenesisHash,head: 100n,
    pendingNonce: 9n,latestNonce: 9n,gas: 123456n,baseFee: 1000000000n,priorityFee: 1000000000n,
    blocks: new Map(),transactions,receipts,faults: new Map(),calls: [],broadcasts: [],
  }));
  function createClient(url) {
    const node = nodes[config.destinationRpcUrls.indexOf(url)];
    return { async request({ method,params = [] },{ signal } = {}) {
      node.calls.push({ method,params });
      if (!node.available) throw rpcUnavailable();
      async function forward() {
        if (method === "eth_chainId") return toHex(node.chainId);
        if (method === "eth_getBlockByNumber") {
          const number = params[0] === "latest" ? node.head : BigInt(params[0]);
          if (number === 0n) return { number: "0x0",hash: node.genesisHash,baseFeePerGas: toHex(node.baseFee) };
          if (node.blocks.has(number.toString())) return node.blocks.get(number.toString());
          return number > node.head ? null : { number: toHex(number),hash: fixtureHash(number + 1000n),baseFeePerGas: toHex(node.baseFee) };
        }
        if (method === "eth_blockNumber") return toHex(node.head);
        if (method === "eth_getTransactionCount") return toHex(params[1] === "pending" ? node.pendingNonce : node.latestNonce);
        if (method === "eth_estimateGas") return toHex(node.gas);
        if (method === "eth_maxPriorityFeePerGas") return toHex(node.priorityFee);
        if (method === "eth_getTransactionByHash") return node.hideTransactions ? null : node.transactions.get(params[0]) ?? null;
        if (method === "eth_getTransactionReceipt") return node.hideReceipts ? null : node.receipts.get(params[0]) ?? null;
        if (method === "eth_sendRawTransaction") {
          const raw = params[0]; node.broadcasts.push(raw);
          const hash = keccak256(raw).toLowerCase();
          if (node.alreadyKnown && transactions.has(hash)) throw rpcRejection("already known");
          const body = await onBroadcast?.(raw);
          if (body) {
            transactions.set(hash,body);
            for (const peer of nodes) if (BigInt(body.nonce) >= peer.pendingNonce) peer.pendingNonce = BigInt(body.nonce) + 1n;
          }
          return node.returnedHash ?? hash;
        }
        throw new Error(`unsupported fixture method ${method}`);
      }
      const fault = node.faults.get(method);
      return fault ? fault({ method,params,forward,node,signal }) : forward();
    } };
  }
  const pool = createDestinationRpcPool({ config,createClient });
  return { config,nodes,transactions,receipts,pool,rpc: createTransactionRpc(config,{ pool }),restart: () => {
    const fresh = createDestinationRpcPool({ config,createClient });
    return { pool: fresh,rpc: createTransactionRpc(config,{ pool: fresh }) };
  } };
}

export async function transactionFailoverHarness({ overrides = {},hooks = {} } = {}) {
  const config = transactionConfig({ CHAIN_B_RPC_URLS: '["http://127.0.0.1:9545","http://127.0.0.1:9546"]',...overrides });
  const h = await transactionHarness({ config,hooks });
  const destination = destinationRpcFixture({ config,async onBroadcast(raw) {
    const record = [...h.records.values()].find(r => r.attempts.some(a => a.rawSignedTransaction === raw));
    const attempt = record?.attempts.find(a => a.rawSignedTransaction === raw);
    if (!attempt || !["SIGNED","BROADCAST"].includes(attempt.status)) throw new Error("send requires durable active signed bytes");
    await verifySignedTransaction(record.intent,attempt);
    return transactionBody(record.intent,attempt);
  } });
  const options = { ...h.options,rpc: destination.rpc };
  function mine(id,{ attemptId,status = 1,blockNumber = 100n } = {}) {
    const record = h.records.get(id);
    const winner = attemptId === undefined ? record.attempt : record.attempts.find(a => a.attemptId === attemptId);
    const blockHash = fixtureHash(blockNumber + 1000n);
    destination.receipts.set(winner.transactionHash,{ transactionHash: winner.transactionHash,blockNumber: toHex(blockNumber),blockHash,status: toHex(status) });
    destination.transactions.set(winner.transactionHash,transactionBody(record.intent,winner,blockNumber,blockHash));
    for (const node of destination.nodes) { node.latestNonce = BigInt(record.intent.nonce) + 1n; node.head = blockNumber + 2n; }
  }
  return { ...h,destination,options,mine,manager: createTransactionManager(options),
    restart: () => createTransactionManager({ ...options,rpc: destination.restart().rpc }) };
}
