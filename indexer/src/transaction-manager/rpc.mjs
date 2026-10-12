import { normalizeAddress } from "../canonical-message.mjs";
import { rpcQuantity } from "./transaction.mjs";
import { TransactionError } from "./config.mjs";
import { createDestinationRpcPool } from "./rpc-pool.mjs";

export function createTransactionRpc(config,{ pool = createDestinationRpcPool({ config }) } = {}) {
  return {
    verifyChain: () => pool.verifyChain(),
    health: () => pool.health(),
    pendingNonce: () => pool.nonce("pending"),
    latestNonce: view => pool.nonce(view ? `0x${view.head.toString(16)}` : "latest",view),
    async estimateGas(intent) {
      return pool.request("eth_estimateGas",[{ from: normalizeAddress(intent.senderAddress),
        to: intent.destinationGateway,value: "0x0",data: intent.calldata }],value => {
        const gas = rpcQuantity(value,"gas estimate");
        if (gas === 0n) throw new TransactionError("INVALID_GAS_ESTIMATE");
        return gas;
      });
    },
    fees: () => pool.fees(),
    async broadcast(raw,transactionHash,observe) {
      try {
        const result = await pool.broadcast(raw,transactionHash);
        observe?.(result);
        return result.transactionHash;
      } catch (error) {
        observe?.({ acceptedEndpointLabel: null,observations: error.observations ?? [] });
        throw error;
      }
    },
    readView: () => pool.readView(),
    receiptEvidence: (hash,view) => pool.receiptEvidence(hash,view),
    block: number => pool.block(number),
    transaction: hash => pool.transaction(hash),
  };
}
