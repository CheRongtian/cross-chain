# Credential Model

This directory defines the canonical user-held credential model used by the
authorization circuit. It contains data definitions and synthetic fixtures.
No credential is stored in Solidity public state.

## Credential fields

| Field | Type | Meaning |
| --- | --- | --- |
| `subject` | UTF-8 string | Identifier of the credential owner. |
| `issuer` | UTF-8 string | Identifier of the credential issuer. |
| `role` | uppercase UTF-8 token | Business role asserted by the issuer. |
| `expiry` | unsigned integer | Expiry as a Unix timestamp in seconds. |
| `credentialId` | UTF-8 string | Unique identifier assigned to the credential. |

The canonical spelling is `credentialId` in every data file. A credential is
valid with respect to time only while `evaluationTime < expiry`.

## Privacy boundary

All credential fields are private by default and remain with the user. The
authorization proof publishes only `credentialCommitment`, `trustedIssuer`,
`requiredRole`, `currentTimestamp`, and `credentialStateRoot`. Credential
fields and Merkle paths are not placed in public chain state. The identity
application stores authorization under the public credential commitment and
does not expose the private subject.

## Trusted issuers

Issuer trust is external policy state keyed by the credential's `issuer`
identifier. `trusted-issuers.json` contains one trusted and one untrusted
synthetic issuer. The trust boolean is not part of the credential and does not
participate in its commitment preimage.

## Credential schema

`credential.schema.json` is the language-neutral schema. It requires the five
canonical credential fields plus the lifecycle `status`. Unknown fields are
rejected. Roles use uppercase tokens; `VERIFIED_SUPPLIER` is the example role
required by the fixture policy.

## Credential commitment boundary

`credentialCommitment` is a Poseidon commitment over the BN254 scalar field.
Its canonical preimage is version 1 of this ordered field-element sequence:

```text
preimageVersion  : constant 1
subjectField     : encoded subject
issuerField      : encoded issuer
roleField        : encoded role
expiry           : uint64 Unix seconds
credentialIdField: encoded credentialId
```

`status` is external lifecycle state, so changing ACTIVE to REVOKED preserves
the commitment preimage. Issuer trust is also external policy state.

String fields use domain-separated SHA-256, big-endian digest conversion, and
reduction modulo the BN254 scalar field. Roles use the explicit integer mapping
in [`../encoding.json`](../encoding.json). The Poseidon output is represented as
an unsigned decimal BN254 field element.

## Revocation state

The lifecycle representation has two states:

- `ACTIVE`
- `REVOKED`

Revocation is represented by absence from the active-credential set. The
deterministic tree definition lives in [`../credential-state.json`](../credential-state.json):

- fixed depth `8` and capacity `256`;
- active leaf `Poseidon(1, credentialCommitment)`;
- internal node `Poseidon(left, right)`;
- zero empty leaves with recursively hashed empty subtrees;
- active commitments sorted numerically and placed from the leftmost leaf.

The circuit proves a private membership path against the public current root.
Changing a fixture from `ACTIVE` to `REVOKED` preserves its credential
commitment and removes it from the next active-state root.

## Fixtures

The fixtures are synthetic and contain no real identity or secret material:

- `valid.json`: active, unexpired, expected role, trusted issuer.
- `active-secondary.json`: a different active supplier that remains present
  after the first credential is revoked.
- `expired.json`: differs from valid only in `expiry`.
- `wrong-role.json`: differs from valid only in `role`.
- `untrusted-issuer.json`: differs from valid only in `issuer`.
- `revoked.json`: differs from valid only in `status`.

`manifest.json` supplies a fixed evaluation time and expected result for each
fixture, keeping validation deterministic.

## Validation

`validate.py` uses only the Python standard library. It checks the schema,
canonical names and types, issuer trust fixtures, expiry semantics, role and
revocation cases, targeted fixture differences, commitment encoding, and the
active credential-state tree configuration.

## Deferred work

The following capabilities are intentionally absent:

- trusted issuer registry
- automatic expiry of stored authorization
- decentralized credential-state root publication or governance
- nullifiers and anonymous replay protection
- SourceGateway authorization integration
