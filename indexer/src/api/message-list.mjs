import { normalizeBytes32, toUint256 } from "../canonical-message.mjs";
import { normalizeSourceScope, tableName } from "../db.mjs";
import { evidenceRead, inconsistent, MessageQueryError } from "./errors.mjs";
import { readSnapshot } from "./read-snapshot.mjs";

const invalidQuery = () => new MessageQueryError("INVALID_LIST_QUERY", 400);
const cursorValid = value => typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= 9223372036854775807n;

export function messageListOptions({ limit = 20, cursor = null } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== null && !cursorValid(cursor))) throw invalidQuery();
  return { limit, cursor };
}

export function parseMessageListQuery(parameters) {
  for (const key of parameters.keys()) {
    if (!["limit", "before"].includes(key) || parameters.getAll(key).length !== 1) throw invalidQuery();
  }
  const text = parameters.get("limit") ?? "20";
  if (!/^[1-9][0-9]{0,2}$/.test(text)) throw invalidQuery();
  return messageListOptions({ limit: Number(text), cursor: parameters.get("before") });
}

export async function listRecentMessages({ config, pool }, options) {
  const { limit, cursor } = messageListOptions(options);
  const scope = normalizeSourceScope(config);
  const messages = tableName(config.databaseSchema, "source_messages");
  return evidenceRead(() => readSnapshot(pool, async client => {
    // Prefer the same live occurrence as the detail query, or the newest orphan
    // when all occurrences are REORGED. The competitor search deliberately
    // ignores the page cursor so an older orphan cannot reappear on a later page.
    const rows = (await client.query(`SELECT s.id, s.message_id, s.source_domain, s.source_gateway,
        s.destination_domain, s.status, s.observed_at
      FROM ${messages} s
      WHERE s.source_domain = $1 AND s.source_gateway = $2
        AND ($3::bigint IS NULL OR s.id < $3::bigint)
        AND NOT EXISTS (
          SELECT 1 FROM ${messages} preferred
          WHERE preferred.source_domain = s.source_domain AND preferred.source_gateway = s.source_gateway
            AND preferred.message_id = s.message_id
            AND ((s.status = 'REORGED' AND preferred.status <> 'REORGED')
              OR ((s.status = 'REORGED') = (preferred.status = 'REORGED') AND preferred.id > s.id)))
      ORDER BY s.id DESC LIMIT $4`, [scope.chainDomain, scope.sourceGateway, cursor, limit + 1])).rows;
    const page = rows.slice(0, limit);
    const items = page.map(row => {
      if (!cursorValid(row.id) || row.observed_at == null || row.source_domain !== scope.chainDomain || row.source_gateway !== scope.sourceGateway ||
        !["OBSERVED", "FINALIZING", "FINALIZED", "REORGED"].includes(row.status)) throw inconsistent();
      return { messageId: normalizeBytes32(row.message_id), sourceDomain: row.source_domain,
        destinationDomain: toUint256(row.destination_domain, "destination domain").toString(),
        sourceStatus: row.status, observedAt: new Date(row.observed_at).toISOString() };
    });
    return { apiVersion: "1", authority: "OBSERVATIONAL", observedAt: new Date().toISOString(), items,
      nextCursor: rows.length > limit ? page.at(-1).id : null };
  }));
}
