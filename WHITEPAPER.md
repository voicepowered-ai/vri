# VRI Whitepaper: Voice Rights Infrastructure

## Abstract

VRI is a generation-layer trust model for AI-generated voice artifacts. It combines audio watermarking, deterministic cryptographic signatures, and append-only ledger registration to support provenance verification by independent parties. The protocol is designed to operate at the output boundary of synthesis systems through an Inference Adapter that enforces watermarking, signing, and proof-carrying output.

This whitepaper explains the motivation, system model, trust model, and operating assumptions behind VRI Protocol v1.0. It is explanatory rather than normative.

## Relationship to VRI Protocol v1.0

`VRI-PROTOCOL-v1.0.md` is the normative specification for VRI Protocol v1.0. Where this whitepaper and the protocol differ, the protocol controls. In particular, the protocol is authoritative for:

- the definition of Canonical Audio,
- the definition of `audio_hash`,
- the deterministic signature message,
- Proof Package structure,
- compliance levels,
- failure semantics,
- verification behavior.

This whitepaper does not introduce additional protocol requirements and does not expand the conformance surface beyond the protocol.

---

## 1. Problem Statement

AI voice synthesis makes high-quality voice generation broadly accessible, but provenance remains difficult to establish after an artifact leaves the generation boundary. The practical problems are:

1. attribution of generated artifacts to a signing key,
2. reproducible integrity checks over emitted artifacts,
3. time ordering of recorded generation events,
4. separation of cryptographic proof from probabilistic forensic signals.

VRI does not solve every problem in voice misuse. It does not prevent cloning, imitation, or resynthesis. It aims to make protocol-participating artifacts easier to attribute and verify.

---

## 2. System Model

VRI is a hybrid trust infrastructure. Enforcement occurs within a controlled generation path, while verification is designed to be reproducible by third parties.

The model is:

```text
Prompt -> Generation System -> Inference Adapter -> Watermark Layer -> Signature Layer -> Ledger Layer -> Proof-Carrying Output
```

The Inference Adapter is the enforcement boundary. It is responsible for ensuring that raw model output is not externally visible before the required protocol steps complete. Under the protocol:

- watermarking occurs before signing,
- signing occurs over a deterministic message,
- ledger registration occurs before Level 3 output emission,
- protocol-complete output is proof-carrying rather than audio-only.

VRI is not a fully decentralized system. The ledger is not a source of truth by itself. It provides ordering and time integrity and must be combined with signature and watermark evidence for full verification of a presented artifact.

---

## 3. Core Concepts

### 3.1 Watermark

The watermark is signal-bound provenance evidence embedded into the audio. In VRI Protocol v1.0, the baseline Watermark Payload is 64 bits:

```text
[creator_id: 32 bits] [timestamp: 24 bits] [nonce: 8 bits]
```

Watermark recovery is probabilistic. VRI does not claim guaranteed recoverability after destructive transformations or adversarial processing. Survivability claims are meaningful only under stated conditions such as typical codec transformations, moderate equalization, moderate resampling, or ordinary playback-recording chains.

Watermark evidence alone is not sufficient. It must be combined with a valid signature for cryptographic verification.

### 3.2 Signature

VRI Protocol v1.0 uses Ed25519. The public key is the authoritative identity. `creator_id` is derived from the public key and is not an independent trust root.

Trust is anchored in key ownership, not identifiers.

The protocol-defined signed message is deterministic and is computed from:

- `watermark_payload`,
- `audio_hash`,
- `timestamp`,
- `canonical_metadata`.

The exact serialization and hashing rules are defined in the protocol and are not restated here in abbreviated form. The signature proves that the corresponding private key signed the defined message. It does not prove originality in a broader philosophical or legal sense.

### 3.3 Canonical Audio

All hashing and signing operate on Canonical Audio. Canonical Audio is a container-independent PCM representation defined by the protocol. The v1.0 protocol fixes:

- linear PCM,
- 24-bit signed little-endian samples,
- 48000 Hz sample rate,
- mono or stereo channel count,
- no container metadata in the hashed byte stream.

`audio_hash` is SHA-256 over the exact Canonical Audio byte sequence. No alternate hash function is allowed in v1.0.

### 3.4 Usage Event and Ledger

A Usage Event is the append-only record associated with generation or verification activity. The ledger provides:

- append-only recording semantics,
- event ordering,
- externally anchored time integrity.

The ledger does not independently prove authenticity of an audio artifact. Ledger evidence without matching watermark and signature evidence is insufficient to prove provenance of a presented artifact.

### 3.5 Forensic Detection Layer

The Forensic Detection Layer is a probabilistic acoustic similarity subsystem used for discovery, clustering, fraud triage, and investigative support. It is not cryptographic proof and must not be presented as equivalent to signature-based verification.

---

## 4. Deterministic Generation Path

VRI is strongest when the generation path is treated as a mandatory protocol boundary rather than an optional post-processing step.

At a high level:

1. the Generation System routes synthesis through the Inference Adapter,
2. the Watermark Layer embeds the Watermark Payload,
3. the Inference Adapter derives Canonical Audio from the emitted artifact,
4. the Signature Layer computes `audio_hash` and the deterministic message,
5. the Signature Layer signs the 32-byte message digest using Ed25519,
6. the Ledger Layer records a Usage Event for Level 3 compliance,
7. the system emits a Proof Package bound to the emitted artifact.

This ordering matters. If signing occurs before watermarking, the proof does not cover the final emitted artifact. If raw output bypasses the Inference Adapter, the artifact is outside VRI compliance.

---

## 5. Verification Model

VRI verification is multi-layer and reproducible:

1. attempt watermark extraction from the presented audio,
2. compare extracted payload to the Proof Package payload when available,
3. reconstruct the deterministic message defined by the protocol,
4. verify the Ed25519 signature against the declared public key,
5. validate ledger state when ledger evidence is claimed,
6. optionally invoke the Forensic Detection Layer if watermark extraction fails or is inconclusive.

No single layer is sufficient in isolation:

- watermark without signature is insufficient,
- signature without signal evidence may support provenance of the emitted artifact but may be insufficient to prove integrity of a transformed distributed copy,
- ledger state without watermark and signature evidence is insufficient.

---

## 6. Compliance Levels

The protocol defines three compliance levels:

- Level 1: Signature-only.
- Level 2: Signature plus Watermark.
- Level 3: Full VRI, including Signature, Watermark, and Ledger.

This whitepaper discusses the full model, but the protocol is explicit that conformance claims must state a compliance level. A system must not claim watermark or ledger properties that it does not implement.

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

---

## 8. Public Release Scope

This repository is a protocol and documentation release. It includes:

- the normative protocol specification,
- explanatory companion documentation,
- a documentation signing and verification bundle for public release integrity.

It does not claim to ship a production deployment of watermarking, ledger services, usage accounting services, or deployment integrations.

---

## 9. Conclusion

VRI Protocol v1.0 defines a generation-layer approach to provenance for AI-generated voice artifacts. Its security model relies on deterministic signing of Canonical Audio-derived evidence, signal-bound watermarking, and append-only ledger ordering. Its trust model is intentionally limited and explicit: provenance claims are strongest when watermark, signature, and ledger evidence agree, and weaker when only a subset is available.
