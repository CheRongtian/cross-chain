import { readFile } from "node:fs/promises";

const root = new URL("../../public/explorer/", import.meta.url);
const assets = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/explorer", ["index.html", "text/html; charset=utf-8"]],
  ["/assets/explorer/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/assets/explorer/client.js", ["client.js", "text/javascript; charset=utf-8"]],
  ["/assets/explorer/view-model.js", ["view-model.js", "text/javascript; charset=utf-8"]],
  ["/assets/explorer/render.js", ["render.js", "text/javascript; charset=utf-8"]],
  ["/assets/explorer/styles.css", ["styles.css", "text/css; charset=utf-8"]],
]);

export const explorerHeaders = {
  "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

export function isExplorerPath(path) { return assets.has(path); }
export async function readExplorerAsset(path) {
  const [file, contentType] = assets.get(path);
  return { body: await readFile(new URL(file, root)), contentType };
}
