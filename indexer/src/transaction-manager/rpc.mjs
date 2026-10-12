import { createPublicClient, http, toHex } from "viem";
import { normalizeAddress } from "../canonical-message.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";

export function createTransactionRpc(config) {
  const client = createPublicClient({ transport: http(config.destinationRpcUrl, { retryCount: 0, timeout: 10000 }) });
  const request = (method, params = []) => client.request({ method, params }, { retryCount: 0 });
  return {
    async verifyChain() {
      if (rpcQuantity(await request("eth_chainId"), "chain ID") !== config.destinationDomain) throw new TransactionError("CHAIN_ID_MISMATCH");
      return config.destinationDomain;
    },
    async pendingNonce() { return rpcQuantity(await request("eth_getTransactionCount", [config.relayerAddress, "pending"]), "pending nonce"); },
    async estimateGas(intent) {
      const gas = rpcQuantity(await request("eth_estimateGas", [{ from: normalizeAddress(intent.senderAddress),
        to: intent.destinationGateway, value: "0x0", data: intent.calldata }]), "gas estimate");
      if (gas === 0n) throw new TransactionError("INVALID_GAS_ESTIMATE");
      return gas;
    },
    async fees() {
      const [block, priority] = await Promise.all([request("eth_getBlockByNumber", ["latest", false]), request("eth_maxPriorityFeePerGas")]);
      if (!block || block.baseFeePerGas == null) throw new TransactionError("EIP1559_REQUIRED");
      const maxPriorityFeePerGas = rpcQuantity(priority, "priority fee");
      const maxFeePerGas = rpcQuantity(block.baseFeePerGas, "base fee") * 2n + maxPriorityFeePerGas;
      if (maxFeePerGas >= (1n << 256n)) throw new TransactionError("INVALID_MAX_FEE");
      return { maxFeePerGas, maxPriorityFeePerGas };
    },
    async broadcast(raw) { return request("eth_sendRawTransaction", [raw]); },
    async head() { return rpcQuantity(await request("eth_blockNumber"), "head"); },
    async receipt(hash) { return request("eth_getTransactionReceipt", [hash]); },
    async block(number) { return request("eth_getBlockByNumber", [toHex(number), false]); },
    async transaction(hash) { return request("eth_getTransactionByHash", [hash]); },
  };
}
