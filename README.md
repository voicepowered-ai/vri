# VRI: Voice Rights Infrastructure

VRI is a documentation-first release of an inference-layer protocol for cryptographic traceability of AI-generated voice artifacts. The normative source of truth is [`VRI-PROTOCOL-v1.0.md`](./VRI-PROTOCOL-v1.0.md). This repository also includes an explanatory whitepaper, companion technical notes, examples, and a reproducible documentation signing bundle.

## Repository Scope

This repository contains three different kinds of material:

1. **Protocol**: the normative protocol specification.
2. **Reference Architecture**: non-normative design and integration documents.
3. **Release Integrity Material**: authorship metadata, manifest generation, and signature verification scripts for the documentation set itself.

The protocol is real. The architecture material is explanatory. The examples are illustrative. This repository does not claim to provide a production deployment of watermarking, ledgering, usage accounting, or deployment integrations.

VRI is centered on the generation boundary. Its purpose is to give cryptographic traceability to inference-time emitted voice artifacts, not to define downstream publishing or distribution systems.

## Normative Source

The normative specification is:

- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md)

That document defines:

- Canonical Audio,
- `audio_hash`,
- the deterministic signature message,
- Proof Package structure,
- compliance levels,
- failure semantics,
- verification behavior,
- the role of the Inference Adapter and Usage Event.

If any companion document differs from the protocol, the protocol controls.

## Repository Contents

### Protocol

- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md): normative specification.
- [WHITEPAPER.md](./WHITEPAPER.md): explanatory rationale and trust model.

### Reference Architecture

- [DOCUMENTATION.md](./DOCUMENTATION.md): repository index.
- [docs/system-overview.md](./docs/system-overview.md): high-level system walkthrough.
- [docs/architecture.md](./docs/architecture.md): reference architecture notes.
- [docs/crypto-spec.md](./docs/crypto-spec.md): protocol-aligned cryptographic companion.
- [docs/verification.md](./docs/verification.md): protocol-aligned verification companion.
- [docs/watermark-spec.md](./docs/watermark-spec.md): watermark design notes.
- [docs/data-model.md](./docs/data-model.md): storage and schema notes.
- [docs/threat-model.md](./docs/threat-model.md): attack surface discussion.

### Release Integrity

- [AUTHORS.json](./AUTHORS.json): authorship metadata.
- [PUBLIC_KEY.pem](./PUBLIC_KEY.pem): release verification key.
- [MANIFEST.sha256](./MANIFEST.sha256): deterministic file hash manifest.
- [MANIFEST.sig](./MANIFEST.sig): Ed25519 signature over the manifest.
- [RELEASE.json](./RELEASE.json): release metadata bound to the signing identity.
- [sign_docs.sh](./sign_docs.sh): manifest and signing script.
- [verify_docs.sh](./verify_docs.sh): verification script.

## Implementation Status

- Protocol: ✅ defined.
- Whitepaper: ✅ aligned to the protocol.
- Documentation signing bundle: ✅ implemented in this repository.
- Reference implementation of watermarking: ⚠️ design material only.
- Verification service: ⚠️ design material only.
- SDKs: ❌ not implemented in this repository.
- Deployment integrations: ❌ not implemented.
- Ledger and usage accounting services: ❌ not implemented.

## Security Model Summary

VRI provides cryptographic traceability at the inference boundary and distributes verification across three layers:

- **Watermark**: probabilistic signal-bound provenance evidence.
- **Signature**: deterministic Ed25519 validation over the protocol-defined message.
- **Ledger**: append-only ordering and time integrity for Level 3 claims.

The ledger is not truth by itself. Watermark recovery is not guaranteed. Cloning prevention is outside the protocol boundary. Trust is derived from public key ownership, reproducible verification, and protocol-defined serialization.

## Verification

Generate the signed documentation bundle:

```bash
./sign_docs.sh
```

Verify the signature over the manifest:

```bash
openssl pkeyutl -verify -pubin -inkey PUBLIC_KEY.pem -rawin -in MANIFEST.sha256 -sigfile MANIFEST.sig
```

Verify file integrity against the signed manifest:

```bash
sha256sum -c MANIFEST.sha256
```

Run the full verification flow:

```bash
./verify_docs.sh
```

## Local Verification Example

The repository includes a minimal local reference verifier for VRI Protocol v1.0.

Run:

```bash
node examples/verify-audio.js examples/test/audio.wav examples/test/proof.json
```

Expected output:

```text
VALID
```

For debug output:

```bash
node examples/verify-audio.js examples/test/audio.wav examples/test/proof.json --verbose
```

This verifier demonstrates a minimal reproducible verification flow:

- load a WAV audio artifact,
- extract raw PCM bytes from the WAV `data` chunk,
- compute `SHA-256` over the PCM payload,
- reconstruct the protocol message digest,
- verify the Ed25519 signature in the proof package.

This example does not implement watermark extraction or ledger validation.

## Authorship & Integrity

This documentation set is authored and cryptographically signed by:

Ángel López Morales  
angel.lopez@voicepowered.ai

Verification:

```bash
./verify_docs.sh
```

Trust is derived from:

- public key ownership
- reproducible manifest
- verifiable signature

## Publishing Notes

This repository is suitable for public publication as a protocol and documentation release. It should not be described as a deployed service or as a complete production implementation of the VRI ecosystem.

## License

Apache 2.0
