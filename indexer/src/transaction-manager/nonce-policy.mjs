import { protocolInteger } from "../../../validator/src/committee.mjs";
import { TransactionError } from "./config.mjs";

export function allocateNonce({ pendingNonce, nextNonce, highestReservedNonce = null }) {
  const candidates = [protocolInteger(pendingNonce, "pending nonce"), protocolInteger(nextNonce, "next nonce")];
  if (highestReservedNonce !== null) candidates.push(protocolInteger(highestReservedNonce, "reserved nonce") + 1n);
  const nonce = candidates.reduce((maximum, value) => value > maximum ? value : maximum);
  if (nonce >= (1n << 256n) - 1n) throw new TransactionError("NONCE_SPACE_EXHAUSTED");
  return Object.freeze({ nonce, nextNonce: nonce + 1n });
}
