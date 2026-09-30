# Credential Model

This directory defines a framework-neutral, user-held credential model. It
contains data definitions and synthetic fixtures only. No credential is stored
in Solidity public state.

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

All credential fields are private by default and remain with the user. A future
proof policy may reveal only the minimum information required by that policy.
This model does not define a public-input layout and does not place credential
data in public chain state.

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

`credentialCommitment` denotes a deterministic cryptographic reference to the
credential without revealing its fields. Its canonical preimage is version 1
of this ordered, typed sequence:

```text
subject      : utf8-string
issuer       : utf8-string
role         : utf8-string
expiry       : uint64-unix-seconds
credentialId : utf8-string
```

`status` is external lifecycle state, so changing ACTIVE to REVOKED preserves
the commitment preimage. Issuer trust is also external policy state.

No hash primitive, field mapping, byte serialization, or output representation
has been selected. Those choices must be made together with the proof system;
the current files do not claim to provide a cryptographic commitment value.

## Revocation state

The lifecycle representation has two states:

- `ACTIVE`
- `REVOKED`

This representation allows fixtures to describe credential state. It does not
enforce revocation and does not define a registry, tree, root, or proof.

## Fixtures

The fixtures are synthetic and contain no real identity or secret material:

- `valid.json`: active, unexpired, expected role, trusted issuer.
- `expired.json`: differs from valid only in `expiry`.
- `wrong-role.json`: differs from valid only in `role`.
- `untrusted-issuer.json`: differs from valid only in `issuer`.
- `revoked.json`: differs from valid only in `status`.

`manifest.json` supplies a fixed evaluation time and expected result for each
fixture, keeping validation deterministic.

## Validation

`validate.py` uses only the Python standard library. It checks the schema,
canonical names and types, issuer trust fixtures, expiry semantics, role and
revocation cases, targeted fixture differences, and deterministic commitment
preimage construction.

## Deferred work

The following capabilities are intentionally absent:

- ZK circuits, witnesses, proof generation, and proof verification
- selection of a ZK-friendly hash or commitment output encoding
- on-chain verifier and trusted issuer registry
- revocation enforcement, revocation trees, and revocation roots
- identity application behavior
- nullifiers and anonymous replay protection
- SourceGateway authorization integration
