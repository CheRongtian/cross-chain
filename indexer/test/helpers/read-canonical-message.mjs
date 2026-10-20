import { computeCanonicalMessageId, computePayloadHash } from "../../src/canonical-message.mjs";

// Fresh-process readback of a public test message. No encoder copy, database,
// network, prover, environment configuration or protocol worker is involved.
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
console.log(JSON.stringify({ messageId: computeCanonicalMessageId(message), payloadHash: computePayloadHash(message.payload) }));
