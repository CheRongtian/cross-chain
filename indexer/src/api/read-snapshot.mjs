// A normal PostgreSQL read snapshot, not a worker/session/lease lock. Shared
// pools are never closed here; their creator retains resource ownership.
export async function readSnapshot(pool, operation) {
  const client = await pool.connect();
  let discarded = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const value = await operation(client);
    await client.query("COMMIT");
    return value;
  } catch (error) {
    try { await client.query("ROLLBACK"); }
    catch (rollbackError) { discarded = true; client.release(rollbackError); }
    throw error;
  } finally { if (!discarded) client.release(); }
}
