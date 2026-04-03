# VRI Protocol v2.0

## Status

This document is the authoritative system-level specification for VRI Protocol v2.0.

`VRI-PROTOCOL-v1.0.md` remains in the repository as a legacy generation-focused specification, but it is superseded for new implementations by this document.

## 1. Purpose

VRI Protocol v2.0 defines a coherent provenance standard for audio artifacts across:

- cryptographic verification,
- studio and API deployment,
- timestamped evidence preservation,
- and verifier-facing trust semantics.

VRI does not prove legal ownership by itself. VRI provides technical provenance evidence that may be used as part of a broader evidentiary record.

## 2. Proof Types

Every Proof Package MUST declare `proof_type`.

Allowed values:

- `RECORDED`
- `GENERATED`

Semantics:

- `RECORDED` means the artifact originates from an asserted human recording or studio capture workflow.
- `GENERATED` means the artifact originates from an asserted synthesis workflow under a trusted VRI generation boundary.

`proof_type` is a signed field. Verifiers MUST reject a Proof Package if `proof_type` is absent, unsupported, or inconsistent with the signed message.

## 3. Compliance Levels

Every Proof Package MUST declare `compliance_level` as an integer in `[1,3]`.

### 3.1 Level 1: Local Cryptographic Proof

Level 1 provides:

- canonical audio hashing,
- deterministic metadata serialization,
- signed proof binding to the canonical artifact,
- and explicit `proof_type`.

Level 1 does not provide:

- signal-bound watermark claims,
- independent timestamp attestation,
- or ledger-backed ordering claims.

Level 1 anti-ambiguity rule:

- Level 1 proofs MUST NOT contain watermark fields, ledger inclusion fields, or timestamp-attestation fields.

Specifically, Level 1 proofs MUST NOT contain:

- `watermark_payload`
- `watermark_hex`
- `watermark_format_version`
- `usage_event_id`
- `ledger_anchor`
- `timestamp_attestation`
- `blockchain_anchor`

### 3.2 Level 2: Distribution-Bound Proof

Level 2 provides all Level 1 guarantees plus mode-specific distribution binding.

For `GENERATED` proofs, Level 2 additionally requires:

- watermark insertion before hashing and signing,
- watermark extraction support during verification,
- and successful recovery of a matching watermark from the presented audio.

For `RECORDED` proofs, Level 2 does not require watermarking.

If a `RECORDED` Level 2 proof includes watermark fields:

- the watermark claim becomes part of the proof,
- the verifier MUST validate it,
- and failure of the declared optional watermark claim MUST cause rejection.

If a `RECORDED` Level 2 proof does not include watermark fields:

- the verifier MUST treat watermark as `not_applicable`,
- and absence of watermark MUST NOT lower or raise trust by itself.

### 3.3 Level 3: Audited Time-Attested Proof

Level 3 provides all Level 2 guarantees plus:

- independent timestamp attestation,
- append-only event registration,
- Merkle inclusion or equivalent batch inclusion proof,
- and ordered evidence suitable for audit and dispute support.

Level 3 requires:

- `timestamp_attestation`
- `usage_event_id`
- `ledger_anchor`

Blockchain anchoring is OPTIONAL at Level 3.

If blockchain anchoring is claimed, it MUST be verifiable and MUST be reported separately from the core Level 3 result.

## 4. Canonical Audio

All hashing and signing operate on Canonical Audio.

For v2.0, Canonical Audio remains:

- linear PCM,
- signed integer samples,
- little-endian,
- 24-bit,
- 48000 Hz,
- mono or stereo only,
- container metadata excluded.

Any change to emitted audio after hash computation invalidates the proof unless the proof is recomputed over the transformed emitted artifact.

## 5. Signed Message Definition

The VRI v2.0 message digest is:

```text
message = SHA-256(
  context_prefix ||
  proof_type_code ||
  compliance_level ||
  watermark_flag ||
  watermark_payload_or_zero ||
  identity_flag ||
  identity_hash_or_zero ||
  audio_hash ||
  timestamp ||
  canonical_metadata
)
```

Serialization rules:

- `context_prefix`: UTF-8 `VRI-SIG-V2\0`
- `proof_type_code`: `0x01` for `RECORDED`, `0x02` for `GENERATED`
- `compliance_level`: one unsigned byte
- `watermark_flag`: `0x00` if no watermark claim is present, `0x01` otherwise
- `watermark_payload_or_zero`: declared 8-byte watermark payload, or 8 zero bytes if `watermark_flag = 0`
- `identity_flag`: `0x00` if no identity object is present, `0x01` otherwise
- `identity_hash_or_zero`: SHA-256 over the canonical `identity` object, or 32 zero bytes if `identity_flag = 0`
- `audio_hash`: 32 raw bytes of SHA-256 over Canonical Audio
- `timestamp`: unsigned 64-bit big-endian Unix time in seconds
- `canonical_metadata`: `metadata_length || canonical_metadata_bytes`

This construction prevents downgrade and field-confusion attacks between proof types and compliance levels.

## 6. Proof Package

Baseline fields:

```json
{
  "protocol_version": "2.0",
  "proof_type": "GENERATED",
  "compliance_level": 2,
  "audio_hash": "0x...",
  "signature": {
    "algorithm": "Ed25519",
    "value": "0x..."
  },
  "public_key": "0x...",
  "creator_id": "0x...",
  "timestamp": 1774992877,
  "metadata": {},
  "canonical_metadata": "{}",
  "identity": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "verifier_origin": "https://studio.vri.example",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "nonce": "base64(...)",
    "session_scope": ["recording"],
    "session_public_key": "0x...",
    "public_key": "0x...",
    "session_timestamp": 1774992800,
    "session_expires_at": 1774993100,
    "device_attested": true,
    "attestation": {},
    "signature": "0x..."
  }
}
```

Additional Level 2 `GENERATED` fields:

- `watermark_format_version`
- `watermark_payload`
- `watermark_hex`

Additional Level 3 fields:

- `timestamp_attestation`
- `usage_event_id`
- `ledger_anchor`

Optional fields:

- `verification_endpoint`
- `key_id`
- `extensions`
- `blockchain_anchor`

Identity rules:

- `identity` MUST be treated as a cryptographically protected protocol object, not advisory metadata.
- if `identity` is present, verifiers MUST validate it independently before accepting the proof as identity-bound.
- in strict identity profiles, `identity` MUST be present.

Anti-ambiguity rules:

- duplicate JSON member names MUST be rejected,
- conflicting critical aliases MUST be rejected,
- conflicting watermark encodings MUST be rejected,
- conflicting metadata encodings MUST be rejected.

## 7. Timestamping Model

### 7.1 Signed Timestamp

All levels MUST include a signed `timestamp` generated by the conforming signer or delegated signing service.

This timestamp alone is not independent time evidence.

### 7.2 Level 3 Independent Time Attestation

Level 3 MUST include independent timestamp attestation.

Required baseline:

- RFC 3161 TSA token over a digest that binds the Proof Package or Usage Event deterministically.

Recommended digest target:

- SHA-256 over the canonical proof receipt object containing `protocol_version`, `proof_type`, `compliance_level`, `audio_hash`, `public_key`, `creator_id`, `timestamp`, and `usage_event_id`.

`timestamp_attestation` MUST include enough material for an offline verifier to:

- identify the TSA,
- verify the TSA signature,
- verify the attested digest,
- and confirm that the TSA time is consistent with the proof timestamp.

### 7.3 Ledger and Blockchain

Level 3 MUST include append-only ledger registration and batch inclusion.

The ledger MUST provide:

- append-only event semantics,
- deterministic content hashing,
- event ordering,
- and inclusion proof against a batch root.

Blockchain anchoring is OPTIONAL.

If used, blockchain anchoring:

- MUST be linked to a ledger batch root or equivalent commitment,
- MUST NOT replace the TSA requirement,
- and MUST be reported as an additional corroborating anchor rather than the sole timestamp authority.

### 7.4 Replay and Re-Anchoring

Re-anchoring is allowed only as an additive availability measure.

It MUST NOT:

- replace the original TSA record,
- mutate the original signed proof,
- or create ambiguity about first attested time.

Verifiers MUST prefer the earliest valid independent attestation chain.

## 8. Identity and Key Lifecycle

### 8.1 Key Roles

VRI defines three key roles:

- root identity key,
- delegated device key,
- delegated session key.

The root identity key anchors the creator or organization identity record.

Device and session keys MAY sign proofs only when authorized by an explicit delegation object.

### 8.2 Delegation

A delegation object MUST bind:

- delegator key id,
- delegate public key,
- scope,
- allowed `proof_type`,
- allowed `compliance_level` range,
- issuance time,
- expiration time,
- and a unique delegation identifier.

The delegation object MUST be signed by the delegator key.

### 8.3 Mobile and Secure Enclave Signing

If mobile signing is used:

- the long-lived device private key MUST remain inside platform secure hardware when available,
- the public key and attestation certificate chain SHOULD be exportable,
- and signing APIs MUST expose only signing operations, not raw private-key material.
- password or recovery-code fallbacks MUST NOT replace the cryptographic device-signing step for session authorization.

### 8.4 QR Login and Session Binding

QR bootstrapping MAY be used to authorize a session signer.

The QR bootstrap flow is:

1. The verifier creates a challenge containing:
   - `verifier_origin`
   - `session_id`
   - `nonce`
   - `session_scope`
   - `session_expires_at`
   - `session_public_key`
2. The verifier encodes the challenge into the QR payload.
3. The mobile authenticator MUST verify `verifier_origin` against a trusted relying-party binding before signing anything.
4. The mobile device signs the canonical unsigned identity assertion with the Secure Enclave-backed private key.
5. The response returns the full `identity` object including the device public key and signature.
6. The verifier MUST:
   - verify the identity signature,
   - verify nonce freshness,
   - verify `session_id` uniqueness,
   - verify expiry,
   - verify that the returned `session_public_key` matches the challenge,
   - and persist the authorized session state.

Failure at any step MUST terminate the authorization attempt.

If used, the authorization MUST bind:

- the session public key,
- verifier-visible scope,
- nonce or challenge,
- expiration,
- and relying party identifier.

Replayable or bearer-only QR session transfer is non-compliant.

Authorized session usage is normative:

- a session MUST be valid only for the declared `session_scope`,
- a verifier MUST reject any attempt to use a session outside that scope,
- a session used to authorize proof issuance MUST be single-use,
- and a verifier operating online MUST transition the session into a terminal consumed state after the first successful authorized issuance.

### 8.5 Identity Semantics

The identity layer asserts control of a key, device, and authorized session.

It does not, by itself, establish:

- legal personhood,
- civil identity,
- employment authority,
- or contractual authority.

Identity means key holder unless an external identity registry or attested account system binds that key to a legal or human identity.

### 8.6 Revocation and Historical Validity

Revocation MUST NOT retroactively invalidate a historically valid proof if all of the following hold:

- the signature verifies,
- the key was active and non-revoked at the attested signing time,
- and the independent timestamp attestation predates the revocation effective time.

Verifiers SHOULD produce two outputs when revocation exists:

- historical validity at attested time,
- current key status at verification time.

If no independent attested signing time is available, a verifier MUST NOT overclaim historical validity and SHOULD report it as indeterminate.

## 9. Verification Rules

Verifiers MUST fail closed.

Required checks:

1. parse and validate `protocol_version`
2. parse and validate `proof_type`
3. parse and validate `compliance_level`
4. if `identity` is present or required, verify the identity object independently
5. canonicalize the presented audio
6. recompute `audio_hash`
7. reconstruct `canonical_metadata`
8. derive `creator_id` from `public_key`
9. reconstruct the exact v2.0 message digest, including the bound `identity` hash when present
10. verify the Ed25519 signature
11. apply proof-type and compliance-specific checks
12. verify timestamp and ledger evidence when required

Identity-specific rules:

- verifiers MUST NOT trust client-supplied identity fields without signature validation,
- verifiers MUST reject identity objects with expired sessions,
- verifiers MUST reject identity objects whose `verifier_origin` is not trusted,
- verifiers MUST reject identity objects whose `session_id`, `nonce`, or `session_public_key` mismatch the expected challenge when verifying an online authorization flow,
- and verifiers in strict identity profiles MUST reject proofs with no identity object.

Mode-specific rules:

- `GENERATED` with `compliance_level >= 2` MUST have a present and matching watermark.
- `RECORDED` MAY omit watermark at any level.
- `RECORDED` watermark presence MUST NOT increase trust beyond what the compliance level already permits.
- `RECORDED` watermark mismatch, if a watermark claim was declared, MUST fail verification.

Level-specific rules:

- valid Level 1 yields `PARTIAL`
- valid Level 2 yields `HIGH`
- valid Level 3 yields `HIGH`
- any failed required check yields `LOW`

`PARTIAL` MUST NOT be returned for valid `GENERATED` proofs with `compliance_level >= 2`.

## 10. Trust Output

Allowed `trust_level` values:

- `LOW`
- `PARTIAL`
- `HIGH`

Deterministic mapping:

- `LOW`: any required cryptographic, watermark, attestation, or ledger check fails
- `PARTIAL`: proof is cryptographically valid and satisfies Level 1 only
- `HIGH`: proof is cryptographically valid and satisfies every required check for its declared Level 2 or Level 3 profile

## 11. Studio Workflow Model

### 11.1 Session Capture

Studio systems MAY hash audio incrementally during capture for crash recovery and audit logging.

Chunk hashes are operational state, not final provenance proofs.

### 11.2 Chunking

If chunking is used:

- chunk order MUST be deterministic,
- chunk boundaries MUST be recorded,
- chunk hashes SHOULD be chained or Merkleized,
- and the chunk journal MUST bind to a session identifier.

### 11.3 Crash Recovery

Crash recovery MAY resume from:

- session manifest,
- chunk journal,
- checkpoint hash chain,
- and unfinalized audio cache.

Checkpoint signatures are non-final.

After recovery, the final proof MUST be recomputed over the final canonical export.

### 11.4 Editing and Re-Export

Any edit that changes the final PCM semantics invalidates the prior final proof.

This includes:

- trimming,
- time-stretching,
- gain changes,
- EQ or restoration,
- stem rebalance,
- and format transformations that alter canonical output.

A re-exported artifact MUST receive a new proof.

An export-time proof MUST include signed lineage metadata sufficient to bind the exported artifact to its immediate parent artifact.

At minimum, export lineage metadata MUST identify:

- the parent artifact hash,
- the parent proof type,
- and a parent event or proof reference from the local evidentiary chain.

If the verifier has access to the referenced evidentiary chain online, it MUST verify that the referenced parent record exists and that the declared parent hash and proof type match that record exactly.

### 11.5 Stems

If stems are exported:

- each stem MUST be treated as a distinct artifact if separately distributed,
- and each distributed stem MUST carry its own proof or be bound through a signed manifest that is itself independently verifiable.

## 12. Failure Semantics

No silent degradation is allowed.

If watermarking, signing, or required attestation fails:

- the artifact MUST NOT be emitted as a compliant proof-carrying artifact,
- and the system MUST either fail the request or return an explicitly incomplete state.

Audio without a complete proof MAY be retained internally for later completion, but it is non-compliant until a full proof is generated.

## 13. Security and Legal Scope

VRI v2.0 provides:

- signed artifact provenance,
- proof-type separation,
- deterministic trust semantics,
- and stronger evidentiary posture through independent time attestation and append-only records.

VRI v2.0 does not by itself provide:

- legal ownership,
- copyright entitlement,
- consent,
- admissibility guarantees in every jurisdiction,
- or immunity against analog-hole copying, re-recording, or model-based re-synthesis.

Those limits MUST be disclosed in product, legal, and audit-facing materials.
