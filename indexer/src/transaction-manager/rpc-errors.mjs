export const BROADCAST_ERROR_CLASSES = Object.freeze(["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST","ALREADY_KNOWN",
  "REPLACEMENT_UNDERPRICED","NONCE_TOO_LOW","DETERMINISTIC_REJECTION","RPC_RESPONSE_ERROR"]);

const responseCodes = new Set(["RPC_TRANSACTION_HASH_MISMATCH","RECEIPT_TRANSACTION_HASH_MISMATCH",
  "RECEIPT_TRANSACTION_CONTEXT_MISMATCH","INVALID_RECEIPT_STATUS","INVALID_RPC_ENDPOINT",
  "INVALID_DESTINATION_IDENTITY","CHAIN_ID_MISMATCH","GENESIS_HASH_MISMATCH","EIP1559_REQUIRED","INVALID_MAX_FEE",
  "RPC_INVALID_RESPONSE","RPC_UNKNOWN_ERROR","RPC_HTTP_REJECTED","RPC_REQUEST_REJECTED"]);
const uncertainTransport = new Set(["ETIMEDOUT","ECONNRESET","EOF","UND_ERR_SOCKET","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT"]);
const unavailableTransport = new Set(["ECONNREFUSED","EHOSTUNREACH","ENOTFOUND","EAI_AGAIN","UND_ERR_CONNECT_TIMEOUT"]);

// Destination HTTP/JSON-RPC contract only. In particular -32007 is the known
// provider rate-limit form supported by our pinned client and local fixtures,
// not a universal meaning assigned to Ethereum's server-error range.
export function normalizeRpcError(error,{ operation = "broadcast" } = {}) {
  const causes = [];
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current); causes.push(current);
  }
  const httpStatus = causes.map(e => e.httpStatus ?? e.status).find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const numeric = causes.map(e => e.rpcCode ?? e.code).filter(value => Number.isSafeInteger(value));
  const rpcCode = numeric.find(value => value !== -1) ?? numeric[0];
  const result = (errorClass,errorCode = errorClass) => Object.freeze({ errorClass,errorCode,
    ...(httpStatus === undefined ? {} : { httpStatus }),...(rpcCode === undefined ? {} : { rpcCode }) });
  // These two project-owned wrappers already carry an operation-aware result.
  // Do not turn a normalized read timeout into a broadcast timeout downstream.
  if (["DestinationRpcError","TransactionError"].includes(error?.name) && BROADCAST_ERROR_CLASSES.includes(error?.errorClass)) {
    return result(error.errorClass,typeof error.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : error.errorClass);
  }
  if (httpStatus === 429) return result("TRANSIENT_RPC_ERROR","RPC_RATE_LIMITED");
  if (httpStatus === 408) return result(operation === "broadcast" ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR","RPC_REQUEST_TIMEOUT");
  if (httpStatus >= 500) return result("TRANSIENT_RPC_ERROR","RPC_PROVIDER_UNAVAILABLE");
  if (httpStatus >= 400) return result("RPC_RESPONSE_ERROR","RPC_HTTP_REJECTED");
  const transport = causes.find(e => uncertainTransport.has(e.code) || unavailableTransport.has(e.code));
  if (transport) return result(uncertainTransport.has(transport.code) && operation === "broadcast" ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR",transport.code);
  if ([429,-32007,-32005].includes(rpcCode)) return result("TRANSIENT_RPC_ERROR","RPC_RATE_LIMITED");
  if ([-32603,-32002].includes(rpcCode)) return result("TRANSIENT_RPC_ERROR","RPC_PROVIDER_UNAVAILABLE");
  if (rpcCode === -32003) return result("DETERMINISTIC_REJECTION");
  if ([-32700,-32600,-32601,-32602,-32004,-32006].includes(rpcCode)) return result("RPC_RESPONSE_ERROR","RPC_REQUEST_REJECTED");
  if (BROADCAST_ERROR_CLASSES.includes(error?.errorClass)) return result(error.errorClass);
  if (["RPC_UNAVAILABLE","INCONSISTENT_RPC_VIEW","RPC_VIEW_INCOMPLETE"].includes(error?.code)) return result("TRANSIENT_RPC_ERROR",error.code);
  if (responseCodes.has(error?.code)) return result("RPC_RESPONSE_ERROR",error.code);
  if (causes.some(e => ["SyntaxError","ResponseBodyTooLargeError"].includes(e.name))) return result("RPC_RESPONSE_ERROR","RPC_INVALID_RESPONSE");
  if (causes.some(e => ["InvalidSenderError","InvalidSignatureError","IntrinsicGasTooLowError","TransactionTypeNotSupportedError","TransactionRejectedRpcError"].includes(e.name))) return result("DETERMINISTIC_REJECTION");
  if (causes.some(e => ["TimeoutError","SocketClosedError"].includes(e.name))) return result(operation === "broadcast" ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR","RPC_REQUEST_TIMEOUT");
  if (causes.some(e => ["InternalRpcError","ResourceUnavailableRpcError","LimitExceededRpcError","ProviderDisconnectedError"].includes(e.name))) return result("TRANSIENT_RPC_ERROR","RPC_PROVIDER_UNAVAILABLE");
  // Bounded, normalized node-detail fallback for the real generic -32000 form
  // and libraries that supply no more specific structured metadata.
  const details = causes.flatMap(e => [e.details,e.shortMessage,e.message,typeof e.data === "string" ? e.data : e.data?.message])
    .filter(value => typeof value === "string").map(value => value.slice(0,4096)).join("\n").slice(0,16384).toLowerCase();
  // viem's NonceTooLowError also represents "already known". Check that
  // narrower node response before using the broader typed nonce category.
  if (/already known|transaction already imported/.test(details)) return result("ALREADY_KNOWN");
  if (causes.some(e => e.name === "FeeCapTooLowError") ||
      /replacement transaction underpriced|replacement fee too low|transaction underpriced|max fee per gas less than block base fee|fee cap less than block base fee/.test(details)) return result("REPLACEMENT_UNDERPRICED");
  if (causes.some(e => e.name === "NonceTooLowError") || /nonce too low/.test(details)) return result("NONCE_TOO_LOW");
  if (/invalid sender|invalid signature|invalid transaction encoding|intrinsic gas too low|unsupported transaction type|transaction type not supported|insufficient funds/.test(details)) return result("DETERMINISTIC_REJECTION");
  if (/unexpected eof|socket hang up|network reset|request timed out|request timeout/.test(details)) return result(operation === "broadcast" ? "AMBIGUOUS_BROADCAST" : "TRANSIENT_RPC_ERROR","RPC_REQUEST_TIMEOUT");
  return result("RPC_RESPONSE_ERROR","RPC_UNKNOWN_ERROR");
}

export function classifyBroadcastError(error,options) {
  return normalizeRpcError(error,options).errorClass;
}
