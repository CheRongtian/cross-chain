import { writeFile } from "node:fs/promises";
import { createPublicClient,http } from "viem";
import { prepareAuthorizedSourceMessage } from "../test/helpers/authorized-source-message.mjs";

const [rpcUrl,application,domain,gateway,receiver,payload,deadline,executor,outputPath] = process.argv.slice(2);
if (!outputPath) throw new Error("expected RPC, application, destination domain/gateway/receiver, payload, deadline, executor and output path");
const proof = await prepareAuthorizedSourceMessage({ publicClient: createPublicClient({ transport: http(rpcUrl) }),application,
  destinationDomain: domain,destinationGateway: gateway,destinationReceiver: receiver,payload,deadline,executor });
await writeFile(outputPath,proof.calldataLines.join("\n") + "\n","utf8");
console.log("Prepared exact forwarding intent: " + proof.intentDigest);
console.log("Forward digest limbs (hi, lo): " + proof.publicInputs.forwardIntentDigestHi + ", " + proof.publicInputs.forwardIntentDigestLo);
console.log("Verified local proof and contract digest agreement for exact payload/destination/deadline/executor.");
