import assert from "node:assert/strict";
import test from "node:test";
import { HANDSHAKE_DOMAIN, handshakeDigest, signHandshake, verifyHandshakeResponse } from "../src/handshake.mjs";
import { MESSAGE_BATCH_TYPEHASH } from "../../indexer/src/message-batch.mjs";
import { configuration } from "./helpers/fixtures.mjs";

const challenge = `0x${"a7".repeat(32)}`;
const otherChallenge = `0x${"b8".repeat(32)}`;

test("handshake proves peer key control with a separate source-bound domain", async () => {
  const requester = configuration({}, 0);
  const peer = configuration({}, 1);
  const response = await signHandshake(peer, challenge);
  assert.equal(await verifyHandshakeResponse(requester, peer.validatorAddress, challenge, response), true);
  assert.notEqual(HANDSHAKE_DOMAIN, MESSAGE_BATCH_TYPEHASH);
  assert.notEqual(handshakeDigest(peer, peer.validatorAddress, challenge), handshakeDigest(peer, peer.validatorAddress, otherChallenge));
  assert.ok(!JSON.stringify(response).includes(peer.privateKey));
});

test("wrong keys, context, advertised identity, signatures, and challenge replay reject", async () => {
  const requester = configuration({}, 0);
  const peer = configuration({}, 1);
  const other = configuration({}, 2);
  const response = await signHandshake(peer, challenge);
  const wrongKeyResponse = { ...await signHandshake(other, challenge), validatorAddress: peer.validatorAddress };
  for (const invalid of [wrongKeyResponse,
    { ...response, validatorAddress: other.validatorAddress }, { ...response, challenge: otherChallenge },
    { ...response, sourceDomain: "2001" }, { ...response, sourceGateway: other.validatorAddress },
    { ...response, protocolVersion: "2" }, { ...response, signature: "0x00" },
  ]) assert.equal(await verifyHandshakeResponse(requester, peer.validatorAddress, challenge, invalid), false);
  assert.equal(await verifyHandshakeResponse(requester, peer.validatorAddress, otherChallenge, response), false);
  assert.equal(await verifyHandshakeResponse(requester, "0x0000000000000000000000000000000000009999", challenge, response), false);
  const wrongContext = await signHandshake({ ...peer, chainDomain: 2001n }, challenge);
  assert.equal(await verifyHandshakeResponse(requester, peer.validatorAddress, challenge, { ...wrongContext, sourceDomain: "10011" }), false);
  await assert.rejects(signHandshake(peer, "0x00"));
});
