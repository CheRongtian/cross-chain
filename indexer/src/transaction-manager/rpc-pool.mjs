import { createPublicClient, http, HttpRequestError, toHex } from "viem";
import { normalizeBytes32 } from "../canonical-message.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { classifyBroadcastError, normalizeRpcError } from "./rpc-errors.mjs";
import { processMetrics, recordMetric } from "../metrics/registry.mjs";

const temporary = classification => ["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST"].includes(classification);
export class DestinationRpcError extends Error {
  constructor(code,{ errorClass = "RPC_RESPONSE_ERROR",observations = [],httpStatus,rpcCode } = {}) {
    super(code); this.name = "DestinationRpcError"; this.code = code; this.errorClass = errorClass;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
    if (rpcCode !== undefined) this.rpcCode = rpcCode;
    this.observations = Object.freeze(observations.map(value => Object.freeze({ ...value })));
  }
}

export function createDestinationRpcPool({ config, metrics = processMetrics, createClient = url => createPublicClient({
  transport: http(url,{ retryCount: 0,timeout: config.rpcRequestTimeoutMs,async onFetchResponse(response) {
    // viem otherwise promotes JSON-RPC bodies on non-2xx responses and loses
    // their HTTP status. Keep availability/timeout evidence before parsing.
    if (response.status === 408 || response.status === 429 || response.status >= 500) {
      const error = new HttpRequestError({ status: response.status,url,details: "Destination HTTP availability failure" });
      try { await response.body?.cancel(); } finally { throw error; }
    }
  } }),
}) }) {
  const endpoints = config.destinationRpcUrls.map((url,index) => ({
    label: `rpc-${index}`,client: createClient(url),status: "UNAVAILABLE",reason: null,lastErrorClass: null,
  }));
  async function raw(endpoint,method,params = []) {
    const operation = method === "eth_sendRawTransaction" ? "broadcast" : method === "eth_estimateGas" ? "estimate" : "read";
    // Cover the complete response body too: the installed HTTP transport's
    // internal fetch timer ends when response headers arrive.
    const controller = new AbortController();
    let timer;
    const deadline = new Promise((_,reject) => {
      timer = setTimeout(() => {
        const error = new DestinationRpcError("RPC_REQUEST_TIMEOUT",{ errorClass: operation === "broadcast" ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR" });
        reject(error); controller.abort(error);
      },config.rpcRequestTimeoutMs);
    });
    try {
      const value = await Promise.race([endpoint.client.request({ method,params },{ retryCount: 0,signal: controller.signal }),deadline]);
      if (value === undefined) throw new DestinationRpcError("RPC_INVALID_RESPONSE");
      return value;
    } catch (error) {
      const normalized = normalizeRpcError(error,{ operation });
      recordMetric(metrics, "rpc", { operation: method, reason_class: normalized.errorClass });
      throw new DestinationRpcError(normalized.errorCode,normalized);
    } finally { clearTimeout(timer); }
  }
  const observation = (endpoint,operation,outcome,errorClass = null,error) => ({
    endpointLabel: endpoint.label,operation,outcome,errorClass,
    ...(error?.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
    ...(error?.rpcCode === undefined ? {} : { rpcCode: error.rpcCode }),
  });
  function unavailable(endpoint,error) {
    endpoint.status = "UNAVAILABLE"; endpoint.lastErrorClass = classifyBroadcastError(error); endpoint.reason = "RPC_ENDPOINT_UNAVAILABLE";
    endpoint.lastFailure = error;
  }
  function inconsistent(code = "INCONSISTENT_RPC_VIEW") {
    return new DestinationRpcError(code,{ errorClass: "TRANSIENT_RPC_ERROR" });
  }
  function safeRejection(endpoint,operation,error,observations) {
    const normalized = normalizeRpcError(error,{ operation: operation === "broadcast" ? "broadcast" : operation === "eth_estimateGas" ? "estimate" : "read" });
    return new DestinationRpcError(normalized.errorCode,{
      ...normalized,observations: [...observations,observation(endpoint,operation,"REJECTED",normalized.errorClass,normalized)],
    });
  }
  async function probe(endpoint) {
    if (endpoint.status === "IDENTITY_MISMATCH") return false;
    let chainId; let genesis;
    try {
      chainId = await raw(endpoint,"eth_chainId");
      genesis = await raw(endpoint,"eth_getBlockByNumber",["0x0",false]);
    } catch (error) {
      if (!temporary(classifyBroadcastError(error,{ operation: "read" }))) throw safeRejection(endpoint,"identity",error,[]);
      unavailable(endpoint,error); return false;
    }
    let reason = null;
    try {
      if (rpcQuantity(chainId,"chain ID") !== config.destinationDomain) reason = "CHAIN_ID_MISMATCH";
      else if (!genesis || rpcQuantity(genesis.number,"genesis number") !== 0n) reason = "INVALID_DESTINATION_IDENTITY";
      else if (normalizeBytes32(genesis.hash) !== config.destinationGenesisHash) reason = "GENESIS_HASH_MISMATCH";
    } catch { reason = "INVALID_DESTINATION_IDENTITY"; }
    endpoint.reason = reason; endpoint.lastErrorClass = reason ? "DETERMINISTIC_REJECTION" : null;
    if (reason) recordMetric(metrics, "rpc", { operation: reason === "CHAIN_ID_MISMATCH" ? "eth_chainId" : "eth_getBlockByNumber", reason_class: "DETERMINISTIC_REJECTION" });
    endpoint.lastFailure = null;
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
        observations.push(observation(endpoint,operation,endpoint.status,endpoint.lastErrorClass,endpoint.lastFailure)); continue;
      }
      try {
        const value = await execute(endpoint);
        observations.push(observation(endpoint,operation,"SUCCEEDED"));
        return { value,endpointLabel: endpoint.label,observations: Object.freeze(observations) };
      } catch (error) {
        if (error.coordinationFailure) throw error;
        if (!temporary(classifyBroadcastError(error))) throw safeRejection(endpoint,operation,error,observations);
        unavailable(endpoint,error);
        observations.push(observation(endpoint,operation,"UNAVAILABLE",endpoint.lastErrorClass,error));
      }
    }
    throw exhausted(observations);
  }
  async function collect(operation,execute,selected = endpoints) {
    const results = await Promise.all(selected.map(async endpoint => {
      if (!await probe(endpoint)) return { observation: observation(endpoint,operation,endpoint.status,endpoint.lastErrorClass,endpoint.lastFailure) };
      try { return { endpoint,value: await execute(endpoint),observation: observation(endpoint,operation,"SUCCEEDED") }; }
      catch (error) {
        if (!temporary(classifyBroadcastError(error))) throw safeRejection(endpoint,operation,error,[]);
        unavailable(endpoint,error);
        return { observation: observation(endpoint,operation,"UNAVAILABLE",endpoint.lastErrorClass,error) };
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
    return Object.freeze({ head,blockHash: blockIdentity(blocks[0].value,head),
      endpoints: Object.freeze(samples.map(sample => Object.freeze({ endpointLabel: sample.endpoint.label,head: sample.value }))) });
  }
  async function canonicalBlock(number,view) {
    if (number > view.head) throw inconsistent("RPC_VIEW_INCOMPLETE");
    const values = await collect("fixed canonical block",endpoint => raw(endpoint,"eth_getBlockByNumber",[toHex(number),false]),selectedFor(view));
    if (values.some(value => value.value === null)) throw inconsistent("RPC_VIEW_INCOMPLETE");
    return agree(values,block => blockIdentity(block,number))[0].value;
  }
  async function assertView(view) {
    if (normalizeBytes32((await canonicalBlock(view.head,view)).hash) !== view.blockHash) throw inconsistent();
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
      return (await priority(method,async endpoint => {
        const value = await raw(endpoint,method,params);
        try { return validate(value); }
        catch (error) { recordMetric(metrics, "rpc", { operation: method, reason_class: "RPC_RESPONSE_ERROR" }); throw error; }
      })).value;
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
    async broadcast(rawTransaction,transactionHash,lifecycle) {
      const expected = normalizeBytes32(transactionHash);
      const result = await priority("broadcast",async endpoint => {
        const coordinated = async operation => {
          try { return await operation(); }
          catch (error) { error.coordinationFailure = true; throw error; }
        };
        const event = await coordinated(() => lifecycle?.beforeEndpoint(endpoint.label));
        let hash;
        try {
          hash = await raw(endpoint,"eth_sendRawTransaction",[rawTransaction]);
          let returned;
          try { returned = normalizeBytes32(hash); }
          catch { recordMetric(metrics, "rpc", { operation: "eth_sendRawTransaction", reason_class: "RPC_RESPONSE_ERROR" }); throw new DestinationRpcError("RPC_INVALID_RESPONSE"); }
          if (returned !== expected) {
            recordMetric(metrics, "rpc", { operation: "eth_sendRawTransaction", reason_class: "RPC_RESPONSE_ERROR" });
            throw new DestinationRpcError("RPC_TRANSACTION_HASH_MISMATCH");
          }
        } catch (error) {
          await coordinated(() => lifecycle?.afterEndpoint(event,{ resultClass: "ERROR",errorClass: classifyBroadcastError(error) }));
          throw error;
        }
        await coordinated(() => lifecycle?.afterEndpoint(event,{ resultClass: "ACCEPTED",transactionHash: expected }));
        return expected;
      });
      return Object.freeze({ transactionHash: result.value,acceptedEndpointLabel: result.endpointLabel,observations: result.observations });
    },
    readView,receiptEvidence,canonicalBlock,assertView,
    async gatewayReplay(address,data,view) {
      await assertView(view);
      const values = await collect("Gateway replay",endpoint => raw(endpoint,"eth_call",[{ to: address,data },toHex(view.head)]),selectedFor(view));
      if (values.some(value => !/^0x0{63}[01]$/.test(value.value))) throw new DestinationRpcError("RPC_INVALID_RESPONSE");
      agree(values,value => value);
      await assertView(view);
      return BigInt(values[0].value) === 1n;
    },
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
