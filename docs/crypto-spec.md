# Cryptographic Specification Companion

## Status

This document is non-normative. `VRI-PROTOCOL-v2.0.md` is authoritative. This file summarizes the protocol-defined cryptographic behavior in a companion format for implementers.

---

## Signature Algorithm

VRI Protocol v2.0 uses Ed25519.

- Signature algorithm: `Ed25519`
- Public key length: 32 bytes
- Signature length: 64 bytes
- Hash function for `audio_hash`: SHA-256
- Hash function for the protocol message digest: SHA-256

No alternative signature algorithm and no alternative hash function are allowed in v2.0.

---

## Identity Binding

The public key is the authoritative identity anchor.

- `creator_id` is derived from the public key.
- `creator_id` is the first 4 bytes of `SHA-256(public_key_bytes)`.
- `creator_id` is a compact lookup hint, not a standalone trust root.

Trust is anchored in key ownership, not in identifiers.

When a proof includes an `identity` object, a SHA-256 hash over the canonical identity string is additionally bound into the message digest (see Signature Message below). This prevents an attacker from substituting a different identity object after the proof is signed.

---

## Canonical Audio and `audio_hash`

All hashing and signing operate on Canonical Audio as defined by the protocol.

For v2.0:

- encoding: linear PCM,
- bit depth: 24-bit signed integer,
- sample rate: 48000 Hz,
- channels: mono or stereo,
- endianness: little-endian,
- container metadata: excluded.

`audio_hash` is:

```text
audio_hash = SHA-256(canonical_audio_bytes)
```

Any transformation that changes canonical PCM semantics invalidates the prior hash. A re-exported artifact requires a new proof.

---

## Canonical Metadata

`canonical_metadata` is the UTF-8 encoding of canonical JSON for the metadata object.

The protocol requires:

- object keys sorted lexicographically by Unicode code point,
- arrays preserving order,
- no duplicate keys,
- no insignificant whitespace,
- integers only for numeric values,
- no floating-point numbers.

Absent metadata is serialized as `{}`.

When session context is present (`session_id`, `actor_id`, `inference_metadata`), these fields are merged into the metadata object before canonicalization and become part of the signed message.

---

## Deterministic Signature Message (v2.0)

The v2.0 message digest is constructed as:

```text
message = SHA-256(
  context_prefix        ||   -- UTF-8 "VRI-SIG-V2\0" (11 bytes)
  proof_type_code       ||   -- 0x01 RECORDED, 0x02 GENERATED (1 byte)
  compliance_level      ||   -- unsigned byte in [1,3] (1 byte)
  watermark_flag        ||   -- 0x00 absent, 0x01 present (1 byte)
  watermark_bytes       ||   -- 8-byte payload, or 8 zero bytes if absent
  identity_flag         ||   -- 0x00 absent, 0x01 present (1 byte)
  identity_hash         ||   -- SHA-256(canonical_identity_string), or 32 zero bytes if absent
  audio_hash            ||   -- raw 32 bytes of SHA-256(canonical_audio)
  timestamp             ||   -- unsigned 64-bit big-endian Unix seconds
  metadata_length       ||   -- unsigned 32-bit big-endian byte count
  canonical_metadata_bytes   -- UTF-8 bytes of canonical metadata JSON
)
```

The resulting 32-byte digest is signed with Ed25519.

### Construction rules

| Field | Encoding |
|-------|----------|
| `context_prefix` | Raw UTF-8 bytes of `"VRI-SIG-V2\0"` (11 bytes including null terminator) |
| `proof_type_code` | Single byte: `0x01` for `RECORDED`, `0x02` for `GENERATED` |
| `compliance_level` | Single unsigned byte: `0x01`, `0x02`, or `0x03` |
| `watermark_flag` | `0x00` if no watermark present, `0x01` otherwise |
| `watermark_bytes` | 8-byte watermark payload if flag is `0x01`; 8 zero bytes if flag is `0x00` |
| `identity_flag` | `0x00` if no identity present, `0x01` otherwise |
| `identity_hash` | 32-byte SHA-256 of the canonical identity string if flag is `0x01`; 32 zero bytes otherwise |
| `audio_hash` | Raw 32 bytes (not hex-encoded) of SHA-256 over Canonical Audio |
| `timestamp` | Unsigned 64-bit integer, big-endian |
| `metadata_length` | Unsigned 32-bit integer, big-endian, byte length of `canonical_metadata_bytes` |
| `canonical_metadata_bytes` | UTF-8 encoding of canonical metadata JSON |

This construction prevents downgrade attacks (a v2.0 verifier will reject a v1.0-style message), field-confusion attacks across proof types and compliance levels, and identity-object substitution attacks.

---

## Watermark Nonce Binding

When an `identity` object is present in a proof, the nonce byte (byte 7) of the watermark payload is not freely chosen. It is derived deterministically from the session's QR nonce:

```text
watermark_nonce_byte = SHA-256("VRI-WM-NONCE-V1\0" || base64_decode(identity.nonce))[0]
```

This binding ensures the watermark physically embedded in the audio can only be correct if it was produced inside the authorized session. See [watermark-spec.md §2.3](./watermark-spec.md) and protocol §8.4.1 for normative rules.

---

## Proof Package Requirements

A protocol-aligned v2.0 Proof Package includes:

**Required fields (all levels):**

- `protocol_version` — must be `"2.0"`
- `proof_type` — `RECORDED` or `GENERATED`
- `compliance_level` — integer `1`, `2`, or `3`
- `audio_hash` — hex-encoded SHA-256 of Canonical Audio
- `signature.algorithm` — must be `"Ed25519"`
- `signature.value` — hex-encoded 64-byte Ed25519 signature
- `public_key` — hex-encoded 32-byte raw Ed25519 public key
- `creator_id` — hex-encoded 4-byte creator identifier
- `timestamp` — unsigned integer Unix seconds
- `metadata` — JSON object (may be `{}`)
- `canonical_metadata` — canonical serialization of `metadata`

**Level 1 anti-ambiguity rule:** Level 1 proofs MUST NOT contain `watermark_payload`, `watermark_hex`, `watermark_format_version`, `usage_event_id`, `ledger_anchor`, or `timestamp_attestation`.

**Level 2+ (GENERATED):** `watermark_format_version`, `watermark_payload`, `watermark_hex`.

**Level 3:** `timestamp_attestation`, `usage_event_id`, `ledger_anchor`.

**Optional at any level:** `identity`, `key_id`, `verification_endpoint`, `extensions`, `blockchain_anchor`.

---

## Verification Summary

Verification requires, in order:

1. Parse and validate `protocol_version`, `proof_type`, `compliance_level`.
2. If `identity` is present or required, verify the identity assertion independently.
3. Resolve watermark payload (reconcile `watermark_hex` / `watermark_payload` if both present).
4. If `identity` is present and watermark is declared, verify watermark nonce binding (§8.4.1).
5. Canonicalize the presented audio and recompute `audio_hash`.
6. Reconstruct `canonical_metadata`.
7. Derive `creator_id` from `public_key` and compare against declared value (constant-time).
8. Reconstruct the exact v2.0 message digest including the bound `identity` hash when present.
9. Verify the Ed25519 signature with the declared `public_key`.
10. Apply proof-type and compliance-specific checks (watermark extraction, timestamp attestation, ledger inclusion).

Signature validity alone is not sufficient. All required checks for the declared compliance level must pass.
