import { normalizeAddress } from "../canonical-message.mjs";
import { encodeDestinationSubmission } from "./encoding.mjs";
import { RelayerError, safeRelayerMessage } from "./config.mjs";

export function createSingleRelayer({ config,queue,repository,transactionManager }) {
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
    assertHeld();
    // The only transport input is canonical job identity. Transaction Manager
    // independently verifies it and owns every Ethereum transaction operation.
    const stored = await transactionManager.submitDelivery(deliveryJobId);
    assertHeld();
    return stored;
  }
  return {
    async submitJob(deliveryJobId) {
      return protectedOperation(() => repository.withSingleton(async (assertHeld) => submitOne(deliveryJobId,assertHeld)));
    },
    async runOnce() {
      return protectedOperation(() => repository.withSingleton(async (assertHeld) => {
        assertHeld();
        if (await transactionManager.verifyChain() !== config.destinationDomain) throw new RelayerError("CHAIN_ID_MISMATCH");
        await transactionManager.assertNoUnbroadcast();
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
