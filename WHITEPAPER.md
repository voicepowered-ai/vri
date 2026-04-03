# VRI Whitepaper: Voice Rights Infrastructure

## Abstract

VRI is a system-level provenance model for recorded and generated audio artifacts. It combines canonical audio hashing, deterministic cryptographic signatures, mode-specific watermarking, optional identity-bound session authorization, and append-only timestamped evidence to provide reproducible traceability across capture, generation, export, and verification boundaries.

This whitepaper explains the motivation, system model, trust model, and operating assumptions behind VRI Protocol v2.0. It is explanatory rather than normative.

## Relationship to VRI Protocol v2.0

`VRI-PROTOCOL-v2.0.md` is the normative specification for VRI Protocol v2.0. Where this whitepaper and the protocol differ, the protocol controls. In particular, the protocol is authoritative for:

- the definition of Canonical Audio,
- the definition of `audio_hash`,
- the deterministic signature message,
- Proof Package structure,
- `proof_type`,
- compliance levels,
- trust-level mapping,
- identity-layer semantics,
- timestamp-attestation requirements,
- failure semantics,
- verification behavior.

This whitepaper does not introduce additional protocol requirements and does not expand the conformance surface beyond the protocol.

---

## 1. Problem Statement

Recorded and generated audio both suffer from weak provenance once an artifact leaves the system that created or captured it. The practical problems are:

1. attribution of artifacts to a signing key and declared mode,
2. reproducible integrity checks over emitted artifacts,
3. time ordering of recorded events,
4. separation of cryptographic proof from probabilistic forensic signals,
5. binding of human or device authorization to session-scoped proof issuance.

VRI does not solve every problem in voice misuse. It does not prevent cloning, imitation, or resynthesis. It aims to make protocol-participating artifacts easier to trace, attribute, and verify.

---

## 2. System Model

VRI is a hybrid trust infrastructure. Enforcement occurs within controlled capture or generation paths, while verification is designed to be reproducible by third parties.

The model is:

```text
Capture / Generation System
  -> Canonicalization Boundary
  -> Mode-Specific Binding (watermark when required)
  -> Signature Layer
  -> Optional Identity / Timestamp / Ledger Evidence
  -> Proof-Carrying Output
```

The enforcement boundary is responsible for ensuring that raw output is not externally visible before the required protocol steps complete. Under the protocol:

- mode semantics are declared before signing,
- watermarking occurs before signing when required by the selected compliance profile,
- signing occurs over a deterministic message,
- ledger registration occurs before Level 3 output emission,
- protocol-complete output is proof-carrying rather than audio-only.

VRI is not a fully decentralized system. The ledger is not a source of truth by itself. It provides ordering and time integrity and must be combined with signature and watermark evidence for full verification of a presented artifact.

---

## 3. Core Concepts

### 3.1 Proof Type

`proof_type` is a signed declaration that separates `RECORDED` artifacts from `GENERATED` artifacts. This prevents downgrade ambiguity and changes the interpretation of watermark and compliance requirements.

### 3.2 Watermark

The watermark is signal-bound traceability evidence embedded into the audio when the selected mode and compliance profile require it. In the reference profile, the baseline Watermark Payload is 64 bits:

```text
[creator_id: 32 bits] [timestamp: 24 bits] [nonce: 8 bits]
```

Watermark recovery is probabilistic. VRI does not claim guaranteed recoverability after destructive transformations or adversarial processing. Survivability claims are meaningful only under stated conditions such as typical codec transformations, moderate equalization, moderate resampling, or ordinary playback-recording chains.

Watermark evidence alone is not sufficient. It must be combined with a valid signature for cryptographic verification.

### 3.3 Signature

VRI Protocol v2.0 uses Ed25519. The public key is the authoritative cryptographic identity. `creator_id` is derived from the public key and is not an independent trust root.

Trust is anchored in key ownership, not identifiers.

The protocol-defined signed message is deterministic and is computed from:

- `proof_type`,
- `compliance_level`,
- `watermark_payload`,
- `audio_hash`,
- `timestamp`,
- `canonical_metadata`,
- and, when present, bound identity and timestamp-attestation context.

The exact serialization and hashing rules are defined in the protocol and are not restated here in abbreviated form. The signature proves that the corresponding private key signed the defined message. It does not prove originality in a broader philosophical or legal sense.

### 3.4 Identity Layer

VRI optionally supports QR-bootstrapped, device-held signing identities for session authorization. In that model:

- the private key remains on the user device,
- the verifier issues a challenge with freshness and scope,
- the signed identity assertion is independently verifiable,
- and the proof signature binds the canonical identity object so it cannot be swapped after issuance.

This identity layer does not replace the artifact signature or watermark. It complements them by binding session authorization to proof issuance.

### 3.5 Canonical Audio

All hashing and signing operate on Canonical Audio. Canonical Audio is a container-independent PCM representation defined by the protocol. The current protocol fixes:

- linear PCM,
- 24-bit signed little-endian samples,
- 48000 Hz sample rate,
- mono or stereo channel count,
- no container metadata in the hashed byte stream.

`audio_hash` is SHA-256 over the exact Canonical Audio byte sequence.

### 3.6 Usage Event and Ledger

A Usage Event is the append-only record associated with generation, capture, export, or verification activity. The ledger provides:

- append-only recording semantics,
- event ordering,
- externally anchored integrity evidence.

The ledger does not independently prove authenticity of an audio artifact. Ledger evidence without matching watermark and signature evidence is insufficient to prove provenance of a presented artifact.

### 3.7 Timestamp Attestation

Level 3 claims require independent time evidence in addition to ledger inclusion. The protocol supports a normalized timestamp-attestation model and can incorporate RFC 3161 TSA evidence. Blockchain anchoring may strengthen ordering and transparency, but it does not replace timestamp-attestation requirements.

### 3.8 Forensic Detection Layer

The Forensic Detection Layer is a probabilistic acoustic similarity subsystem used for discovery, clustering, fraud triage, and investigative support. In practice it acts as a fallback and triage layer when watermark and signature evidence are absent, degraded, or intentionally destroyed. It is not cryptographic proof and must not be presented as equivalent to signature-based verification.

---

## 4. Deterministic Issuance Path

VRI is strongest when the capture or generation path is treated as a mandatory protocol boundary rather than an optional post-processing step.

At a high level:

1. the Capture or Generation System routes output through the enforcement boundary,
2. the system determines `proof_type` and selected compliance profile,
3. the Watermark Layer embeds the Watermark Payload when required,
4. the boundary derives Canonical Audio from the emitted artifact,
5. the Signature Layer computes `audio_hash` and the deterministic message,
6. the Signature Layer signs the 32-byte message digest using Ed25519,
7. the Identity Layer may bind a device-held, session-scoped authorization object,
8. the Ledger and Timestamp Layers record evidence for Level 3 compliance,
9. the system emits a Proof Package bound to the emitted artifact.

This ordering matters. If signing occurs before required watermarking, the proof does not cover the final emitted artifact. If raw output bypasses the enforcement boundary, the artifact is outside VRI compliance.

---

## 5. Verification Model

VRI verification is multi-layer and reproducible:

1. attempt watermark extraction from the presented audio,
2. compare extracted payload to the Proof Package payload when available,
3. reconstruct the deterministic message defined by the protocol,
4. verify the Ed25519 signature against the declared public key,
5. verify identity assertions when present and required by verifier policy,
6. validate timestamp and ledger state when Level 3 evidence is claimed,
7. optionally invoke the Forensic Detection Layer if watermark extraction fails or is inconclusive.

No single layer is sufficient in isolation:

- watermark without signature is insufficient,
- signature without signal evidence may support provenance of a canonical artifact but may be insufficient to prove integrity of a transformed distributed copy,
- ledger state without watermark and signature evidence is insufficient,
- identity without artifact-bound signature evidence is insufficient.

---

## 6. Compliance Levels

The protocol defines three compliance levels:

- Level 1: Cryptographically valid proof without signal-bound watermark claims.
- Level 2: Artifact proof with required watermark semantics for the selected mode.
- Level 3: Level 2 plus independently verifiable timestamp and ledger-backed ordering evidence.

The protocol is explicit that conformance claims must state a compliance level. A system must not claim watermark, timestamp, or ledger properties that it does not implement.

---

## 7. Threat Boundaries and Limitations

VRI has explicit limits.

It does not:

- prevent cloning,
- prevent imitation,
- guarantee watermark recovery after destructive processing,
- make the ledger an oracle of truth,
- replace external enforcement or adjudication.

Cloning attacks operate outside the VRI trust boundary. VRI provides attribution and time ordering for protocol-participating artifacts; it does not provide general-purpose anti-cloning protection.

Private key compromise remains a critical failure mode. Secure key storage, rotation, and revocation handling are required operational controls.

Identity proofing remains partially external. VRI can prove that a device-held or service-held key authorized an action; it does not, by itself, prove legal personhood without external identity governance.

---

## 8. Public Release Scope

This repository is a protocol and reference release. It includes:

- the normative protocol specification,
- explanatory companion documentation,
- a reference Node.js verifier and API surface,
- a documentation signing and verification bundle for public release integrity.

It does not claim to ship a globally complete production deployment of watermarking, ledger services, PKI governance, or deployment integrations.

---

## 9. Conclusion

VRI Protocol v2.0 defines a system-level approach to cryptographic traceability for both recorded and generated audio artifacts. Its security model relies on deterministic signing of Canonical Audio-derived evidence, mode-specific watermarking where required, optional identity-bound authorization, and append-only timestamped ordering evidence. Its trust model is intentionally limited and explicit: traceability claims are strongest when artifact proof, identity context, and timestamp evidence agree, and weaker when only a subset is available.
