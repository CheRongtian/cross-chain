export class MessageQueryError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
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
