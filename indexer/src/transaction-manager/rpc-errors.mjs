export const BROADCAST_ERROR_CLASSES = Object.freeze(["TRANSIENT_RPC_ERROR","AMBIGUOUS_BROADCAST","ALREADY_KNOWN",
  "REPLACEMENT_UNDERPRICED","NONCE_TOO_LOW","DETERMINISTIC_REJECTION"]);

export function classifyBroadcastError(error) {
  const causes = [];
  const seen = new Set();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = current.cause) {
    seen.add(current); causes.push(current);
  }
  // Typed errors and transport/RPC codes are primary. RPC -32000 alone is not
  // evidence of any specific rejection; inspect its controlled node details.
  if (causes.some(e => e.name === "TimeoutError" ||
      ["ETIMEDOUT","ECONNRESET","UND_ERR_SOCKET","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT"].includes(e.code))) return "AMBIGUOUS_BROADCAST";
  if (causes.some(e => ["InternalRpcError","ResourceUnavailableRpcError","LimitExceededRpcError","SocketClosedError","ProviderDisconnectedError"].includes(e.name) ||
      [-32603,-32002,-32005].includes(e.code) || ["ECONNREFUSED","EHOSTUNREACH","ENOTFOUND","EAI_AGAIN","UND_ERR_CONNECT_TIMEOUT"].includes(e.code) ||
      (e.name === "HttpRequestError" && (e.status === 429 || e.status >= 500)))) return "TRANSIENT_RPC_ERROR";
  const details = causes.flatMap(e => [e.details,e.shortMessage,e.message,typeof e.data === "string" ? e.data : e.data?.message])
    .filter(value => typeof value === "string").join("\n").toLowerCase();
  // viem's NonceTooLowError also represents "already known". Check that
  // narrower node response before using the broader typed nonce category.
  if (/already known|transaction already imported/.test(details)) return "ALREADY_KNOWN";
  if (causes.some(e => e.name === "FeeCapTooLowError") ||
      /replacement transaction underpriced|replacement fee too low|transaction underpriced|max fee per gas less than block base fee|fee cap less than block base fee/.test(details)) return "REPLACEMENT_UNDERPRICED";
  if (causes.some(e => e.name === "NonceTooLowError") || /nonce too low/.test(details)) return "NONCE_TOO_LOW";
  return "DETERMINISTIC_REJECTION";
}
