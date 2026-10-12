import { fromRlp, keccak256, padHex, recoverAddress, serializeTransaction } from "viem";
import { normalizeAddress, normalizeBytes32, normalizePayload } from "../canonical-message.mjs";
import { protocolInteger } from "../../../validator/src/committee.mjs";
import { TransactionError } from "./config.mjs";

export function unsignedTransaction(intent, fields) {
  const gas = protocolInteger(fields.gasLimit, "gas limit");
  const maxFeePerGas = protocolInteger(fields.maxFeePerGas, "max fee");
  const maxPriorityFeePerGas = protocolInteger(fields.maxPriorityFeePerGas, "priority fee");
  if (gas === 0n || maxFeePerGas < maxPriorityFeePerGas || protocolInteger(intent.value, "value") !== 0n) {
    throw new TransactionError("INVALID_TRANSACTION_FIELDS");
  }
  return { type: "eip1559", chainId: protocolInteger(intent.chainId, "chain ID"),
    nonce: protocolInteger(fields.nonce, "nonce"), to: normalizeAddress(intent.destinationGateway), value: 0n,
    data: normalizePayload(intent.calldata), gas, maxFeePerGas, maxPriorityFeePerGas, accessList: [] };
}

export async function signDeliveryTransaction(intent, fields, account) {
  if (normalizeAddress(account.address) !== intent.senderAddress) throw new TransactionError("TRANSACTION_SENDER_MISMATCH");
  const rawSignedTransaction = normalizePayload(await account.signTransaction(unsignedTransaction(intent, fields)));
  const attempt = { ...fields, transactionType: 2, rawSignedTransaction, transactionHash: keccak256(rawSignedTransaction).toLowerCase() };
  await verifySignedTransaction(intent, attempt);
  return Object.freeze(attempt);
}

export async function verifySignedTransaction(intent, attempt) {
  try {
    const raw = normalizePayload(attempt.rawSignedTransaction);
    if (attempt.transactionType !== 2 || !raw.startsWith("0x02") ||
        keccak256(raw).toLowerCase() !== normalizeBytes32(attempt.transactionHash)) throw new Error();
    // viem's parseTransaction converts nonce to Number. Decode the type-2 RLP
    // directly so even a large persisted nonce remains exact during strict reads.
    const fields = fromRlp(`0x${raw.slice(4)}`, "hex");
    if (!Array.isArray(fields) || fields.length !== 12 || !Array.isArray(fields[8]) || fields[8].length !== 0) throw new Error();
    const parity = fields[9] === "0x" ? 0n : BigInt(fields[9]);
    if (parity !== 0n && parity !== 1n) throw new Error();
    const signature = { r: padHex(fields[10], { size: 32 }), s: padHex(fields[11], { size: 32 }), yParity: Number(parity) };
    const transaction = unsignedTransaction(intent, attempt);
    if (serializeTransaction(transaction, signature).toLowerCase() !== raw) throw new Error();
    const sender = await recoverAddress({ hash: keccak256(serializeTransaction(transaction)), signature });
    if (normalizeAddress(sender) !== normalizeAddress(intent.senderAddress)) throw new Error();
    return Object.freeze({ ...attempt });
  } catch { throw new TransactionError("CORRUPTED_SIGNED_TRANSACTION"); }
}

export function rpcQuantity(value, label = "RPC quantity") {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new TransactionError(`INVALID_${label.toUpperCase().replaceAll(" ", "_")}`);
  return protocolInteger(BigInt(value), label);
}
