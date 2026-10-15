import { readFile, writeFile } from "node:fs/promises";
import { createValidatorSetResolver } from "../../validator/src/validator-sets.mjs";
import { deliveryFixture } from "../test/helpers/delivery-fixtures.mjs";
import { buildDeliveryPackages, deliveryJson } from "../src/delivery/package.mjs";
import { encodeGatewaySubmission } from "../src/relayer/encoding.mjs";

// Explicit offline fixture authoring only. The verification entry never invokes this generator.
// Existing signed QC bytes are reused verbatim. No RPC, database, proof or external process is used.
const certificates = JSON.parse(await readFile(new URL("../../test-vectors/pbft-certificates.json", import.meta.url), "utf8"));
const validatorSets = createValidatorSetResolver(certificates.history);
const frozen = certificates.cases.find(entry => entry.name === "v3-quorum-3");
const snapshot = await deliveryFixture({ protocolVersion: "3", epoch: 23n, validatorSets });
snapshot.quorumCertificate = structuredClone(frozen.certificate);
const [pack] = await buildDeliveryPackages(snapshot, { validatorSets });
const encoded = await encodeGatewaySubmission(pack, { validatorSets });
const vector = { description: "Complete frozen Gateway wire vector using the existing opaque-payload fixture and unchanged historical QC. Not an ApplicationB supplier command or a historical business execution claim.",
  transportVersion: 1, functionSignature: "execute(bytes)", selector: encoded.calldata.slice(0, 10),
  expectedTarget: pack.message.destinationGateway, expectedValue: "0", certificateCase: frozen.name,
  validatorHistory: certificates.history, package: pack, canonicalPackageBytes: encoded.data,
  packageDigest: encoded.packageDigest, gatewayCalldata: encoded.calldata };
// Exclusive creation prevents a later normal invocation from overwriting the frozen expected evidence.
await writeFile(new URL("../../test-vectors/destination-transport.json", import.meta.url), deliveryJson(vector) + "\n", { flag: "wx" });
console.log("Created frozen destination-transport.json from unchanged public fixture evidence (offline only).");
