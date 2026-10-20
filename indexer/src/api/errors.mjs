export class MessageQueryError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}

export class MessageQueryConfigurationError extends Error {
  constructor(issues) {
    super(`Check the root .env: ${issues.join("; ")}`);
    this.name = "MessageQueryConfigurationError";
    this.code = "INVALID_CONFIGURATION";
  }
}

// Operator startup diagnostics are separate from public HTTP responses. Only
// configuration field names and fixed instructions are safe to print here.
export function messageQueryStartupError(error) {
  if (error instanceof MessageQueryConfigurationError) return `${error.code}: ${error.message}`;
  if (error?.code === "EADDRINUSE") return "LISTEN_ADDRESS_IN_USE: check MESSAGE_QUERY_API_HOST and MESSAGE_QUERY_API_PORT; another process already owns the address";
  if (error?.code === "EACCES") return "LISTEN_PERMISSION_DENIED: check MESSAGE_QUERY_API_HOST and MESSAGE_QUERY_API_PORT";
  if (error?.code === "EADDRNOTAVAIL") return "LISTEN_ADDRESS_UNAVAILABLE: MESSAGE_QUERY_API_HOST must identify an address available on this machine";
  return publicQueryError(error).body.error;
}

export const inconsistent = () => new MessageQueryError("INCONSISTENT_EVIDENCE", 409);

export function publicQueryError(error) {
  if (error instanceof MessageQueryError) return { status: error.status, body: { error: error.code } };
  // PostgreSQL connection/resource failures have structured codes. Messages,
  // URLs, stacks and provider text never become HTTP error content.
  const code = error?.code ?? "";
  const unavailable = /^(08|28|53|57P)/.test(code) || ["57014", "3D000", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EPIPE"].includes(code);
  return { status: unavailable ? 503 : 500, body: { error: unavailable ? "DEPENDENCY_UNAVAILABLE" : "INTERNAL_ERROR" } };
}

export async function evidenceRead(operation) {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MessageQueryError || error instanceof TypeError || error instanceof ReferenceError ||
      publicQueryError(error).status === 503 || error?.severity) throw error;
    throw inconsistent();
  }
}
