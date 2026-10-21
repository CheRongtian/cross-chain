import assert from "node:assert/strict";
import { mkdir,readFile,writeFile } from "node:fs/promises";
import { getAddress,keccak256,stringToHex } from "viem";
import { FORWARD_AUTHORIZATION_TYPE,CREDENTIAL_PUBLIC_SIGNAL_ORDER,encodeForwardIntent,splitForwardIntentDigest } from "../src/forward-authorization.mjs";

const source = JSON.parse(await readFile(new URL("../../test-vectors/forward-authorizations.json",import.meta.url),"utf8"));
assert.equal(FORWARD_AUTHORIZATION_TYPE,source.type);
// The immutable vector freezes the original eleven positions and intent ABI.
assert.deepEqual(CREDENTIAL_PUBLIC_SIGNAL_ORDER,[...source.publicSignalOrder,"authorizationValidUntil"]);
assert.equal(source.abiWords.length,11);
assert.ok(source.abiWords.every(word => /^[0-9a-f]{64}$/.test(word)));
const encoded = keccak256(stringToHex(source.type)) + source.abiWords.join("");
assert.equal(encodeForwardIntent(source.intent),encoded,"intent encoding drifted from the fixed ABI words");
const digest = keccak256(encoded); const limbs = splitForwardIntentDigest(digest);
const intent = source.intent;
const fields = Object.entries(intent).map(([name,value]) => "            " + name + ": " + (["application","sourceGateway","destinationGateway","destinationReceiver","authorizedExecutor"].includes(name) ? getAddress(value) : value)).join(",\n");
const directory = new URL("../../contracts/generated/",import.meta.url);
await mkdir(directory,{ recursive: true });
await writeFile(new URL("ForwardAuthorizationVector.sol",directory),`// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ForwardAuthorizationCodec} from "../src/ForwardAuthorizationCodec.sol";
/// @notice Generated from fixed ABI words, independent of the production encoder.
library ForwardAuthorizationVector {
    function intent() internal pure returns (ForwardAuthorizationCodec.Intent memory) {
        return ForwardAuthorizationCodec.Intent({
${fields}
        });
    }
    function expectedEncoding() internal pure returns (bytes memory) { return hex"${encoded.slice(2)}"; }
    function expectedDigest() internal pure returns (bytes32) { return ${digest}; }
    function expectedHi() internal pure returns (uint256) { return ${limbs.forwardIntentDigestHi}; }
    function expectedLo() internal pure returns (uint256) { return ${limbs.forwardIntentDigestLo}; }
}
`,"utf8");
console.log("Prepared forwarding vector from fixed ABI words and canonical public-signal order.");
