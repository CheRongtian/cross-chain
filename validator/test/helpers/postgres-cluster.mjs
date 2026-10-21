// Share ownership checks and lifecycle with the interactive local stack while
// preserving the established recovery-scenario import and CLI entry.
export * from "../../../scripts/lib/owned-postgres.mjs";
import { disposeOwnedPostgres, postgresBinaries } from "../../../scripts/lib/owned-postgres.mjs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , command, registryPath] = process.argv;
  if (command === "--check-tools") {
    for (const [name, path] of Object.entries(await postgresBinaries())) console.log(`Verified existing PostgreSQL tool ${name}: ${path}`);
  } else {
    if (command !== "--dispose" || !registryPath) throw new Error("usage: postgres-cluster.mjs --check-tools | --dispose <owned-registry-file>");
    await disposeOwnedPostgres(registryPath);
  }
}
