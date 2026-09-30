#!/usr/bin/env python3

import json
import re
import sys
from pathlib import Path
from typing import Any


MODEL_ROOT = Path(__file__).resolve().parent
FIXTURES_ROOT = MODEL_ROOT / "fixtures"
ENCODING_PATH = MODEL_ROOT.parent / "encoding.json"
CREDENTIAL_STATE_PATH = MODEL_ROOT.parent / "credential-state.json"
NULLIFIER_PATH = MODEL_ROOT.parent / "nullifier.json"
NULLIFIER_VECTORS_PATH = MODEL_ROOT.parent.parent / "test-vectors" / "nullifiers.json"

CANONICAL_FIELDS = ["subject", "issuer", "role", "expiry", "credentialId"]
LIFECYCLE_FIELD = "status"
BN254_SCALAR_FIELD = "21888242871839275222246405745257275088548364400416034343698204186575808495617"
COMMITMENT_INPUTS = [
    "preimageVersion",
    "subjectField",
    "issuerField",
    "roleField",
    "expiry",
    "credentialIdField",
]
STRING_DOMAINS = {
    "subject": "cross-chain:credential:subject:v1",
    "issuer": "cross-chain:credential:issuer:v1",
    "credentialId": "cross-chain:credential:id:v1",
}
EXPECTED_CASES = {
    "valid": set(),
    "active-secondary": {"subject", "credentialId"},
    "expired": {"expiry"},
    "wrong-role": {"role"},
    "untrusted-issuer": {"issuer"},
    "revoked": {"status"},
}


class ValidationError(Exception):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValidationError(message)


def load_json(path: Path) -> Any:
    try:
        with path.open("r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, json.JSONDecodeError) as error:
        raise ValidationError(f"cannot load {path}: {error}") from error


def validate_schema(schema: dict[str, Any]) -> None:
    expected_fields = CANONICAL_FIELDS + [LIFECYCLE_FIELD]

    require(schema.get("type") == "object", "credential schema must describe an object")
    require(schema.get("additionalProperties") is False, "credential schema must reject unknown fields")
    require(schema.get("required") == expected_fields, "credential schema required fields are not canonical")

    properties = schema.get("properties")
    require(isinstance(properties, dict), "credential schema properties must be an object")
    require(list(properties) == expected_fields, "credential schema property order is not canonical")

    for field in ("subject", "issuer", "role", "credentialId", "status"):
        require(properties[field].get("type") == "string", f"{field} must be a string in the schema")

    require(properties["expiry"].get("type") == "integer", "expiry must be an integer in the schema")
    require(properties["expiry"].get("minimum") == 0, "expiry must reject negative timestamps")
    require(properties["status"].get("enum") == ["ACTIVE", "REVOKED"], "status states are not canonical")


def validate_model(model: dict[str, Any]) -> list[dict[str, str]]:
    require(model.get("modelVersion") == 1, "unsupported credential model version")

    canonical_fields = model.get("canonicalCredentialFields")
    require(isinstance(canonical_fields, list), "canonicalCredentialFields must be an array")
    require(
        [field.get("name") for field in canonical_fields] == CANONICAL_FIELDS,
        "credential model field names or order are not canonical",
    )

    privacy = model.get("privacy", {})
    require(privacy.get("default") == "private", "credential privacy default must be private")
    require(privacy.get("userHeld") is True, "credential must be marked as user-held")
    require(privacy.get("privateByDefault") == CANONICAL_FIELDS, "private credential fields are incomplete")

    expiry = model.get("expiry", {})
    require(expiry.get("representation") == "unix-seconds", "expiry representation must be Unix seconds")

    revocation = model.get("revocation", {})
    require(revocation.get("field") == LIFECYCLE_FIELD, "revocation field must be status")
    require(revocation.get("states") == ["ACTIVE", "REVOKED"], "revocation states are not canonical")
    require(revocation.get("enforcementImplemented") is True, "revocation enforcement must be enabled")
    require(
        revocation.get("mechanism") == "active-credential-state-membership",
        "revocation must use active credential state membership",
    )
    require(
        revocation.get("stateEncodingSpecification") == "../credential-state.json",
        "credential state encoding path is not canonical",
    )

    nullifier = model.get("nullifier", {})
    require(nullifier.get("privateIdentityField") == "credentialId", "nullifier must use private credentialId")
    require(nullifier.get("publicOutput") == "nullifier", "nullifier public output name is not canonical")
    require(
        nullifier.get("encodingSpecification") == "../nullifier.json",
        "nullifier encoding path is not canonical",
    )

    issuer_trust = model.get("issuerTrust", {})
    require(issuer_trust.get("identifierField") == "issuer", "issuer trust must use the issuer identifier")
    require(issuer_trust.get("includedInCredential") is False, "issuer trust state must remain external")

    commitment = model.get("credentialCommitment", {})
    commitment_fields = commitment.get("fields")
    require(commitment.get("canonicalName") == "credentialCommitment", "commitment name is not canonical")
    require(commitment.get("preimageVersion") == 1, "unsupported commitment preimage version")
    require(
        commitment.get("preimageKind") == "ordered-typed-field-sequence",
        "commitment preimage must be an ordered typed field sequence",
    )
    require(commitment_fields == canonical_fields, "commitment must bind every canonical credential field")
    require(LIFECYCLE_FIELD in commitment.get("excludedFields", []), "status must be excluded from commitment")
    require("issuerTrusted" in commitment.get("excludedFields", []), "issuer trust must be excluded from commitment")
    require(commitment.get("hashPrimitive") == "Poseidon(6)-BN254", "commitment must use Poseidon(6) over BN254")
    require(commitment.get("hashInputs") == COMMITMENT_INPUTS, "commitment hash input order is not canonical")
    require(commitment.get("encodingSpecification") == "../encoding.json", "encoding specification path is not canonical")
    require(
        commitment.get("outputRepresentation") == "unsigned decimal BN254 field element",
        "commitment output representation is not canonical",
    )
    require(commitment.get("cryptographicSelectionDeferred") is False, "cryptographic selection must be fixed")

    return commitment_fields


def validate_encoding(encoding: dict[str, Any]) -> None:
    require(encoding.get("encodingVersion") == 1, "unsupported field encoding version")

    scalar_field = encoding.get("scalarField", {})
    require(scalar_field.get("curve") == "BN254", "field encoding must target BN254")
    require(scalar_field.get("prime") == BN254_SCALAR_FIELD, "BN254 scalar field prime is incorrect")
    require(
        scalar_field.get("integerRepresentation") == "unsigned decimal string",
        "field elements must use unsigned decimal strings",
    )

    string_encoding = encoding.get("stringEncoding", {})
    require(
        string_encoding.get("algorithm") == "sha256-domain-separated-mod-p",
        "string field encoding algorithm is not canonical",
    )
    require(string_encoding.get("byteEncoding") == "utf-8", "string field encoding must use UTF-8")
    require(string_encoding.get("separatorByteHex") == "00", "string domain separator byte is not canonical")
    require(string_encoding.get("digestIntegerEndianness") == "big", "SHA-256 digest must use big-endian conversion")
    require(string_encoding.get("reduction") == "mod-p", "string digest must be reduced modulo the scalar field")
    require(string_encoding.get("domains") == STRING_DOMAINS, "string field domains are not canonical")

    role_encoding = encoding.get("roleEncoding", {})
    require(
        role_encoding.get("representation") == "explicit-positive-integer",
        "role encoding representation is not canonical",
    )
    require(
        role_encoding.get("values") == {"VERIFIED_SUPPLIER": 1, "AUDITOR": 2},
        "role encoding table is not canonical",
    )

    expiry_encoding = encoding.get("expiryEncoding", {})
    require(expiry_encoding.get("source") == "uint64-unix-seconds", "expiry source encoding is not canonical")
    require(expiry_encoding.get("fieldValue") == "identity", "expiry must map directly into the scalar field")

    commitment = encoding.get("commitment", {})
    require(commitment.get("algorithm") == "Poseidon", "commitment encoding must use Poseidon")
    require(commitment.get("arity") == 6, "commitment Poseidon arity must be six")
    require(commitment.get("preimageVersion") == 1, "commitment preimage version is not canonical")
    require(commitment.get("inputOrder") == COMMITMENT_INPUTS, "encoded commitment input order is not canonical")
    require(
        commitment.get("outputRepresentation") == "unsigned decimal BN254 field element",
        "encoded commitment output representation is not canonical",
    )


def validate_credential_state(state: dict[str, Any]) -> None:
    require(state.get("stateVersion") == 1, "unsupported credential state version")
    require(state.get("treeDepth") == 8, "credential state tree depth must be eight")
    require(state.get("capacity") == 256, "credential state capacity must be 256")

    leaf = state.get("leafEncoding", {})
    require(leaf.get("algorithm") == "Poseidon", "active leaf must use Poseidon")
    require(leaf.get("arity") == 2, "active leaf Poseidon arity must be two")
    require(leaf.get("stateLeafVersion") == 1, "active leaf version must be one")
    require(
        leaf.get("inputOrder") == ["stateLeafVersion", "credentialCommitment"],
        "active leaf input order is not canonical",
    )

    internal_node = state.get("internalNodeEncoding", {})
    require(internal_node.get("algorithm") == "Poseidon", "internal nodes must use Poseidon")
    require(internal_node.get("arity") == 2, "internal node Poseidon arity must be two")
    require(internal_node.get("inputOrder") == ["left", "right"], "internal node order is not canonical")

    require(state.get("emptyLeaf") == "0", "empty credential state leaf must be zero")
    require(
        state.get("emptySubtreeDerivation") == "recursively hash each pair as Poseidon(left, right)",
        "empty subtree derivation is not canonical",
    )

    placement = state.get("leafPlacement", {})
    require(
        placement.get("ordering") == "ascending-numeric-credential-commitment",
        "active commitments must use canonical numeric ordering",
    )
    require(placement.get("startIndex") == 0, "active credential leaves must start at index zero")
    require(placement.get("padding") == "right-pad-with-empty-leaf", "credential state padding is not canonical")
    require(
        state.get("rootRepresentation") == "unsigned decimal BN254 field element",
        "credential state root representation is not canonical",
    )


def validate_nullifier(nullifier: dict[str, Any]) -> None:
    require(nullifier.get("nullifierVersion") == 1, "unsupported nullifier version")
    require(nullifier.get("algorithm") == "Poseidon", "nullifier must use Poseidon")
    require(nullifier.get("arity") == 5, "nullifier Poseidon arity must be five")
    require(
        nullifier.get("inputOrder")
        == [
            "nullifierVersion",
            "credentialIdField",
            "applicationDomain",
            "policyEpoch",
            "actionContext",
        ],
        "nullifier input order is not canonical",
    )
    require(
        nullifier.get("privateIdentitySource") == "credentialIdField",
        "nullifier private identity source is not canonical",
    )
    require(
        nullifier.get("outputRepresentation") == "unsigned decimal BN254 field element",
        "nullifier output representation is not canonical",
    )

    application_domain = nullifier.get("applicationDomain", {})
    require(
        application_domain.get("algorithm") == "keccak256-abi-encode-mod-p",
        "application domain algorithm is not canonical",
    )
    require(
        application_domain.get("protocolNamespace") == "cross-chain:identity-application-domain:v1",
        "application domain namespace is not canonical",
    )
    require(
        application_domain.get("inputOrder")
        == ["protocolNamespaceHash", "chainId", "applicationAddress"],
        "application domain input order is not canonical",
    )
    require(
        application_domain.get("abiTypes") == ["bytes32", "uint256", "address"],
        "application domain ABI types are not canonical",
    )
    require(
        application_domain.get("fieldReduction") == "mod-bn254-scalar-field",
        "application domain reduction is not canonical",
    )

    policy_epoch = nullifier.get("policyEpoch", {})
    require(policy_epoch.get("initialValue") == 1, "initial policy epoch must be one")
    require(policy_epoch.get("advancement") == "increment-by-one", "policy epoch advancement is not canonical")
    require(
        nullifier.get("actionContexts") == {"VERIFY_SUPPLIER": 1, "OTHER_TEST_ACTION": 2},
        "nullifier action contexts are not canonical",
    )


def validate_nullifier_vectors(vectors: dict[str, Any]) -> None:
    require(vectors.get("vectorVersion") == 1, "unsupported nullifier vector version")
    cases = vectors.get("cases")
    require(isinstance(cases, list) and len(cases) == 5, "nullifier vectors must contain five cases")
    names = [case.get("name") for case in cases]
    require(
        names
        == ["baseline", "same-context", "different-application", "different-epoch", "different-action"],
        "nullifier vector case order is not canonical",
    )
    for case in cases:
        require(type(case.get("credentialIdField")) is str, "nullifier vector credentialIdField must be a string")
        require(type(case.get("applicationDomain")) is str, "nullifier vector applicationDomain must be a string")
        require(type(case.get("policyEpoch")) is str, "nullifier vector policyEpoch must be a string")
        require(
            case.get("actionContext") in {"VERIFY_SUPPLIER", "OTHER_TEST_ACTION"},
            "nullifier vector action context is unsupported",
        )
        require(
            case.get("expectedNullifier") == "generated-by-zk/scripts/build-nullifier-vectors.mjs",
            "nullifier vectors must delegate concrete Poseidon output generation",
        )

    require(
        vectors.get("expectedRelations")
        == {
            "equal": [["baseline", "same-context"]],
            "different": [
                ["baseline", "different-application"],
                ["baseline", "different-epoch"],
                ["baseline", "different-action"],
            ],
        },
        "nullifier vector relations are not canonical",
    )


def validate_credential(credential: dict[str, Any], schema: dict[str, Any], fixture_name: str) -> None:
    required_fields = schema["required"]
    require(isinstance(credential, dict), f"{fixture_name} must contain a JSON object")
    require(list(credential) == required_fields, f"{fixture_name} fields or field order are not canonical")

    properties = schema["properties"]

    for field in ("subject", "issuer", "role", "credentialId", "status"):
        value = credential[field]
        require(type(value) is str, f"{fixture_name}.{field} must be a string")
        require(len(value) >= properties[field].get("minLength", 0), f"{fixture_name}.{field} is empty")

        pattern = properties[field].get("pattern")
        if pattern is not None:
            require(re.fullmatch(pattern, value) is not None, f"{fixture_name}.{field} has invalid format")

        allowed_values = properties[field].get("enum")
        if allowed_values is not None:
            require(value in allowed_values, f"{fixture_name}.{field} has an unsupported value")

    expiry = credential["expiry"]
    require(type(expiry) is int, f"{fixture_name}.expiry must be an integer")
    require(0 <= expiry <= (2**64 - 1), f"{fixture_name}.expiry must fit uint64 Unix seconds")


def load_issuer_trust(document: dict[str, Any]) -> dict[str, bool]:
    issuers = document.get("issuers")
    require(isinstance(issuers, list), "trusted issuer document must contain an issuers array")

    trust_by_issuer: dict[str, bool] = {}

    for index, entry in enumerate(issuers):
        require(isinstance(entry, dict), f"issuer entry {index} must be an object")
        require(set(entry) == {"issuer", "trusted"}, f"issuer entry {index} has unexpected fields")
        require(type(entry["issuer"]) is str and entry["issuer"], f"issuer entry {index} has no identifier")
        require(type(entry["trusted"]) is bool, f"issuer entry {index} trusted state must be boolean")
        require(entry["issuer"] not in trust_by_issuer, f"duplicate issuer identifier {entry['issuer']}")
        trust_by_issuer[entry["issuer"]] = entry["trusted"]

    require(any(trust_by_issuer.values()), "trusted issuer fixture is missing")
    require(any(not state for state in trust_by_issuer.values()), "untrusted issuer fixture is missing")

    return trust_by_issuer


def build_commitment_preimage(
    credential: dict[str, Any], commitment_fields: list[dict[str, str]]
) -> tuple[tuple[str, Any], ...]:
    return tuple((field["type"], credential[field["name"]]) for field in commitment_fields)


def validate_fixtures(
    schema: dict[str, Any],
    manifest: dict[str, Any],
    trust_by_issuer: dict[str, bool],
    commitment_fields: list[dict[str, str]],
) -> None:
    evaluation_time = manifest.get("evaluationTime")
    required_role = manifest.get("requiredRole")
    cases = manifest.get("cases")

    require(type(evaluation_time) is int and evaluation_time >= 0, "fixture evaluationTime must be Unix seconds")
    require(type(required_role) is str and required_role, "fixture requiredRole must be a non-empty string")
    require(isinstance(cases, dict), "fixture manifest cases must be an object")
    require(set(cases) == set(EXPECTED_CASES), "fixture manifest does not contain the required cases")

    credentials: dict[str, dict[str, Any]] = {}

    for name, case in cases.items():
        require(isinstance(case, dict), f"fixture case {name} must be an object")
        fixture_file = case.get("file")
        expected = case.get("expected")
        require(type(fixture_file) is str and fixture_file, f"fixture case {name} has no file")
        require(isinstance(expected, dict), f"fixture case {name} has no expected results")

        credential = load_json(FIXTURES_ROOT / fixture_file)
        validate_credential(credential, schema, name)

        require(credential["issuer"] in trust_by_issuer, f"{name} references an unknown issuer")

        actual = {
            "expired": evaluation_time >= credential["expiry"],
            "trustedIssuer": trust_by_issuer[credential["issuer"]],
            "roleMatches": credential["role"] == required_role,
            "revoked": credential["status"] == "REVOKED",
        }
        require(actual == expected, f"{name} expected results do not match its credential data")

        first_preimage = build_commitment_preimage(credential, commitment_fields)
        second_preimage = build_commitment_preimage(credential, commitment_fields)
        require(first_preimage == second_preimage, f"{name} commitment preimage is not deterministic")

        credentials[name] = credential
        print(f"Validated fixture: {name}")

    baseline = credentials["valid"]

    for name, expected_differences in EXPECTED_CASES.items():
        if name == "valid":
            continue

        actual_differences = {
            field for field in baseline if baseline[field] != credentials[name][field]
        }
        require(
            actual_differences == expected_differences,
            f"{name} must differ from valid only in {sorted(expected_differences)}",
        )

    valid_preimage = build_commitment_preimage(credentials["valid"], commitment_fields)
    revoked_preimage = build_commitment_preimage(credentials["revoked"], commitment_fields)
    require(valid_preimage == revoked_preimage, "lifecycle status must not change the credential commitment preimage")

    for name in ("expired", "wrong-role", "untrusted-issuer"):
        require(
            build_commitment_preimage(credentials[name], commitment_fields) != valid_preimage,
            f"{name} must change the credential commitment preimage",
        )


def main() -> int:
    try:
        schema = load_json(MODEL_ROOT / "credential.schema.json")
        model = load_json(MODEL_ROOT / "credential-model.json")
        encoding = load_json(ENCODING_PATH)
        credential_state = load_json(CREDENTIAL_STATE_PATH)
        nullifier = load_json(NULLIFIER_PATH)
        nullifier_vectors = load_json(NULLIFIER_VECTORS_PATH)
        issuer_document = load_json(MODEL_ROOT / "trusted-issuers.json")
        manifest = load_json(FIXTURES_ROOT / "manifest.json")

        validate_schema(schema)
        commitment_fields = validate_model(model)
        validate_encoding(encoding)
        validate_credential_state(credential_state)
        validate_nullifier(nullifier)
        validate_nullifier_vectors(nullifier_vectors)
        trust_by_issuer = load_issuer_trust(issuer_document)
        validate_fixtures(schema, manifest, trust_by_issuer, commitment_fields)
    except ValidationError as error:
        print(f"Credential model validation failed: {error}", file=sys.stderr)
        return 1

    print("Credential model validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
