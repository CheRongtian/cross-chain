import { normalizeAddress, normalizeBytes32 } from "../canonical-message.mjs";
import { encodeDestinationSubmission } from "./encoding.mjs";
import { RelayerError, safeRelayerMessage } from "./config.mjs";

export function createSingleRelayer({ config,queue,repository,submitter }) {
  const verification = { validatorSets: config.validatorSets,sourceDomain: config.chainDomain,sourceGateway: config.sourceGateway };
  async function protectedOperation(operation) {
    try { return await operation(); }
    catch (error) {
      const safe = new Error(safeRelayerMessage(error,config));
      safe.code = error?.code ?? "RELAYER_RUN_FAILED";
      throw safe;
    }
  }
  async function submitOne(deliveryJobId,assertHeld) {
    const job = await queue.getDeliveryJob(deliveryJobId);
    if (job.status !== "READY" || job.deliveryJobId !== deliveryJobId) throw new RelayerError("RELAYER_REQUIRES_READY");
    // Strict queue read and independent verification/encoding at the send boundary.
    const encoded = await encodeDestinationSubmission(await queue.getDeliveryPackage(deliveryJobId),verification);
    const pack = encoded.package;
    if (pack.deliveryJobId !== deliveryJobId || pack.message.destinationDomain !== config.destinationDomain.toString() ||
        job.destinationDomain !== pack.message.destinationDomain || normalizeAddress(job.destinationGateway) !== pack.message.destinationGateway) throw new RelayerError("DESTINATION_CONTEXT_MISMATCH");
    const previous = await repository.getSubmission(deliveryJobId,encoded);
    if (previous) {
      if (previous.deliveryJobId !== deliveryJobId || previous.packageDigest !== encoded.packageDigest ||
          previous.destinationDomain !== pack.message.destinationDomain || normalizeAddress(previous.destinationGateway) !== pack.message.destinationGateway) throw new RelayerError("CONFLICTING_RELAY_SUBMISSION");
      return Object.freeze({ ...previous,submitted: false });
    }
    assertHeld();
    const actualDomain = await submitter.verifyChain();
    if (actualDomain !== config.destinationDomain) throw new RelayerError("CHAIN_ID_MISMATCH");
    assertHeld();
    const transactionHash = normalizeBytes32(await submitter.submit({ to: pack.message.destinationGateway,data: encoded.data,value: 0n }),"transaction hash");
    // Broadcast may already have happened if this session/persistence now fails.
    // No automatic resend or recovery is attempted for that ambiguity.
    assertHeld();
    const stored = await repository.recordSubmission({ deliveryJobId,encoded,transactionHash });
    return Object.freeze({ ...stored,submitted: true });
  }
  return {
    async submitJob(deliveryJobId) {
      return protectedOperation(() => repository.withSingleton(async (assertHeld) => submitOne(deliveryJobId,assertHeld)));
    },
    async runOnce() {
      return protectedOperation(() => repository.withSingleton(async (assertHeld) => {
        assertHeld();
        if (await submitter.verifyChain() !== config.destinationDomain) throw new RelayerError("CHAIN_ID_MISMATCH");
        const jobs = await repository.listEligibleJobs({ limit: config.maxJobs });
        const results = [];
        for (const job of jobs) results.push(await submitOne(job.deliveryJobId,assertHeld));
        return Object.freeze({ relayerAddress: config.relayerAddress,destinationDomain: config.destinationDomain.toString(),
          selected: jobs.length,submitted: results.filter((result) => result.submitted).length,
          skipped: results.filter((result) => !result.submitted).length,results: Object.freeze(results) });
      }));
    },
  };
}
