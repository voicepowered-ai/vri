# Cryptographic Specification Companion

## Status

This document is non-normative. `VRI-PROTOCOL-v1.0.md` is authoritative. This file summarizes the protocol-defined cryptographic behavior in a companion format for implementers.

## Signature Algorithm

VRI Protocol v1.0 uses Ed25519.

- Signature algorithm: `Ed25519`
- Public key length: 32 bytes
- Signature length: 64 bytes
- Hash function for `audio_hash`: SHA-256
- Hash function for the protocol-defined message digest: SHA-256

No alternative signature algorithm and no alternative hash function are allowed in v1.0.

## Identity Binding

The public key is the authoritative identity.

- `creator_id` is derived from the public key.
- `creator_id` is the first 32 bits of `SHA-256(public_key_bytes)`.
- `creator_id` is a lookup hint and compact payload field.
- `creator_id` is not a standalone trust root.

Trust is anchored in key ownership, not identifiers.

## Canonical Audio and `audio_hash`

All hashing and signing operate on Canonical Audio as defined by the protocol.

For v1.0:

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

## Deterministic Signature Message

The protocol-defined message is:

```text
message = SHA-256(
  watermark_payload ||
  audio_hash ||
  timestamp ||
  canonical_metadata
)
```

The byte-level serialization is:

- `watermark_payload`: raw 8-byte Watermark Payload.
- `audio_hash`: raw 32-byte SHA-256 digest.
- `timestamp`: unsigned 64-bit big-endian Unix time in seconds.
- `canonical_metadata`: `metadata_length || canonical_metadata_bytes`.
- `metadata_length`: unsigned 32-bit big-endian byte length.

The resulting 32-byte `message` digest is signed with Ed25519.

## Proof Package Requirements

At minimum, a protocol-aligned Proof Package includes:

- `protocol_version`,
- `compliance_level`,
- `watermark_payload`,
- `audio_hash`,
- `signature.algorithm`,
- `signature.value`,
- `public_key`,
- `timestamp`,
- `metadata`,
- `canonical_metadata`,
- `usage_event_id` for Level 3 claims.

## Verification Summary

Verification requires:

1. parsing and validating the Proof Package structure,
2. reconstructing `canonical_metadata`,
3. reconstructing the deterministic message digest,
4. verifying the Ed25519 signature with the declared public key,
5. validating watermark evidence and ledger evidence as required by the claimed compliance level.

The ledger is not a substitute for signature validation. Watermark evidence alone is not sufficient.
