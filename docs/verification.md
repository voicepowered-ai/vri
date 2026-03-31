# Verification Companion

## Status

This document is non-normative. `VRI-PROTOCOL-v1.0.md` is the normative source for verification behavior. This companion summarizes the protocol-defined verification flow.

## Verification Inputs

A verifier performing cryptographic verification needs:

- the presented audio or an authoritative reference to it,
- the Proof Package,
- the public key from the Proof Package or an authoritative matching key record.

## Verification Sequence

The protocol-defined verification sequence is:

1. parse `protocol_version`,
2. reject unsupported major versions,
3. validate required Proof Package fields,
4. decode `watermark_payload`,
5. attempt watermark extraction when audio evidence is present,
6. compare extracted payload to the Proof Package payload when extraction succeeds,
7. reconstruct `canonical_metadata`,
8. reconstruct the deterministic signature message,
9. verify the Ed25519 signature,
10. validate ledger state when ledger evidence is claimed or required,
11. optionally invoke the Forensic Detection Layer if watermark extraction fails or is inconclusive.

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

## Ledger Validation

The ledger provides:

- append-only event recording,
- event ordering,
- anchored time integrity.

The ledger does not independently prove authenticity of a presented audio artifact. Ledger evidence must be combined with signature and watermark evidence for full verification of the presented audio artifact.

## Compliance-Level Implications

- Level 1: validate Proof Package structure, `audio_hash`, and signature semantics.
- Level 2: Level 1 plus watermark validation.
- Level 3: Level 2 plus ledger validation.

Implementations must not report Level 2 or Level 3 properties for artifacts that only satisfy Level 1 behavior.
