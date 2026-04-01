# VRI Protocol v1.0 (Final)

## 1. Abstract

VRI Protocol v1.0 specifies a generation-layer protocol for cryptographic attribution, verification, and usage registration of AI-generated voice artifacts. A conforming generation system embeds a watermark into generated audio, computes a deterministic SHA-256 digest over the canonical emitted audio, signs a deterministic message using Ed25519, registers a Usage Event in an append-only externally anchored ledger, and returns a proof-carrying artifact to the caller. Verification is performed across independent layers: audio-layer watermark evidence, cryptographic signature validation, and ledger-based time integrity. If audio is generated through a conforming full VRI path, its provenance can be independently verified. If it is not, its legitimacy is uncertain.

## 2. Terminology

The key words `MUST`, `MUST NOT`, `REQUIRED`, `SHALL`, `SHALL NOT`, `SHOULD`, `SHOULD NOT`, `RECOMMENDED`, `NOT RECOMMENDED`, `MAY`, and `OPTIONAL` in this document are to be interpreted as described in RFC 2119 and RFC 8174.

### 2.1 Defined Terms

**Generation System**

A software or service boundary that performs text-to-speech or equivalent voice artifact synthesis. A Generation System MAY use a local model, a hosted external model API, or an open-source model runtime. A conforming Generation System MUST emit only proof-carrying artifacts at its external boundary.

**Inference Adapter**

The protocol component that defines the sole valid enforcement boundary for generation-time compliance. The Inference Adapter is responsible for intercepting model output, normalizing generated audio, invoking watermark insertion, invoking signing, creating a Usage Event, and ensuring that unsigned raw audio does not leave the trusted generation boundary.

**Canonical Audio**

The exact container-independent PCM representation defined in Section 4. All hashing and signing operations in this protocol operate on Canonical Audio.

**Watermark Payload**

A compact bit-level structure encoded into audio at generation time. In VRI Protocol v1.0, the baseline payload format is 64 bits consisting of `creator_id`, `timestamp`, and `nonce`.

**Proof Package**

A structured artifact containing the data necessary to verify provenance of generated audio. At minimum, this includes the protocol version, watermark payload, signature material, public key material, timestamp information, canonical audio hash, and ledger reference information required by the claimed compliance level.

**Usage Event**

An append-only record created during generation or verification that binds a generated or observed audio artifact to a timestamped ledger entry and associated metadata.

**Verification**

The process of independently evaluating provenance claims by extracting watermark evidence when possible, validating the signature over the deterministic message defined by this specification, and validating the presence and ordering of corresponding ledger events when ledger evidence is claimed.

**Forensic Detection Layer**

The probabilistic acoustic similarity subsystem used for discovery, clustering, fraud triage, and investigative support when cryptographic watermark recovery is absent or unreliable. The Forensic Detection Layer does not constitute cryptographic proof of origin and MUST be reported separately from cryptographic verification outcomes.

**Hybrid Trust Infrastructure**

An architecture in which orchestration is centralized for enforcement and operational consistency, while verification is distributed across independent protocol layers that can be reproduced by third parties.

**creator_id**

A compact protocol-scoped identifier derived from a public key as defined in Section 9.1. `creator_id` is an index and lookup hint. It is not an independent trust root and MUST NOT be treated as a standalone identity.

## 3. System Overview

VRI Protocol v1.0 defines an inference-first model. The protocol does not depend on downstream artifact-handling systems to create origin evidence. Instead, the protocol attaches origin evidence at the moment of synthesis.

The system model is:

```text
Prompt -> Generation System -> Inference Adapter -> Watermark Layer -> Signature Layer -> Ledger Layer -> Proof-Carrying Audio Output
```

Under this model:

- The Generation System MUST route every successful synthesis output through the Inference Adapter.
- The Inference Adapter MUST ensure watermark insertion occurs before signing.
- The Signature Layer MUST sign the deterministic message defined in Section 9.3.
- The Ledger Layer MUST register a Usage Event before a Level 3 proof-carrying artifact is emitted externally.
- External verification systems MAY act as optional verifiers, but they MUST NOT be treated as the origin of trust.

VRI Protocol v1.0 distributes verification across independent layers:

- Audio-layer watermark evidence.
- Cryptographic proof derived from possession of the corresponding private key.
- Externally anchored ledger evidence for time integrity and event ordering.

VRI does not prove originality. It proves the earliest verifiable claim of creation under this protocol.

## 4. Canonical Audio Representation

All hashing and signing MUST operate on Canonical Audio. All implementations MUST normalize audio before hashing. Container metadata, transport metadata, file headers, and non-audio framing bytes MUST NOT be included in Canonical Audio.

### 4.1 Canonical Encoding

For VRI Protocol v1.0, Canonical Audio is defined as follows:

- Encoding: linear PCM.
- Signedness: signed integer samples.
- Endianness: little-endian sample encoding.
- Bit depth: 24-bit.
- Sample rate: 48000 Hz.
- Channel count: 1 or 2 only.
- Channel ordering: for stereo, channel 0 is left and channel 1 is right.
- Sample interleaving: interleaved by frame for stereo (`L0 R0 L1 R1 ...`).
- Container metadata: excluded.

No alternative bit depth, sample rate, floating-point representation, or sample packing is allowed for Canonical Audio in v1.0.

### 4.2 Canonicalization Procedure

To derive Canonical Audio, an implementation MUST perform the following steps in order:

1. Decode the internal or received audio representation into uncompressed PCM samples.
2. Discard all container metadata, transport metadata, file headers, and non-audio side data.
3. Convert the sample rate to exactly 48000 Hz using a deterministic resampler.
4. Convert the channel layout so that the resulting audio has either 1 channel or 2 channels.
5. Quantize samples to signed 24-bit little-endian PCM.
6. Serialize the resulting PCM sample stream with no container wrapper and no extra bytes.

### 4.3 Channel Rules

The following channel conversion rules are normative:

- If the source audio has 1 channel, the Canonical Audio MUST remain mono.
- If the source audio has 2 channels, the Canonical Audio MUST remain stereo with the original left-right ordering preserved.
- A conforming Generation System MUST NOT emit protocol-complete output with more than 2 channels.
- If a verifier receives audio with more than 2 channels, the verifier MAY decode and downmix it for watermark extraction, but such audio MUST NOT be treated as the original protocol-complete emitted artifact unless the verifier has an authoritative out-of-band mapping to the original mono or stereo artifact.

### 4.4 Sample Normalization Rules

Implementations MUST apply the following numeric rules:

- Input PCM values MUST be clipped to the closed interval `[-1.0, +1.0]` before quantization if an internal floating-point representation is used.
- Quantization to signed 24-bit PCM MUST use round-to-nearest with ties away from zero.
- The representable integer range is `[-8388608, 8388607]`.
- The serialized 24-bit little-endian representation MUST use two's-complement encoding.
- NaN and positive/negative infinity input samples MUST be rejected.
- Subnormal floating-point samples MUST be treated as finite numeric values and MUST NOT be silently rewritten as NaN.
- Implementations MUST publish deterministic test vectors for quantization edge cases.

### 4.5 Canonical Audio Hash

`audio_hash` MUST be computed as:

```text
audio_hash = SHA-256(canonical_audio_bytes)
```

`audio_hash` is the 32-byte raw SHA-256 digest over the exact Canonical Audio byte sequence. No alternative hash function is allowed in VRI Protocol v1.0.

## 5. Versioning and Extensibility

The protocol version MUST be included in all Proof Packages.

### 5.1 Version Format

- `protocol_version` MUST be a string of the form `MAJOR.MINOR`.
- For this specification, the required value is `1.0`.
- `MAJOR` and `MINOR` MUST be decimal integers without leading sign characters.

### 5.2 Compatibility Rules

- Major versions MUST be incompatible.
- Minor versions MUST be backward compatible within the same major version.
- Implementations MUST reject unsupported major versions.
- Implementations MAY accept a higher minor version within the same supported major version only if all REQUIRED fields used by verification are understood and all unknown extension fields are ignorable under Section 5.4.

### 5.3 Extensible Fields

- Signature algorithms MUST be explicitly declared in every Proof Package.
- Watermark formats MAY evolve via version negotiation.
- A Proof Package MAY include `watermark_format_version` and `extensions`.
- Unknown extension fields within a supported major version MAY be ignored only if they do not modify the semantics of required fields defined by earlier versions.

### 5.4 Forward-Compatibility Constraints

- Future extensions MUST NOT break verification of prior versions.
- Future extensions MUST NOT redefine the meaning of `audio_hash`, `watermark_payload`, `public_key`, `timestamp`, `canonical_metadata`, `signature`, `usage_event_id`, or `ledger_anchor` for already-published major versions.
- A verifier that encounters an unsupported required extension within a supported major version MUST reject the artifact as `unverified`.

## 6. Protocol Components

### 6.1 Watermark Layer

The Watermark Layer embeds a compact payload into the generated audio signal using a robust, perceptually constrained encoding method.

The Watermark Layer:

- MUST encode a Watermark Payload into the synthesized audio before hashing and signing.
- MUST operate before the Signature Layer is invoked.
- MUST be designed for recoverability under typical distribution transformations.
- MUST NOT claim guaranteed recoverability under severe destructive or adversarial transformations.
- MUST treat watermark detection and recoverability as probabilistic, not absolute.
- SHOULD use perceptual masking to minimize audible artifacts.
- SHOULD use redundancy and error-correcting coding to improve recoverability.
- MAY use subband spreading, interleaving, LDPC coding, and time-frequency embedding.

Watermark claims in VRI Protocol v1.0 are probabilistic. Implementations MUST describe watermark survivability only under stated conditions, such as typical codec transformations, moderate equalization, moderate resampling, or ordinary playback-recording chains. Implementations MUST NOT claim perfect persistence, perfect detection, or universal recoverability.

### 6.2 Signature Layer

The Signature Layer binds a generated artifact to the holder of a signing key.

The Signature Layer:

- MUST use Ed25519 in VRI Protocol v1.0.
- MUST declare `signature.algorithm` as `Ed25519`.
- MUST sign the deterministic 32-byte message digest defined in Section 9.3.
- MUST produce a signature that can be independently verified using the corresponding public key.
- MUST ensure that the signed message incorporates timestamped provenance information.
- MUST use the canonical serialization rules defined by this specification.

A cryptographic signature proves that the holder of the corresponding private key signed the defined message. Trust is anchored in key ownership, not identifiers.

### 6.3 Ledger Layer

The Ledger Layer records ordered events and provides time integrity.

The Ledger Layer:

- MUST record Usage Events in an append-only ledger for Level 3 compliance.
- MUST preserve event ordering.
- MUST provide externally anchored time integrity on a periodic basis.
- MUST NOT be described as a source of absolute truth.
- SHOULD batch events into anchored commitments such as Merkle roots.
- MAY publish anchors to an external blockchain or comparable timestamping substrate.

The ledger provides immutable record semantics, time integrity, and ordering. It does not, by itself, prove the authenticity of a distributed audio artifact without corresponding watermark and signature evidence. Ledger evidence requires signature validation and watermark validation for full verification of a presented audio artifact.

### 6.4 Inference Adapter

The Inference Adapter is the enforcement boundary of the protocol and the only valid output boundary for protocol-complete generation.

The Inference Adapter:

- MUST intercept raw output from the underlying generation runtime.
- MUST normalize audio into Canonical Audio before hashing.
- MUST ensure watermarking occurs before signing.
- MUST ensure ledger registration occurs before Level 3 output emission.
- MUST create or initialize a Usage Event before returning output externally.
- MUST NOT allow unsigned raw audio to leave the trusted boundary.
- MUST NOT allow raw model output to become externally visible.
- MUST ensure the external output contract is proof-carrying rather than audio alone.
- SHOULD support local models, external model APIs, and open-source model runtimes.
- MAY support synchronous, asynchronous, and streaming generation paths subject to Section 14.2.

Bypassing the Inference Adapter is non-compliant. Raw model output MUST NEVER be externally visible. Any interface that exposes raw model output outside the Inference Adapter boundary MUST be treated as outside VRI compliance.

## 7. Generation Protocol (Normative)

### 7.1 Overview

The Generation Protocol defines the required sequence of actions for producing a compliant VRI artifact.

### 7.2 Normative Sequence

1. A Generation System receives a synthesis request.
2. The Generation System MUST route the request through the Inference Adapter.
3. The Inference Adapter MAY select an internal model, an external API, or an open-source runtime.
4. The selected generation runtime produces raw audio internally.
5. The Inference Adapter MUST prevent the raw audio from becoming externally visible.
6. The Inference Adapter MUST initialize a Usage Event with at least `PENDING` state before protocol-complete output is emitted.
7. The Watermark Layer MUST embed the Watermark Payload into the audio.
8. The Inference Adapter MUST derive Canonical Audio from the watermarked emitted audio representation as defined in Section 4.
9. The Signature Layer MUST compute `audio_hash = SHA-256(canonical_audio_bytes)`.
10. The Signature Layer MUST serialize `canonical_metadata` as defined in Section 9.2.
11. The Signature Layer MUST construct the deterministic message digest as defined in Section 9.3.
12. The Signature Layer MUST compute an Ed25519 signature over that 32-byte message digest.
13. For Level 3 compliance, the Ledger Layer MUST register the Usage Event and transition it to an externally referenceable recorded state before the external output is emitted.
14. The Generation System MUST return a proof-carrying artifact.
15. The Generation System MUST NOT emit raw unsigned audio to any external caller.
16. The Proof Package MUST correspond exactly to the emitted audio artifact referenced or returned by the Generation System.

### 7.3 Strict Output Contract

A conforming external output MUST be equivalent in semantics to:

```json
{
  "audio": "<audio artifact bytes or resolvable audio reference>",
  "proof_package": "<structured provenance object>"
}
```

The following rules are normative:

- Output MUST be proof-carrying.
- Audio-only output MUST NOT be considered compliant.
- The Proof Package MUST correspond exactly to the emitted audio.
- A Generation System MAY return an audio URL rather than inline audio bytes only if the referenced audio decodes exactly to the Canonical Audio represented by `audio_hash`.
- A Generation System MUST NOT modify the PCM sample stream after `audio_hash` is computed unless it recomputes the entire Proof Package.
- Lossy or transformative re-encoding after signature generation is non-compliant unless the proof is regenerated for the transformed emitted artifact.

### 7.4 Failure Semantics

No silent degradation is allowed.

If watermark insertion fails, a conforming implementation:

- MUST fail the request or defer completion in an explicitly incomplete state.
- MUST NOT silently emit raw unsigned audio.
- MUST NOT emit an artifact as compliant output.

If signing fails, a conforming implementation:

- MUST NOT emit the artifact.
- MUST NOT return the artifact as a verified or compliant VRI artifact.
- MAY retain the internally generated artifact for later completion if policy permits, but that retained artifact remains non-compliant until a full proof is generated.

If ledger registration fails for a Level 3 artifact, a conforming implementation:

- MUST NOT emit the final artifact as Level 3 compliant output.
- MAY return an explicitly incomplete or pending state only if the interface unambiguously distinguishes incomplete artifacts from protocol-complete artifacts.
- MUST NOT silently downgrade the artifact to a lower compliance level.

## 8. Verification Protocol (Normative)

### 8.1 Overview

Verification determines whether an artifact has valid origin evidence under VRI.

### 8.2 Required Inputs

A verifier performing cryptographic verification MUST have:

- the presented audio or an authoritative reference to it,
- the Proof Package,
- the public key from the Proof Package or an authoritative key record that matches it.

### 8.3 Normative Sequence

1. A verifier receives audio and a Proof Package.
2. The verifier MUST parse `protocol_version` and reject unsupported major versions.
3. The verifier MUST reject Proof Packages where `protocol_version` is absent.
4. The verifier MUST validate the syntactic structure of all required Proof Package fields.
5. The verifier MUST decode `watermark_payload` into its raw 8-byte form.
6. The verifier MUST attempt watermark extraction when audio evidence is present.
7. If watermark extraction succeeds, the verifier MUST compare the extracted payload to the Proof Package `watermark_payload`.
8. The verifier MUST reconstruct `canonical_metadata` exactly as defined in Section 9.2.
9. The verifier MUST reconstruct the deterministic message digest exactly as defined in Section 9.3.
10. The verifier MUST validate the Ed25519 signature using the supplied public key.
11. The verifier MUST verify `creator_id` by deterministically deriving it from `public_key` as defined in Section 9.1.
12. If ledger evidence is claimed or required by the compliance level, the verifier MUST validate corresponding ledger state.
13. If watermark extraction fails or is inconclusive, the verifier MAY invoke the Forensic Detection Layer.
14. The verifier MUST distinguish cryptographic verification from forensic detection in outputs.
15. The verifier MUST NOT report forensic detection results as equivalent to cryptographic proof.

### 8.4 Verification Outcomes

A verifier SHOULD classify outcomes into at least the following categories:

- `authentic_watermark`: watermark extracted, payload matched, signature valid, and ledger evidence consistent when required.
- `watermark_present_signature_invalid`: watermark recovered, but the signature is invalid or inconsistent with the Proof Package.
- `signature_valid_watermark_unrecovered`: signature valid over the Proof Package, but no recoverable watermark evidence was found in the presented audio.
- `watermark_not_found`: no recoverable watermark evidence found and no cryptographic conclusion about the presented audio can be made from signal evidence.
- `forensic_match_only`: no cryptographic proof, but acoustic similarity detected.
- `unverified`: insufficient or invalid evidence.

Implementations exposing structured trust signals MUST apply deterministic decision rules:

- `trust_level` MUST be `LOW` if any of `protocol_valid`, `identity_valid`, `metadata_consistent`, or `cryptographic_valid` is false.
- `trust_level` MUST be `HIGH` only if all prior fields are true and watermark state is `present`.
- `trust_level` MUST be `PARTIAL` only if all prior fields are true and watermark state is `missing`, `degraded`, or `not_applicable`.

### 8.5 Ledger Validation

Ledger validation:

- MUST confirm that the referenced Usage Event exists when ledger evidence is claimed.
- MUST confirm ordering and time integrity against anchored commitments where available.
- MUST confirm that the Usage Event content is consistent with the Proof Package fields that are duplicated in the ledger record.
- SHOULD confirm anchor inclusion or batch inclusion if the implementation exposes anchored batch references.

Ledger validation alone is insufficient. The ledger is not truth. The ledger provides ordering and time integrity and requires signature and watermark validation for full verification of a presented audio artifact.

### 8.6 Forensic Detection Behavior

If the Forensic Detection Layer is used:

- The verifier MAY compute acoustic fingerprints, MFCC-derived features, temporal hash chains, or other similarity features.
- The verifier MAY query similarity indexes or clustering services.
- The verifier MUST label outputs as probabilistic.
- The verifier MUST NOT infer authorship solely from acoustic similarity.
- The verifier MUST NOT report forensic similarity as equivalent to a valid VRI proof.

## 9. Data Structures and Deterministic Serialization

### 9.1 Watermark Payload

The baseline Watermark Payload in VRI Protocol v1.0 is exactly 64 bits:

```text
[creator_id: 32 bits] [timestamp: 24 bits] [nonce: 8 bits]
```

Field definitions:

- `creator_id`: the first 32 bits of `SHA-256(public_key_bytes)` interpreted as an unsigned big-endian integer.
- `timestamp`: an unsigned 24-bit big-endian integer equal to `generation_unix_time mod 2^24`.
- `nonce`: an unsigned 8-bit value generated by the Generation System for collision reduction across otherwise similar artifacts.

Serialization rules:

- The payload MUST be serialized as 8 bytes.
- Byte 0 through byte 3: `creator_id` in big-endian order.
- Byte 4 through byte 6: `timestamp` in big-endian order.
- Byte 7: `nonce`.

Identity rules:

- The public key MUST be the authoritative identity.
- `creator_id` MUST be derived from or mapped to the public key.
- `creator_id` MUST NOT be treated as a standalone identity.
- Trust is anchored in key ownership, not identifiers.

Implementations:

- MUST treat the bit layout as stable for version 1.0 unless version negotiation indicates otherwise.
- SHOULD document any mapping from the compact payload to expanded creator identity records.
- MAY carry additional context in the Proof Package rather than in the Watermark Payload.

### 9.2 Canonical Metadata

`canonical_metadata` is the deterministic serialization of the metadata object associated with the generated artifact.

The metadata object:

- MUST be a JSON object.
- MUST NOT contain duplicate member names.
- MUST use strings, booleans, null, arrays, objects, and integers.
- MUST NOT use floating-point numbers.
- MUST represent decimal or high-precision numeric values as strings if such values are required.

Canonical serialization rules:

- The metadata object MUST be serialized as UTF-8 without BOM.
- Object member names MUST be sorted lexicographically by Unicode code point in ascending order.
- Arrays MUST preserve input order exactly.
- No insignificant whitespace is permitted.
- Strings MUST use JSON escaping required by RFC 8259 and MUST NOT use unnecessary escape sequences for printable ASCII characters other than `"` and `\`.
- Boolean values MUST be serialized as `true` or `false`.
- Null MUST be serialized as `null`.
- Integers MUST be serialized in base-10 without leading `+` and without leading zeros, except for the value `0`.
- Absent metadata MUST be serialized as the empty object `{}`.

The byte string `canonical_metadata_bytes` is the UTF-8 encoding of the canonical JSON serialization.

### 9.3 Signature Message Definition

The signed message for VRI Protocol v1.0 is defined exactly as:

```text
message = SHA-256(
  context_prefix ||
  watermark_payload ||
  audio_hash ||
  timestamp ||
  canonical_metadata
)
```

For avoidance of ambiguity, the concatenated byte sequence MUST be constructed exactly as follows:

- `context_prefix`: the UTF-8 byte string `VRI-SIG-V1\0`.

- `watermark_payload`: the raw 8-byte payload defined in Section 9.1.
- `audio_hash`: the raw 32-byte SHA-256 digest defined in Section 4.5.
- `timestamp`: the full generation timestamp encoded as an unsigned 64-bit big-endian integer representing Unix time in seconds.
- `canonical_metadata`: `metadata_length || canonical_metadata_bytes`, where:
  - `metadata_length` is a 32-bit unsigned big-endian integer equal to the byte length of `canonical_metadata_bytes`.
  - `canonical_metadata_bytes` is the UTF-8 canonical JSON byte sequence defined in Section 9.2.

The result of the concatenation above MUST be hashed once with SHA-256. The resulting 32-byte digest is the `message` value that MUST be signed by Ed25519.

No alternative hash function is allowed in v1.0. No alternative serialization is allowed in v1.0.

### 9.4 Proof Package

The Proof Package MUST be serializable as structured data. JSON is the baseline interoperable representation.

Baseline JSON structure:

```json
{
  "protocol_version": "1.0",
  "compliance_level": 3,
  "watermark_format_version": "1.0",
  "watermark_payload": "base64(...)",
  "watermark_hex": "0x...",
  "audio_hash": "0x...",
  "signature": {
    "algorithm": "Ed25519",
    "value": "0x..."
  },
  "public_key": "0x...",
  "creator_id": "0x...",
  "timestamp": 1711892400,
  "metadata": {
    "model_id": "tts-v3",
    "operation": "voice_synthesis",
    "request_id": "req_123456",
    "tenant_id": "org_789"
  },
  "canonical_metadata": "{\"model_id\":\"tts-v3\",\"operation\":\"voice_synthesis\",\"request_id\":\"req_123456\",\"tenant_id\":\"org_789\"}",
  "usage_event_id": "evt_...",
  "ledger_anchor": "0x...",
  "verification_endpoint": "https://api.vri.app/v1/verify",
  "extensions": {}
}
```

The Proof Package:

- MUST contain sufficient information for independent signature verification.
- MUST contain `protocol_version`.
- MUST contain `audio_hash`.
- MUST contain `watermark_payload`.
- MUST contain `signature.algorithm` and `signature.value`.
- MUST contain `public_key`.
- MUST contain `timestamp`.
- MUST contain `metadata` and `canonical_metadata`.
- MUST contain or reference the corresponding Usage Event for Level 3 compliance.
- SHOULD contain sufficient information to validate ledger anchoring where available.
- MAY contain auxiliary verification hints or policy information.

Anti-ambiguity rules:

- If both `watermark_payload` and `watermark_hex` are present, they MUST decode to identical 8-byte values; otherwise the Proof Package MUST be rejected.
- If both `metadata` and `canonical_metadata` are present, `canonical_metadata` MUST equal the deterministic canonical serialization of `metadata`; otherwise the Proof Package MUST be rejected.
- Implementations MUST reject duplicate member names in Proof Package JSON.
- Implementations MUST reject conflicting critical-field aliases.

Encoding rules:

- Hex values prefixed by `0x` MUST use lowercase hexadecimal.
- `watermark_payload` base64 encoding MUST be standard RFC 4648 base64 with `=` padding.
- `public_key` MUST encode the 32-byte Ed25519 public key.
- `signature.value` MUST encode the 64-byte Ed25519 signature.
- `audio_hash` MUST encode the 32-byte SHA-256 digest.

### 9.5 Usage Event Schema

The Usage Event MUST contain at least:

```json
{
  "event_id": "uuid-or-equivalent",
  "creator_id": "0x...",
  "public_key": "0x...",
  "audio_hash": "0x...",
  "watermark_payload": "base64(...)",
  "timestamp": 1711892400,
  "status": "PENDING|PROCESSING|RECORDED|FAILED",
  "model": "model identifier",
  "provider": "generation provider identifier",
  "metadata": {},
  "ledger_batch_id": "optional batch identifier",
  "ledger_anchor": "optional anchor reference"
}
```

The Usage Event:

- MUST be append-only once committed.
- MUST preserve ordering relative to other committed events.
- MUST use SHA-256 for `audio_hash`.
- SHOULD include model and provider provenance.
- MAY include request-scoped, tenancy-scoped, or deployment-scoped metadata when policy allows.

## 10. Compliance Levels

Implementations claiming conformance MUST declare a compliance level in the Proof Package.

### 10.1 Level 1: Signature-Only

Level 1 requires:

- Canonical Audio generation as defined in Section 4.
- SHA-256 computation of `audio_hash`.
- Deterministic metadata serialization as defined in Section 9.2.
- Signature generation and verification as defined in Section 9.3.
- Proof-carrying output as defined in Section 7.3.

Level 1 does not require watermarking or ledger registration. A Level 1 implementation MUST NOT claim watermark-based audio binding or ledger-backed time integrity.

### 10.2 Level 2: Signature Plus Watermark

Level 2 requires all Level 1 requirements and:

- Watermark embedding before hashing and signing.
- Watermark extraction support during verification.
- Verification behavior that compares extracted watermark payload to the Proof Package watermark payload.

Level 2 does not require ledger registration. A Level 2 implementation MUST NOT claim ledger-backed ordering or external time integrity.

### 10.3 Level 3: Full VRI

Level 3 requires all Level 2 requirements and:

- Usage Event creation and append-only registration.
- Externally anchored ledger support.
- Ledger validation behavior during verification.
- Emission blocking on ledger registration failure as defined in Section 7.4.

Level 3 is the complete VRI conformance profile. Unless explicitly stated otherwise, references to "conforming VRI generation" in this document refer to Level 3 behavior.

## 11. Security Considerations

### 11.1 Watermark Removal

Watermark removal attacks attempt to degrade or eliminate recoverable watermark evidence through filtering, source separation, temporal editing, or re-recording.

Implementations:

- SHOULD use multi-band redundancy.
- SHOULD use temporal spreading.
- SHOULD use perceptual constraints to raise the cost of removal.
- MUST treat recoverability as probabilistic, not absolute.
- MUST document the conditions under which watermark survivability claims are made.

### 11.2 Voice Cloning

VRI does NOT prevent voice cloning. Cloning attacks operate outside the VRI trust boundary.

The protocol provides:

- attribution of VRI-generated artifacts,
- temporal precedence for the earliest verifiable claim of creation,
- stronger evidentiary posture for external enforcement.

The protocol does not provide:

- guaranteed prevention of imitation,
- guaranteed suppression of model-based cloning,
- independent legal enforcement.

### 11.3 Key Compromise

If a private key is compromised, an attacker MAY generate valid signatures for forged artifacts. Therefore:

- Private keys MUST be stored in HSMs, KMS-backed secure modules, or equivalent secure environments.
- Signing systems SHOULD isolate private key operations from general inference runtimes.
- Implementations SHOULD support key rotation and revocation.
- Verifiers SHOULD account for revocation and compromised-key metadata where available.

### 11.4 Inference Bypass

Inference bypass occurs when raw model output is emitted without protocol enforcement.

Mitigations:

- The Inference Adapter MUST define the only valid output enforcement boundary.
- Generation endpoints MUST NOT expose raw audio directly.
- Downstream systems SHOULD accept only proof-carrying artifacts as VRI-compliant outputs.
- Implementations SHOULD use operational attestation, image integrity controls, and deployment verification.

Bypassing the Inference Adapter MUST be considered non-compliant.

### 11.5 Ledger Tampering

Ledger tampering threatens ordering and time integrity.

Mitigations:

- Usage Events MUST be append-only.
- Anchoring commitments SHOULD be externally published periodically.
- Verifiers SHOULD compare claimed events against anchored ledger state.

## 12. Trust Model

VRI distributes verification across independent layers.

### 12.1 Watermark Layer Trust

The Watermark Layer provides signal-bound provenance evidence. It is resilient under many common transformations but not universally recoverable.

### 12.2 Signature Layer Trust

The Signature Layer provides cryptographic proof that the holder of the corresponding private key signed the deterministic message defined by this specification.

### 12.3 Ledger Layer Trust

The Ledger Layer provides ordered append-only registration and externally anchored time integrity. The ledger is not truth. It provides ordering and time integrity and must be combined with signature and watermark evidence for full verification of a presented artifact.

### 12.4 Combined Trust Semantics

No single component is sufficient in isolation:

- Watermark evidence without a valid signature is insufficient.
- A valid signature without corresponding signal evidence MAY indicate provenance of an emitted artifact, but MAY be insufficient to prove integrity of a transformed distributed copy.
- Ledger state without matching audio evidence is insufficient to prove provenance of a presented artifact.

Verification is reproducible because third parties MAY independently:

1. inspect the audio,
2. verify the signature,
3. validate ledger state and anchored ordering.

## 13. Limitations

VRI Protocol v1.0 has explicit limitations.

- It does not prove originality in an abstract or philosophical sense.
- It proves the earliest verifiable claim of creation under the protocol.
- It does not prevent cloning or imitation.
- It does not guarantee watermark recoverability after destructive transformations.
- It does not eliminate the need for external governance, including legal, contractual, and deployment-level action.
- It does not require downstream processing systems to participate, but lack of participation MAY reduce automated discovery and accounting efficiency.

## 14. Economic Considerations

The protocol permits usage accounting and settlement systems to be layered over verified usage events.

Implementations MAY:

- accrue account balances based on verified usage,
- apply service-specific or contract-specific billing policies,
- distinguish between cryptographically verified events and forensic-only detections,
- decline automatic settlement for forensic-only detections.

Accounting systems built on VRI:

- SHOULD treat cryptographically verified usage as higher-assurance events.
- SHOULD treat forensic detection outputs as investigatory signals unless independently confirmed.
- MAY support settlement through fiat or digital asset rails.

## 15. Implementation Considerations

### 15.1 Latency

Implementations SHOULD aim for:

- sub-500 ms critical verification path where watermark evidence is recoverable,
- bounded asynchronous generation overhead where watermarking and signing occur before output emission,
- externally anchored ledger batching that balances time integrity against operational cost.

### 15.2 Streaming

Streaming generation implementations MAY support chunk-based watermarking and incremental hashing, provided that:

- the final externally visible artifact remains proof-carrying,
- the final signature covers the complete emitted artifact semantics,
- incomplete unsigned stream fragments are not misrepresented as protocol-complete outputs,
- the final Proof Package reflects the complete artifact rather than intermediate fragments.

### 15.3 Integration Modes

Implementations MAY support the following modes:

- Wrapper Mode: post-inference adapter around external provider output,
- Embedded Mode: watermarking integrated into local synthesis pipeline,
- Streaming Mode: chunk-based generation with incremental provenance handling.

All modes MUST preserve the normative sequencing of watermarking, signing, and ledger registration before external protocol-complete output.

### 15.4 External Providers

When external generation APIs are used:

- the Inference Adapter MUST still define the trust boundary,
- raw provider output MUST be treated as internal until protocol completion,
- proof generation MUST occur under the control of the conforming VRI implementation.

### 15.5 Replay and Freshness Policy

VRI cryptographic validity does not, by itself, imply freshness.

- Verifiers SHOULD implement a configurable timestamp freshness window.
- Verifiers MAY implement nonce replay tracking scoped by `creator_id`.
- Implementations MUST document replay policy mode in conformance statements.
- If replay policy is enabled and violated, the verifier MUST return an explicit replay/freshness failure outcome.

### 15.6 Interoperability Test Vectors

Conforming implementations MUST validate against a published interoperability corpus.

- The corpus MUST include positive vectors for canonicalization, message construction, signature verification, and ledger-reference validation.
- The corpus MUST include negative vectors for malformed proofs, conflicting fields, unsupported versions, and metadata canonicalization mismatches.
- An implementation claiming conformance MUST publish the corpus version used for validation.

## 16. Conclusion

VRI Protocol v1.0 defines a generation-layer protocol for proof-carrying AI voice artifacts. It combines watermark evidence, deterministic cryptographic signatures, and externally anchored usage records into a single verification model implementable across internal models, external APIs, and open-source runtimes.

The protocol does not eliminate cloning, forgery attempts, or disputes. It makes them more tractable by attaching verifiable provenance at synthesis time, preserving time integrity through immutable records, and enabling independent verification across multiple layers. If audio is generated through VRI, its origin can be verified. If it is not, its legitimacy is uncertain.

## 17. Formal Security Model

### 17.1 Threat Model

VRI is evaluated under a Dolev-Yao-style network adversary extended with media-transformation capabilities.

Attacker capabilities:

1. The attacker MAY read, block, delay, replay, reorder, and inject transport messages.
2. The attacker MAY submit arbitrary audio artifacts and arbitrary proof objects to verifiers.
3. The attacker MAY perform audio transformations including transcoding, resampling, denoising, filtering, clipping, concatenation, re-recording, and model-based re-synthesis.
4. The attacker MAY run independent generation and voice-conversion systems.
5. The attacker MAY attempt field-confusion attacks using conflicting encodings of critical values.
6. The attacker is assumed unable to forge Ed25519 signatures without private-key compromise.
7. The attacker is assumed unable to find practical SHA-256 second-preimage or collision attacks for protocol forgery.

Trust assumptions:

1. Signing private keys are confidential and used only by authorized signing services.
2. Canonicalization and deterministic serialization are implemented exactly as specified.
3. Verifiers enforce fail-closed parsing and reject ambiguous/conflicting critical fields.
4. Freshness/replay policy is applied exactly as declared by the verifier profile.

System boundaries:

1. Inference boundary: watermark insertion, canonicalization, hashing, and signing occur before externally visible output.
2. Verification boundary: cryptographic validity is computed from explicit inputs and deterministic algorithms.
3. Ledger boundary: ledger contributes ordering/time evidence and MUST NOT replace cryptographic artifact validation.
4. Key boundary: authenticity guarantees are contingent on key custody and lifecycle integrity.

### 17.2 Formal Security Properties

Let:

1. `A` be presented audio bytes.
2. `C(A)` be canonical audio transform.
3. `h = SHA-256(C(A))`.
4. `w` be 8-byte watermark payload.
5. `m` be canonical metadata bytes.
6. `t` be timestamp.
7. `(pk, sk)` be Ed25519 keypair.
8. `cid = f(pk)` be deterministic creator derivation.
9. `d = H_msg(w,h,t,m)` be deterministic message digest as defined in Section 9.3.
10. `sig = Sign_sk(d)` be Ed25519 signature.

Authenticity:

1. If verifier outputs `cryptographic_valid = true`, then `Verify_pk(d,sig) = true`.

Integrity:

1. Any modification to bound tuple `(w,h,t,m)` invalidates signature verification except with negligible probability.

Identity binding:

1. Accepted identity requires `creator_id = f(public_key)`.

Metadata consistency:

1. If both `metadata` and `canonical_metadata` are present, they MUST encode the same canonical value.

Determinism:

1. For fixed `(audio, proof_package, verifier_policy)`, verifier outputs are deterministic.

Non-ambiguity:

1. Conflicting duplicate encodings of critical fields are rejected.

Soundness target:

1. `P(accept invalid proof) <= eps_sig + eps_hash + eps_impl`, where cryptographic terms are negligible and `eps_impl` captures implementation defects.

Completeness target:

1. A conformant verifier SHOULD accept conformant proofs under matching policy profile and supported protocol version.

Non-repudiation scope:

1. A valid signature proves action by the holder of `sk`; it does not, by itself, prove legal or human identity.

Replay resistance scope:

1. Replay resistance is profile-dependent unless freshness/nonce checks are mandatory in the selected profile.

### 17.3 Verification Correctness Invariants

The following invariants MUST hold for successful verification:

1. `protocol_version` is present and supported.
2. `audio_hash` equals recomputed `SHA-256(C(A))`.
3. `creator_id` equals deterministic derivation from `public_key`.
4. Signature verifies over exact deterministic message construction.
5. `canonical_metadata` is deterministic and valid under Section 9.2.
6. If both metadata forms are present, they are equivalent.
7. If both watermark encodings are present, they decode to identical 8-byte payloads.
8. Critical-field ambiguity (duplicate names, conflicting aliases, contradictory representations) is rejected.
9. Ledger evidence MUST NOT upgrade an otherwise cryptographically invalid artifact.
10. `trust_level` output is deterministic from verification signals.

### 17.4 MUST-Level Protocol Guarantees

1. Verifiers MUST fail closed when any critical invariant fails.
2. Verifiers MUST reject absent or unsupported `protocol_version` in strict verification mode.
3. Verifiers MUST enforce `creator_id = f(public_key)`.
4. Verifiers MUST reject conflicting `watermark_payload` and `watermark_hex` values.
5. Verifiers MUST reject `metadata` and `canonical_metadata` mismatches.
6. Verifiers MUST validate signatures over exact canonical bytes and message ordering defined in Section 9.3.
7. Verifiers MUST compute `audio_hash` over canonicalized audio only.
8. If replay policy is enabled, verifiers MUST enforce configured freshness/nonce constraints and return explicit replay/freshness failure outcomes.
9. Structured trust outputs MUST follow deterministic mapping rules from `protocol_valid`, `identity_valid`, `metadata_consistent`, `cryptographic_valid`, and watermark state.
10. Ledger validation MUST remain auxiliary to, and never a substitute for, cryptographic verification.

### 17.5 Current Gaps to Full Formal Assurance

The following gaps remain before full mechanized proof claims:

1. Replay/freshness is profile-configurable rather than globally mandatory across all conformance modes.
2. Non-repudiation remains conditional on external key lifecycle governance (rotation, revocation, compromise publication).
3. Watermark recovery is probabilistic under adversarial transforms and cannot be promoted to a universal invariant.
4. Full parser/canonicalization edge-case determinism still requires broader mandatory conformance vectors (Unicode, malformed containers, numeric corner cases).
5. A machine-checked semantics artifact is not yet part of baseline conformance.
