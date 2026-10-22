# Contracts

[Project overview and public commands](../README.md)

This directory owns the EVM authorization and execution boundaries.
Chain A admits exact credential-authorized forwarding; Chain B authenticates
certified message evidence before atomically consuming an ID and calling its receiver.

## Contents

- [Contract map](#contract-map)
- [Canonical messages](#canonical-messages)
- [Source admission](#source-admission)
- [Credential application](#credential-application)
- [Destination registries](#destination-registries)
- [Certificate verification](#certificate-verification)
- [Batch and Merkle verification](#batch-and-merkle-verification)
- [Message domain policy](#message-domain-policy)
- [Delivery transport](#delivery-transport)
- [Atomic execution and replay](#atomic-execution-and-replay)
- [Supplier application](#supplier-application)
- [Development and verification](#development-and-verification)
- [Security boundaries](#security-boundaries)

## Contract map

| Contract or library | Responsibility |
| --- | --- |
| [MessageCodec](src/MessageCodec.sol) | Canonical message fields and typed ABI/Keccak identity |
| [ForwardAuthorizationCodec](src/ForwardAuthorizationCodec.sol) | Exact source forwarding-intent digest and uint128 limb split |
| [SourceGateway](src/SourceGateway.sol) | Application admission, source nonce, message emission |
| [CredentialVerifier](src/CredentialVerifier.sol) | Named twelve-signal inputs mapped to the generated Groth16 verifier |
| [IdentityApplicationA](src/IdentityApplicationA.sol) | Credential policy, state root, nullifier, exact authorized forwarding |
| [RemoteGatewayRegistry](src/RemoteGatewayRegistry.sol) | Current trusted remote Gateway for each source domain |
| [ValidatorSetRegistry](src/ValidatorSetRegistry.sol) | Append-only historical four-member committees |
| [PBFTCertificateVerifier](src/PBFTCertificateVerifier.sol) | Bounded certificate parsing and historical signature authority |
| [MessageMerkle](src/MessageMerkle.sol) | Typed ordered Merkle verification kernel |
| [MerkleInclusionVerifier](src/MerkleInclusionVerifier.sol) | Bind the full ordered ID list, batch ID, count, position, and root |
| [MessageDomainVerifier](src/MessageDomainVerifier.sol) | Full message identity, current source trust, route, and deadline |
| [MessageReplayProtection](src/MessageReplayProtection.sol) | Internal message-ID consumption and public executed-state query |
| [DestinationGateway](src/DestinationGateway.sol) | Production package verification and atomic receiver call |
| [ApplicationB](src/ApplicationB.sol) | Authenticated example supplier-grant business logic |

Source credential policy and destination message policy are separate.
No destination contract re-verifies the private credential witness.
For circuit details, see [ZK authorization](../zk/README.md).

## Canonical messages

The message format is version `2`.
[MessageCodec](src/MessageCodec.sol) defines the exact schema separator:

```text
CrossChainMessage(uint8 version,uint256 sourceDomain,address sourceGateway,address sourceSender,uint256 destinationDomain,address destinationGateway,address destinationReceiver,uint256 nonce,bytes32 payloadHash,uint256 deadline)
```

`messageId` is Ethereum Keccak-256 over `abi.encode(typeHash, fields...)`
in that order. `payloadHash = keccak256(payload)`.
Use standard Solidity ABI encoding, not packed ABI, JSON hashing, SHA3-256,
or a personal-sign prefix.

| Field | Meaning |
| --- | --- |
| version | Supported message schema, currently 2 |
| sourceDomain | Chain A chain ID |
| sourceGateway | Actual emitting Gateway |
| sourceSender | Application directly calling that Gateway |
| destinationDomain | Explicit destination chain domain |
| destinationGateway | Exact execution Gateway |
| destinationReceiver | Exact receiver contract address |
| nonce | SourceGateway-wide sequence |
| payloadHash | Commitment to the complete raw payload |
| deadline | Strict destination execution deadline |

Domains, nonce, and deadline retain uint256 semantics.
Addresses occupy canonical ABI address words.
Raw payload and source block/transaction provenance are carried separately;
observation times, database IDs, and destination transaction hashes do not enter
the canonical message ID.

Changing any bound field changes the ID.
A correctly rehashed altered message still needs membership under the authenticated
batch root; self-consistent encoding alone is insufficient authorization.

[Canonical vectors](../test-vectors/canonical-messages.json) freeze shared
Solidity/JavaScript bytes and expected identities.

## Source admission

`SourceGateway` has an immutable nonzero authorization administrator and an
`authorizedSourceApplications` mapping.
Only the administrator changes admission.
Adding an application requires a nonzero code-bearing address; revocation remains
possible after code disappears. No-op configuration changes revert.

`sendMessage(destinationDomain, destinationGateway, destinationReceiver, payload, deadline)`
requires:

- an admitted direct caller;
- a nonzero destination domain different from `block.chainid`;
- nonzero destination Gateway and receiver addresses;
- payload size at most 4096 bytes;
- `deadline > block.timestamp`.

The Gateway supplies `block.chainid`, `address(this)`, and `msg.sender`
for the source fields.
Its next nonce starts at `1`; rejected sends allocate no nonce and emit no event.
Successful sends emit the complete public payload and canonical identity.

The Gateway does not validate credentials, interpret supplier commands, require
destination bytecode on Chain A, or authenticate destination registry state.
Its `computeMessageId` helper provides encoding parity without admitting a send.

## Credential application

### Verifier adapter

`CredentialVerifier` binds a generated verifier contract and converts
`ICredentialVerifier.CredentialPublicInputs` to the circuit's twelve-element array.
It does not independently apply issuer policy, current root, proof freshness,
execution-time expiry, nullifier replay, or forwarding-intent policy.

The generated verifier and fixtures are development artifacts under
`contracts/generated/`, produced by the unified proving workflow.
They are not handwritten substitutes for the circuit.

### Configuration and state

`IdentityApplicationA` is constructed with:

- code-bearing credential verifier and SourceGateway addresses;
- the trusted issuer and required role `VERIFIED_SUPPLIER = 1`;
- a positive `maxProofAge`;
- a nonzero credential-state authority and initial state root.

Its canonical application domain binds the domain namespace, Chain A ID,
and application address, reduced to the BN254 scalar field.
The initial policy epoch is `1`.

Authorization status is keyed by public credential commitment:

```text
UNVERIFIED = 0
VERIFIED_SUPPLIER = 1
REVOKED = 2
```

The private subject is not proven to own an EVM account.
Status therefore grants no general capability to the transaction submitter.
Stored supplier status does not automatically expire.

### Authorization entries

`verifySupplier(proofA, proofB, proofC, publicInputs)` requires action `1`
with both forwarding-intent limbs zero.
It applies policy and verifies the proof before consuming the nullifier and
recording supplier status.

`forwardAuthorizedMessage(proofA, proofB, proofC, publicInputs, request)`
requires action `3` and a proof for the exact recomputed request.
Standalone verification cannot replace that proof.

Both entries enforce the configured issuer/role, no future proof timestamp,
the independent maximum proof age, strict execution-time authorization deadline,
current root, explicit non-revocation, canonical application domain, current
policy epoch, expected action, and an unused valid nullifier.

For forwarding, `ForwardRequest` contains destination domain, Gateway,
receiver, raw payload, and message deadline.
[ForwardAuthorizationCodec](src/ForwardAuthorizationCodec.sol) additionally binds:

```text
protocolVersion, action, sourceDomain, application, sourceGateway,
destinationDomain, destinationGateway, destinationReceiver,
payloadHash, deadline, authorizedExecutor
```

The executor is the actual `msg.sender`.
The full Keccak digest is split into high and low uint128 limbs; it is not reduced
to one field element. `forwardIntentDigest` is a view helper, not permission.

Proof verification, nullifier consumption, and the source Gateway call occur
in one EVM transaction.
A downstream rejection restores the nullifier, source nonce, and all events.
Successful forwarding emits `AuthorizedMessageForwarded` linking intent digest,
nullifier, and canonical message ID.

The proof's public `authorizationValidUntil` and the message's `deadline`
protect different execution points. Application A requires
`block.timestamp < authorizationValidUntil`; Chain B checks the message deadline.
Neither one extends the other.

### Root and policy authority

Only `credentialStateAuthority` may update the active nonzero root, explicitly
mark supplied commitments revoked, or advance the policy epoch.
These are independent operations.
Consumed nullifiers remain recorded through root and epoch changes.

Root replacement invalidates old membership evidence for later calls.
Explicitly revoked commitment status remains revoked.
Publishing an honest active root and revocation list is an administrator
responsibility; the contract does not derive them from private credentials.

Exact binding covers the current forwarding entry only.
Other admitted source applications own their policy, and historical messages
are not retroactively authenticated by this application.

## Destination registries

### Current remote Gateway trust

`RemoteGatewayRegistry` maps each exact uint256 source domain to one currently
trusted nonzero address. Zero means unknown.
Its immutable administrator may add, replace, or remove mappings.

`trustedRemoteGateway`, `isTrustedRemoteGateway`, and
`requireTrustedRemoteGateway` use exact domain/address semantics, with no
wildcard or fallback.
Repeated writes and removal of unknown entries revert.
Events preserve configuration history; current storage supplies authority.

A remote Gateway is an identity on another chain.
It need not contain bytecode on Chain B.
Replacing or removing it immediately changes current message eligibility;
historical Gateway epochs and grace periods are not represented.

### Historical validator authority

`ValidatorSetRegistry.registerValidatorSet(validatorEpoch, address[4])`
is administrator-only.
It sorts the four nonzero distinct identities by unsigned address value,
derives their committee digest, and stores fixed quorum `3`.

The first epoch may be any uint256, including zero.
Later epochs must be consecutive; rewrites, deletion, gaps, and overflow revert.
`getValidatorSet` resolves the exact historical epoch and rejects unknown epochs.
Initial/latest getters require initialized history; zero is not an absence sentinel.

The committee digest preserves:

```text
typeHash = keccak256("PBFTStaticCommittee(uint8 protocolVersion,address[4] validators)")
digest = keccak256(abi.encode(typeHash, uint8(1), canonicalValidators))
```

This committee codec version `1` is independent of PBFT evidence version `3`.
The same members in another epoch have the same digest; the signed validator
epoch still selects its exact authority record.

The fixture history is epoch 7 = V1–V4, epoch 8 = V2–V5.
There are four active members per epoch and five known historical identities.
Off-chain batch activation boundaries are configured outside this registry.

Remote trust and validator authority are independent.
Neither registry accepts a QC, proves source finality, consumes replay state,
or executes a receiver.

## Certificate verification

`PBFTCertificateVerifier.verifyCertificate(certificate, expected)`
returns true or reverts with a precise custom error.
It is stateless except for its immutable ValidatorSetRegistry reference.

`ExpectedContext` supplies protocol version, source domain/Gateway, batch epoch,
`viewNumber`, batch ID, Message Root, and authority epoch.
The Solidity name `viewNumber` maps the protocol's `view` field without changing
signed encodings. A certificate cannot authenticate self-selected expectations.

The transport QC tuple is:

```text
(uint8 version, bytes statement, bytes32 qcDigest,
 (address voterIdentity, bytes32 commitDigest, bytes signature)[] commits)
```

The parser checks exact offsets, version-specific statement lengths, scalar
widths, evidence count, signature lengths, zero padding, and complete consumption.
Only three or four entries are permitted, with maximum certificate size 1504 bytes.

Version `3` binds its signed validator epoch and exact committee digest.
The verifier derives the proposal and COMMIT digests from authenticated context,
including the deterministic primary.
Primary selection preserves mathematical full-width epoch/view arithmetic.

Legacy version `1` has view zero; version `2` is view-bound.
Both resolve the immutable initial registry committee because they contain no
signed validator epoch.
The caller must explicitly expect that original version and initial authority.
There is no latest-committee fallback or invented universal legacy batch cutoff.

COMMIT signs the raw 32-byte typed digest through EIP-191 personal-sign.
Accepted signatures are exactly 65 bytes, with recovery IDs 0/1/27/28,
valid nonzero r/s values, and the claimed recovered historical member.
Existing high-s compatibility is preserved.

Voters must be strictly ascending by address.
Repeated identities, including different signatures for one signer, add no weight.
When four entries are supplied, all four are validated.

A valid QC authenticates a batch/root statement under historical committee trust.
It does not establish remote trust, message inclusion, deadline validity,
destination routing, replay status, or business success.

See [Validator PBFT reference](../validator/README.md) for phase domains,
durable vote locks, safe view changes, and committee activation.

## Batch and Merkle verification

The canonical version-1 batch commitment is:

```text
MessageBatch(uint8 version,uint256 sourceDomain,address sourceGateway,uint256 epoch,bytes32[] messageIds)
batchId = keccak256(abi.encode(typeHash, uint8(1),
                             sourceDomain, sourceGateway, epoch, orderedMessageIds))
```

`MerkleInclusionVerifier.verifyInclusion` receives trusted expected batch/root,
the message ID and position, the complete ordered ID list, and proof metadata.
It rebuilds the batch ID, rejects an empty or duplicate list, derives the count
from that list, and checks that its member at the position is the claimed ID.

The [MessageMerkle](src/MessageMerkle.sol) leaf and node domains are:

```text
MessageMerkleLeaf(bytes32 batchId,uint256 index,bytes32 messageId)
MessageMerkleNode(bytes32 leftChild,bytes32 rightChild)
```

Both hash the corresponding typed standard ABI preimage.
Left/right order is significant; children are never hash-sorted.
Every odd final node duplicates itself at that layer.
A one-member tree has its leaf as root and an empty proof; an empty tree is invalid.

Expected leaf count fixes depth and duplication rules.
It must be independently bound to the authenticated batch.
Adding `leafCount` to a proof does not make that count trustworthy.

The internal kernel provides boolean `verifyProof` and reverting `requireProof`.
The facade binds membership metadata before folding that shared kernel.
Duplicate checking sorts a scratch copy in O(N log N), preserving the committed
list; one proof fold costs O(log N).

These contracts operate on canonical IDs.
Full source provenance/finality validation remains off-chain, while the
destination message verifier checks the member's complete original fields.

## Message domain policy

`MessageDomainVerifier.verifyMessage(message, payload, expectedMessageId,
expectedDestinationGateway)` checks:

- supported message version `2`;
- current exact remote domain/Gateway trust;
- configured nonzero destination domain, different from the source;
- nonzero Gateway equal to the independently expected execution target;
- nonzero receiver;
- strict `block.timestamp < deadline`;
- payload hash and canonical message ID equal to the authenticated member.

The configured destination domain is explicit; deployment separately checks the
actual Chain B ID. The expected Gateway is not the verifier's own address.
DestinationGateway supplies its own address when composing verification.

This primitive does not require receiver bytecode, consume replay state, or call
a receiver. Its encoding helper is not an acceptance-policy bypass.

## Delivery transport

[DeliveryPackageCodec](src/libraries/DeliveryPackageCodec.sol) accepts the
existing flat standard ABI envelope:

```text
domain, version, deliveryJobId, messageBytes, batchBytes,
messageIndex, leafCount, messageRoot, siblings, certificate
```

The domain string is `CrossChainDeliveryPackage`; transport version is `1`.
The message contains full canonical fields, payload, and message ID.
The batch contains version, epoch, ID, and the full ordered message-ID list.

Nested and outer bytes must be canonical ABI, with no dirty padding,
noncanonical offsets, or trailing data.
DestinationGateway decodes one bounded coherent snapshot and uses the same
source/batch/root/member context across all verifiers.

Production submission is nonpayable `execute(bytes)`:

```text
function selector + standard bytes offset/length + unchanged inner envelope
```

The package digest covers the original inner envelope only.
`encodeDestinationSubmission` retains raw encoding;
`encodeGatewaySubmission` supplies the production wrapper.

Existing persisted raw-envelope intents are accepted by recovery only when
their bytes exactly match the independently re-derived historical encoding.
Their nonce and journal are retained. A historical EOA receipt does not become
evidence of production Gateway or ApplicationB execution.

[Delivery policy](../test-vectors/delivery-policy.json) is mirrored in
[DeliveryPolicy.sol](src/libraries/DeliveryPolicy.sol):

| Boundary | Maximum |
| --- | ---: |
| Message payload | 4096 bytes |
| Batch membership | 128 |
| Merkle depth | 7 |
| Delivery job identity | 192 bytes |
| Certificate | 1504 bytes |
| Inner package | 11232 bytes |
| Outer execute(bytes) calldata | 11300 bytes |

The raw bound follows the actual padded ABI:
`320 + 64 + 224 + 4544 + 4288 + 256 + 1536 = 11232`.
These limits do not enter canonical message, batch, Merkle, or QC hashes.

Source rejection occurs before nonce/event effects.
Explicit over-capacity batch assignment is atomic; collection leaves overflow
unassigned for later batches.
Off-chain preflight mirrors the limits, but on-chain checks remain authoritative.

## Atomic execution and replay

DestinationGateway has immutable code-bearing verifier dependencies and no
administrator execution bypass or Relayer allowlist.

Its execution order is QC, inclusion, full message/domain, receiver bytecode,
message-ID consumption, exact receiver callback, then execution event.
The only callback is
`ICrossChainReceiver.handleCrossChainMessage(messageId, payload)`, with zero ETH.

`isMessageExecuted(messageId)` reports replay state.
No public raw-consume, reset, pruning, replay window, or arbitrary-call API exists.
The key is the full canonical ID, not a nonce, sender, package hash, or transaction hash.

Consumption occurs before entering receiver code.
Same-ID reentry fails; a different independently authenticated message may execute.
There is no global reentrancy lock.

A receiver failure propagates and rolls back replay consumption, business state,
and success events. The same message can then be retried.
Successful canonical execution is once per ID in that Gateway's current chain state.

A destination reorganization can remove that successful state.
Off-chain canonical receipt reconciliation must observe that change; a PostgreSQL
flag or Relayer lease cannot override on-chain replay authority.

## Supplier application

ApplicationB binds one immutable nonzero Gateway address.
It does not require code at construction and has no Gateway setter.
Only that exact caller can invoke the nonpayable receiver entry;
`tx.origin` and identical code at another address confer no permission.

The only supported payload is exactly 96 bytes:

```solidity
abi.encode(uint8(1), uint8(1), supplier)
```

The words mean command version `1`, grant action `1`, and nonzero address.
Packed, wrapped, truncated, extended, or dirty-padding payloads fail.
The command namespace is separate from message version `2` and source action `3`.

The first grant sets only that supplier's boolean and emits
`VerifiedSupplierGranted(messageId, supplier)`.
A later grant for the same supplier fails even under a distinct valid message ID,
leaving that new message unconsumed when called through DestinationGateway.

The payload chooses the supplier explicitly.
No proof here establishes ownership of that address by the private subject.
There is no administrator grant, revocation, token transfer, enumerable directory,
second application replay map, or destination credential verifier.

## Development and verification

[foundry.toml](foundry.toml) owns source/test/library paths and build settings.
Foundry resolves forge-std from the installed `lib/` library tree.
Generated Groth16 sources and fixtures must match the current twelve-signal circuit.

The normal repository entry remains:

```bash
./scripts/verify.sh
```

For isolated contract diagnosis after artifact preparation, from `contracts/`:

```bash
forge build
forge test -vv
```

These narrower commands do not exercise the complete source-to-destination path.
No dependency installation, Foundry initialization, formatting gate, or separate
deployment command is required as a normal verification entry.

The Foundry suites cover message/intent field mutations, admission and policy,
nullifiers and deadlines, registry authority/history, certificate compatibility,
Merkle structure/count, domain/routing, replay/rollback/reentry, application payloads,
maximum bounds, and stateful/fuzz invariants.

Shared fixed artifacts live under [test-vectors](../test-vectors):
canonical messages, forwarding intents, nullifiers, validator sets, PBFT
certificates, Merkle vectors, application commands, delivery policy, and transport.
Normal verification reads and checks frozen vectors; it does not rewrite expected
bytes to match the implementation.

The maximum-size composed test checks the local 30,000,000 gas budget.
Production transport still uses real gas estimation and normal fee policy.
Bounds cannot guarantee that arbitrary receiver logic will succeed.

## Security boundaries

- Trusted source application admission does not authenticate issuer signatures.
- ZK source nullifier replay and destination message-ID replay protect different identities.
- QC, Merkle, domain, and replay primitives are independently useful but do not
  replace the composed production Gateway.
- Current remote-Gateway trust can reject a historical message without changing
  its original ID or certificate.
- Historical validator evidence uses exact registered authority, never a package-supplied committee.
- Development setup and synthetic credentials are not production security configuration.
- Test harnesses under [test/mocks](test/mocks) are verification fixtures,
  not production authorization shortcuts.

Related references: [ZK](../zk/README.md), [Indexer/transport](../indexer/README.md),
[Validators](../validator/README.md), and the [system trust model](../README.md#trust-model).
