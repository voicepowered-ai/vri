# VRI Documentation Index

This index separates normative protocol material from non-normative reference documentation and release-integrity tooling for a system-level audio provenance standard.

## Normative Protocol

- [VRI-PROTOCOL-v2.0.md](./VRI-PROTOCOL-v2.0.md): authoritative protocol specification.
- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md): legacy protocol specification retained for historical reference.

The protocol defines the required meaning of:

- Proof Package,
- Canonical Audio,
- proof types,
- compliance levels,
- identity and timestamp-attestation binding,
- Usage Event,
- capture/generation enforcement boundaries,
- `audio_hash`,
- deterministic signature construction,
- verifier behavior.

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
- System-level `v2.0` semantics: ✅ defined.
- Documentation signing bundle: ✅ implemented.
- Reference implementation of watermarking: ✅ implemented in the Node reference packages (non-normative).
- Reference implementation of verification services: ✅ implemented in the local Node API (non-normative).
- Identity-bound QR session model: ✅ implemented in the Node API and core verifier.
- Level 3 timestamp-attestation flow: ✅ implemented in the reference API and verifier, with normalized RFC 3161 support.
- SDKs: ⚠️ partial (CLI and package modules available; standalone multi-language SDKs are not included).
- Deployment integrations: ⚠️ partial (local and pluggable storage backends plus external anchor publication are implemented; production cloud deployment blueprints and shared-state deployments are still in progress).
- Formal verification artifact: ⚠️ planned (threat model and property statements are present; mechanized proof work is not yet shipped).

## Next Milestones

- [ ] Introduce remote registry integration (mainnet anchor provider).
- [ ] Expand to identity-bound claims and programmable access control.
- [ ] Add multi-instance shared-state backends for replay, session, and revocation data.
- [ ] Publish production deployment profiles for TSA/PKI and operational trust policy.
- [ ] Ship formal verification artifact for verifier properties.

## Reading Order

1. [README.md](./README.md)
2. [VRI-PROTOCOL-v2.0.md](./VRI-PROTOCOL-v2.0.md)
3. [WHITEPAPER.md](./WHITEPAPER.md)
4. [docs/crypto-spec.md](./docs/crypto-spec.md)
5. [docs/verification.md](./docs/verification.md)
6. [docs/threat-model.md](./docs/threat-model.md)
