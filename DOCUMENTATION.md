# VRI Documentation Index

This index separates normative protocol material from non-normative reference documentation and release-integrity tooling for an inference-layer traceability protocol.

## Normative Protocol

- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md): authoritative protocol specification.

The protocol defines the required meaning of:

- Proof Package,
- Canonical Audio,
- Usage Event,
- Inference Adapter,
- `audio_hash`,
- deterministic signature construction,
- compliance levels.

## Explanatory Material

- [WHITEPAPER.md](./WHITEPAPER.md): rationale, trust model, and scope.
- [docs/crypto-spec.md](./docs/crypto-spec.md): cryptographic companion aligned to the protocol.
- [docs/verification.md](./docs/verification.md): verification companion aligned to the protocol.
- [docs/threat-model.md](./docs/threat-model.md): attack analysis and mitigations.

These documents are explanatory. They do not override the protocol.

## Reference Architecture

- [docs/system-overview.md](./docs/system-overview.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/inference-integration.md](./docs/inference-integration.md)
- [docs/data-model.md](./docs/data-model.md)
- [docs/watermark-spec.md](./docs/watermark-spec.md)
- [docs/api.md](./docs/api.md)

These files describe reference designs, possible deployment patterns, and companion notes. They are not evidence of a deployed production system.

## Examples

- [examples/generate-audio.js](./examples/generate-audio.js)
- [examples/verify-audio.js](./examples/verify-audio.js)
- [examples/proof-package.json](./examples/proof-package.json)

Examples are illustrative and may omit production controls, service implementations, or integration dependencies.

## Release Integrity Material

- [AUTHORS.json](./AUTHORS.json)
- [PUBLIC_KEY.pem](./PUBLIC_KEY.pem)
- [RELEASE.json](./RELEASE.json)
- [MANIFEST.sha256](./MANIFEST.sha256)
- [MANIFEST.sig](./MANIFEST.sig)
- [sign_docs.sh](./sign_docs.sh)
- [verify_docs.sh](./verify_docs.sh)

These files provide reproducible verification of the documentation release itself.

## Implementation Status

- Protocol: ✅ defined.
- Documentation signing bundle: ✅ implemented.
- Reference implementation of watermarking: ⚠️ partial and non-normative.
- Reference implementation of verification services: ⚠️ partial and non-normative.
- SDKs: ❌ not implemented in this repository.
- Deployment integrations: ❌ not implemented.

## Reading Order

1. [README.md](./README.md)
2. [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md)
3. [WHITEPAPER.md](./WHITEPAPER.md)
4. [docs/crypto-spec.md](./docs/crypto-spec.md)
5. [docs/verification.md](./docs/verification.md)
6. [docs/threat-model.md](./docs/threat-model.md)
