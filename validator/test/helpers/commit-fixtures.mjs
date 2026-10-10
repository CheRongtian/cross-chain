import { validatorAccount } from "../../src/identity.mjs";
import { commitDigest } from "../../src/commit.mjs";
import { expectedCommitStatement } from "../../src/quorum-certificate.mjs";
import { configuration, snapshotFixture } from "./fixtures.mjs";

export const commitConfigs = Array.from({ length: 4 }, (_, index) => configuration({}, index));

export async function commitFixture() {
  const snapshot = await snapshotFixture();
  const statement = expectedCommitStatement({ sourceDomain: snapshot.record.sourceDomain,
    sourceGateway: snapshot.record.sourceGateway, epoch: snapshot.record.epoch,
    batchId: snapshot.record.batchId, messageRoot: snapshot.record.messageRoot }, commitConfigs[0]);
  const options = { peers: commitConfigs[0].peers, expected: statement };
  const votes = await Promise.all(commitConfigs.map((config) => signedCommitFixture(statement, config)));
  return { snapshot, statement, options, votes };
}

// Adversarial fixtures sign raw canonical fields without invoking production state transitions.
export async function signedCommitFixture(statement, config, overrides = {}) {
  const fields = { messageType: "COMMIT", ...statement, voterIdentity: config.validatorAddress, ...overrides };
  const digest = commitDigest(fields);
  const signature = await validatorAccount(config.privateKey).signMessage({ message: { raw: digest } });
  return { ...fields, commitDigest: digest, signature };
}
