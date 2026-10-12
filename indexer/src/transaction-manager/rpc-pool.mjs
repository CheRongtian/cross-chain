import { createPublicClient, http, toHex } from "viem";
import { normalizeBytes32 } from "../canonical-message.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { classifyBroadcastError } from "./rpc-errors.mjs";

const temporary = classification => ["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(classification);
export class DestinationRpcError extends Error {
  constructor(code,{ errorClass = "DETERMINISTIC_REJECTION",observations = [] } = {}) {
    super(code); this.name = "DestinationRpcError"; this.code = code; this.errorClass = errorClass;
    this.observations = Object.freeze(observations.map(value => Object.freeze({ ...value })));
  }
}

export function createDestinationRpcPool({ config,createClient = url => createPublicClient({
  transport: http(url,{ retryCount: 0,timeout: config.rpcRequestTimeoutMs }),
}) }) {
  const endpoints = config.destinationRpcUrls.map((url,index) => ({
    label: `rpc-${index}`,client: createClient(url),status: "UNAVAILABLE",reason: null,lastErrorClass: null,
  }));
  async function raw(endpoint,method,params = []) {
    // Cover the complete response body too: the installed HTTP transport's
    // internal fetch timer ends when response headers arrive.
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => {
        const error = new DestinationRpcError("RPC_REQUEST_TIMEOUT",{ errorClass: "AMBIGUOUS_BROADCAST" });
        reject(error); controller.abort(error);
      },config.rpcRequestTimeoutMs);
    });
    try {
      return await Promise.race([endpoint.client.request({ method,params },{ retryCount: 0,signal: controller.signal }),deadline]);
    } finally { clearTimeout(timer); }
  }
  const observation = (endpoint,operation,outcome,errorClass = null) => ({
    endpointLabel: endpoint.label,operation,outcome,errorClass,
  });
  function unavailable(endpoint,error) {
    endpoint.status = "UNAVAILABLE"; endpoint.lastErrorClass = classifyBroadcastError(error); endpoint.reason = "RPC_ENDPOINT_UNAVAILABLE";
  }
  function inconsistent(code = "INCONSISTENT_RPC_VIEW") {
    return new DestinationRpcError(code,{ errorClass: "TRANSIENT_RPC_ERROR" });
  }
  function safeRejection(endpoint,operation,error,observations) {
    const errorClass = classifyBroadcastError(error);
    const code = typeof error?.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(error.code) ? error.code : errorClass;
    return new DestinationRpcError(code,{
      errorClass,observations: [...observations,observation(endpoint,operation,"REJECTED",errorClass)],
    });
  }
  async function probe(endpoint) {
    if (endpoint.status === "IDENTITY_MISMATCH") return false;
    let chainId; let genesis;
    try {
      chainId = await raw(endpoint,"eth_chainId");
      genesis = await raw(endpoint,"eth_getBlockByNumber",["0x0",false]);
    } catch (error) { unavailable(endpoint,error); return false; }
    let reason = null;
    try {
      if (rpcQuantity(chainId,"chain ID") !== config.destinationDomain) reason = "CHAIN_ID_MISMATCH";
      else if (!genesis || rpcQuantity(genesis.number,"genesis number") !== 0n) reason = "INVALID_DESTINATION_IDENTITY";
      else if (normalizeBytes32(genesis.hash) !== config.destinationGenesisHash) reason = "GENESIS_HASH_MISMATCH";
    } catch { reason = "INVALID_DESTINATION_IDENTITY"; }
    endpoint.reason = reason; endpoint.lastErrorClass = reason ? "DETERMINISTIC_REJECTION" : null;
    endpoint.status = reason ? "IDENTITY_MISMATCH" : "HEALTHY";
    return reason === null;
  }
  function exhausted(observations) {
    if (endpoints.every(endpoint => endpoint.status === "IDENTITY_MISMATCH")) {
      return new DestinationRpcError(endpoints[0].reason,{ observations });
    }
    return new DestinationRpcError("RPC_UNAVAILABLE",{
      errorClass: observations.some(value => value.errorClass === "AMBIGUOUS_BROADCAST") ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR",observations,
    });
  }
  async function priority(operation,execute) {
    const observations = [];
    for (const endpoint of endpoints) {
      if (!await probe(endpoint)) {
        observations.push(observation(endpoint,operation,endpoint.status,endpoint.lastErrorClass)); continue;
      }
      try {
        const value = await execute(endpoint);
        observations.push(observation(endpoint,operation,"SUCCEEDED"));
        return { value,endpointLabel: endpoint.label,observations: Object.freeze(observations) };
      } catch (error) {
        if (!temporary(classifyBroadcastError(error))) throw safeRejection(endpoint,operation,error,observations);
        unavailable(endpoint,error);
        observations.push(observation(endpoint,operation,"UNAVAILABLE",endpoint.lastErrorClass));
      }
    }
    throw exhausted(observations);
  }
  async function collect(operation,execute,selected = endpoints) {
    const results = await Promise.all(selected.map(async endpoint => {
      if (!await probe(endpoint)) return { observation: observation(endpoint,operation,endpoint.status,endpoint.lastErrorClass) };
      try { return { endpoint,value: await execute(endpoint),observation: observation(endpoint,operation,"SUCCEEDED") }; }
      catch (error) {
        if (!temporary(classifyBroadcastError(error))) throw safeRejection(endpoint,operation,error,[]);
        unavailable(endpoint,error);
        return { observation: observation(endpoint,operation,"UNAVAILABLE",endpoint.lastErrorClass) };
      }
    }));
    const available = results.filter(result => result.endpoint);
    if (!available.length) throw exhausted(results.map(result => result.observation));
    return available;
  }
  function blockIdentity(block,number) {
    if (!block || rpcQuantity(block.number,"block number") !== number) throw inconsistent();
    return normalizeBytes32(block.hash,"block hash");
  }
  function agree(values,identity) {
    const nonnull = values.filter(result => result.value !== null);
    if (nonnull.length && nonnull.some(result => identity(result.value) !== identity(nonnull[0].value))) throw inconsistent();
    return nonnull;
  }
  function selectedFor(view) {
    return endpoints.filter(endpoint => view.endpoints.some(sample => sample.endpointLabel === endpoint.label));
  }
  async function readView() {
    const samples = await collect("head",async endpoint => rpcQuantity(await raw(endpoint,"eth_blockNumber"),"head"));
    const head = samples.reduce((minimum,sample) => sample.value < minimum ? sample.value : minimum,samples[0].value);
    const blocks = await collect("snapshot block",endpoint => raw(endpoint,"eth_getBlockByNumber",[toHex(head),false]),samples.map(sample => sample.endpoint));
    if (blocks.some(result => result.value === null)) throw inconsistent("RPC_VIEW_INCOMPLETE");
    agree(blocks,block => blockIdentity(block,head));
    return Object.freeze({ head,
      endpoints: Object.freeze(samples.map(sample => Object.freeze({ endpointLabel: sample.endpoint.label,head: sample.value }))) });
  }
  async function receiptEvidence(hash,view) {
    const transactionHash = normalizeBytes32(hash);
    const participants = selectedFor(view);
    const found = await collect("receipt",async endpoint => {
      const receipt = await raw(endpoint,"eth_getTransactionReceipt",[transactionHash]);
      if (receipt !== null && normalizeBytes32(receipt?.transactionHash) !== transactionHash) throw new DestinationRpcError("RECEIPT_TRANSACTION_HASH_MISMATCH");
      return receipt;
    },participants);
    const candidates = agree(found,receipt => {
      const status = rpcQuantity(receipt.status,"receipt status");
      if (status > 1n) throw new DestinationRpcError("INVALID_RECEIPT_STATUS");
      return `${rpcQuantity(receipt.blockNumber)}:${normalizeBytes32(receipt.blockHash)}:${status}`;
    });
    if (!candidates.length) return null;
    for (const candidate of candidates) {
      const { endpoint,value: receipt } = candidate;
      const number = rpcQuantity(receipt.blockNumber,"receipt block");
      let block; let transaction;
      try {
        block = await raw(endpoint,"eth_getBlockByNumber",[toHex(number),false]);
        transaction = await raw(endpoint,"eth_getTransactionByHash",[transactionHash]);
      } catch (error) {
        if (!temporary(classifyBroadcastError(error))) throw safeRejection(endpoint,"receipt evidence",error,[]);
        unavailable(endpoint,error); continue;
      }
      if (block === null || transaction === null) continue;
      const expectedHash = normalizeBytes32(receipt.blockHash);
      if (blockIdentity(block,number) !== expectedHash) throw inconsistent();
      // Only compare nodes that had reached this height in the fixed pass.
      // A slower node remains valid but conservatively limits confirmation depth.
      for (const other of participants) {
        if (other === endpoint || view.endpoints.find(sample => sample.endpointLabel === other.label).head < number) continue;
        if (!await probe(other)) continue;
        let peerBlock;
        try { peerBlock = await raw(other,"eth_getBlockByNumber",[toHex(number),false]); }
        catch (error) {
          if (!temporary(classifyBroadcastError(error))) throw safeRejection(other,"canonical block",error,[]);
          unavailable(other,error); continue;
        }
        if (peerBlock === null) throw inconsistent("RPC_VIEW_INCOMPLETE");
        if (blockIdentity(peerBlock,number) !== expectedHash) throw inconsistent();
      }
      return Object.freeze({ receipt,block,transaction,endpointLabel: endpoint.label });
    }
    throw inconsistent("RPC_VIEW_INCOMPLETE");
  }
  return {
    async probeEndpoint(index) {
      if (!Number.isInteger(index) || !endpoints[index]) throw new DestinationRpcError("INVALID_RPC_ENDPOINT");
      await probe(endpoints[index]); return this.health()[index];
    },
    health() { return Object.freeze(endpoints.map(({ label,status,reason,lastErrorClass }) => Object.freeze({ endpointLabel: label,status,reason,lastErrorClass }))); },
    async verifyChain() { await priority("identity",async () => config.destinationDomain); return config.destinationDomain; },
    async request(method,params = [],validate = value => value) {
      return (await priority(method,async endpoint => validate(await raw(endpoint,method,params)))).value;
    },
    async fees() {
      return (await priority("fee data",async endpoint => {
        const [block,priorityFee] = await Promise.all([raw(endpoint,"eth_getBlockByNumber",["latest",false]),raw(endpoint,"eth_maxPriorityFeePerGas")]);
        if (!block || block.baseFeePerGas == null) throw new DestinationRpcError("EIP1559_REQUIRED");
        const maxPriorityFeePerGas = rpcQuantity(priorityFee,"priority fee");
        const maxFeePerGas = rpcQuantity(block.baseFeePerGas,"base fee") * 2n + maxPriorityFeePerGas;
        if (maxFeePerGas >= (1n << 256n)) throw new DestinationRpcError("INVALID_MAX_FEE");
        return { maxFeePerGas,maxPriorityFeePerGas };
      })).value;
    },
    async nonce(tag,view) {
      const values = await collect(`${tag} nonce`,async endpoint => rpcQuantity(
        await raw(endpoint,"eth_getTransactionCount",[config.relayerAddress,tag]),"account nonce"),view ? selectedFor(view) : endpoints);
      return values.reduce((nonce,result) => result.value > nonce ? result.value : nonce,values[0].value);
    },
    async broadcast(rawTransaction,transactionHash) {
      const expected = normalizeBytes32(transactionHash);
      const result = await priority("broadcast",async endpoint => {
        const hash = await raw(endpoint,"eth_sendRawTransaction",[rawTransaction]);
        if (normalizeBytes32(hash) !== expected) throw new DestinationRpcError("RPC_TRANSACTION_HASH_MISMATCH");
        return expected;
      });
      return Object.freeze({ transactionHash: result.value,acceptedEndpointLabel: result.endpointLabel,observations: result.observations });
    },
    readView,receiptEvidence,
    async transaction(hash) {
      const expected = normalizeBytes32(hash);
      const values = await collect("transaction",async endpoint => {
        const tx = await raw(endpoint,"eth_getTransactionByHash",[expected]);
        if (tx !== null && normalizeBytes32(tx?.hash) !== expected) throw new DestinationRpcError("RECEIPT_TRANSACTION_HASH_MISMATCH");
        return tx;
      });
      const known = values.filter(result => result.value !== null);
      const mined = agree(known.filter(result => result.value.blockNumber != null),
        tx => `${rpcQuantity(tx.blockNumber)}:${normalizeBytes32(tx.blockHash)}`);
      return mined[0]?.value ?? known[0]?.value ?? null;
    },
    async block(number) {
      const values = await collect("block",endpoint => raw(endpoint,"eth_getBlockByNumber",[toHex(number),false]));
      return agree(values,block => blockIdentity(block,number))[0]?.value ?? null;
    },
  };
}
