# Verification Companion

## Status

This document is non-normative. `VRI-PROTOCOL-v2.0.md` is the normative source for verification behavior. This companion summarizes the protocol-defined verification flow.

## Verification Inputs

A verifier performing cryptographic verification needs:

- the presented audio or an authoritative reference to it,
- the Proof Package,
- the public key from the Proof Package or an authoritative matching key record.

## Verification Sequence

The protocol-defined verification sequence is:

1. parse `protocol_version`,
2. reject unsupported major versions,
3. validate required Proof Package fields including `proof_type` and `compliance_level`,
4. validate `identity` when present or required,
5. decode `watermark_payload` when declared,
6. attempt watermark extraction when audio evidence is present and watermark is declared,
7. compare extracted payload to the Proof Package payload when extraction succeeds,
8. reconstruct `canonical_metadata`,
9. reconstruct the deterministic signature message,
10. verify the Ed25519 signature,
11. validate timestamp and ledger state when required,
12. optionally invoke the Forensic Detection Layer if watermark extraction fails or is inconclusive.

## Verification Outcomes

The protocol defines the following minimum outcome classes:

- `authentic_watermark`
- `watermark_present_signature_invalid`
- `signature_valid_watermark_unrecovered`
- `watermark_not_found`
- `forensic_match_only`
- `unverified`

Forensic outputs are probabilistic and MUST NOT be reported as equivalent to cryptographic proof.

## Watermark Validation

Watermark extraction is a signal-processing step and is probabilistic.

- Successful extraction can support audio-to-proof binding.
- Failed extraction does not, by itself, invalidate a valid Proof Package for the originally emitted artifact.
- Watermark non-recovery on a transformed copy does not convert forensic evidence into cryptographic proof.

## Signature Validation

The signature check is deterministic.

A valid signature proves that the holder of the private key corresponding to the declared public key signed the protocol-defined message. It does not, by itself, prove that a transformed distributed copy still matches the originally emitted audio signal unless the presented audio also carries matching watermark evidence.

## Identity Validation

When an `identity` object is present, the verifier validates it independently before accepting the proof as identity-bound.

Identity validation does not replace artifact signature validation. It binds a QR-authorized device session to the proof context.

## Ledger Validation

The ledger provides:

- append-only event recording,
- event ordering,
- anchored time integrity.

The ledger does not independently prove authenticity of a presented audio artifact. Ledger evidence must be combined with signature and watermark evidence for full verification of the presented audio artifact.

## Timestamp Attestation Validation

For Level 3, the verifier validates `timestamp_attestation` in two layers:

- core fail-closed checks: required fields, digest consistency, and `attested_at >= proof.timestamp`,
- deployment-specific attestation verification: TSA signature/path validation via a trusted verifier implementation.

The current reference implementation exposes this second layer through a verifier callback. Without a configured timestamp-attestation verifier, Level 3 verification fails closed.

The default reusable profile implemented in the reference code is a normalized `RFC3161` object that carries:

- `tsa`
- `policy_oid`
- `serial_number`
- `message_imprint_alg`
- `message_imprint`
- `attested_at`
- `gen_time`
- `token`

This is a verifier-facing normalization layer for RFC 3161 evidence. It is not a full ASN.1 TSA client by itself.

When raw RFC 3161 tokens are ingested, the parser boundary is explicit:

- VRI expects an external `parseRfc3161Token` function,
- the parser may return either a normalized attestation object directly,
- or `{ ok: true, attestation }` / `{ ok: false, reason }`,
- and VRI fails closed if the parser output does not match that contract.

## Compliance-Level Implications

- Level 1: validate Proof Package structure, `audio_hash`, and signature semantics. No watermark or ledger-attestation fields are allowed.
- Level 2: Level 1 plus distribution-binding validation. For `GENERATED`, this includes mandatory watermark validation.
- Level 3: Level 2 plus independent timestamp attestation and ledger validation.

Implementations must not report Level 2 or Level 3 properties for artifacts that only satisfy Level 1 behavior.
