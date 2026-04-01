<p align="center">
  <img src="./assets/banner.png" alt="VRI Banner" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-protocol%20preview-0A1F3D?style=for-the-badge&logo=shield&logoColor=00E5FF" alt="Status Badge">
  <img src="https://img.shields.io/badge/license-Apache%202.0-0A1F3D?style=for-the-badge&logo=apache&logoColor=4FC3F7" alt="License Badge">
  <img src="https://img.shields.io/badge/stars-community%20ready-0A1F3D?style=for-the-badge&logo=github&logoColor=00E5FF" alt="Stars Badge">
</p>

<h1 align="center">VRI · Voice Rights Infrastructure</h1>
<p align="center"><strong>Own. Verify. Monetize voice.</strong></p>
<p align="center">A premium, crypto-inspired protocol layer for registering voice ownership, generating fingerprints, verifying authenticity, and unlocking monetization for AI-native voice assets.</p>

## Tagline

> Own the signal. Verify the source. Monetize the voice.

## What Is VRI

VRI is an enterprise-grade protocol for voice provenance. It gives developers and platforms a clean path from raw voice input to fingerprint generation, cryptographic hashing, registry-backed ownership, verification, and monetization. The result is a system that feels native to AI, media, and Web3 workflows without forcing unnecessary complexity into the product surface.

**Elevator pitch:** VRI turns voice into a verifiable digital asset. By combining fingerprinting, deterministic hashing, registry records, and programmable verification, it helps builders prove who owns a voice, confirm whether an audio artifact is authentic, and connect usage to monetization rails.

## How It Works

```text
Voice -> Fingerprint -> Hash -> Register -> Verify -> Monetize
```

1. `Voice Input`
   Capture a source recording or generated artifact.
2. `Fingerprint`
   Extract a stable representation of the voice signal.
3. `Hash`
   Produce a deterministic cryptographic digest.
4. `Register`
   Store ownership metadata and proof references in a registry layer.
5. `Verify`
   Validate that a voice asset matches its registered identity.
6. `Monetize`
   Connect verified usage to licensing, payments, or access rules.

## Architecture

<p align="center">
  <img src="./assets/architecture.png" alt="VRI architecture placeholder" width="100%">
</p>

```text
┌──────────────┐    ┌────────────────────┐    ┌──────────────┐    ┌───────────────┐    ┌──────────────┐
│ Voice Input  │ -> │ Fingerprint Engine │ -> │  Hash Layer  │ -> │    Registry   │ -> │ API / Tools  │
└──────────────┘    └────────────────────┘    └──────────────┘    └───────────────┘    └──────────────┘
        |                      |                        |                     |                    |
        |                      |                        |                     |                    |
        v                      v                        v                     v                    v
  WAV / MP3 / PCM       Signal features          SHA-256 digest      Ownership record    Verify / monetize
```

Core repository references:

- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md)
- [WHITEPAPER.md](./WHITEPAPER.md)
- [docs/architecture.md](./docs/architecture.md)
- [docs/verification.md](./docs/verification.md)

## Demo

<p align="center">
  <img src="./assets/demo.gif" alt="VRI demo placeholder" width="100%">
</p>

`demo.gif` should show:

1. A developer processing `voice.wav` from the command line.
2. The example tooling returning a fingerprint, hash, and proof payload.
3. A verification request confirming authenticity.
4. A dashboard card indicating the asset is now ready for licensing or royalties.

## Getting Started

Run the included local verification example:

```bash
node examples/verify-audio.js examples/test/audio.wav examples/test/proof.json
```

Expected response:

```text
VALID
```

Generate an example audio artifact:

```bash
node examples/generate-audio.js
```

Start the Node reference API:

```bash
node packages/api/src/server.js
```

Use the Node CLI scaffold:

```bash
node packages/cli/src/index.js register examples/test/audio.wav
```

Reference CLI shape for a future VRI command:

```bash
vri register voice.wav
```

Illustrative response:

```json
{
  "voiceId": "vri_xxx",
  "status": "registered"
}
```

## API Overview

### `registerVoice(file)`

Protocol-facing shape for registering a voice asset:

```json
{
  "voiceId": "vri_xxx",
  "status": "registered",
  "fingerprint": "fp_xxx",
  "audioHash": "sha256_xxx",
  "registry": "vri:testnet"
}
```

### `verifyVoice(id)`

Protocol-facing shape for verifying a registered voice:

```json
{
  "voiceId": "vri_xxx",
  "status": "verified",
  "authenticity": "confirmed",
  "registry": "vri:testnet"
}
```

### CLI

```bash
vri register voice.wav
```

Returns:

```json
{
  "voiceId": "vri_xxx",
  "status": "registered"
}
```

## Example Tooling

The executable code currently lives under [examples/generate-audio.js](./examples/generate-audio.js) and [examples/verify-audio.js](./examples/verify-audio.js). These examples demonstrate the local verification flow already present in the repository without introducing a separate SDK layer.

## Node Architecture

For a native JavaScript implementation path, the repository now includes a lightweight package layout:

- `packages/core`: protocol-safe hashing, fingerprinting, registration, and verification primitives.
- `packages/api`: minimal HTTP surface for register and verify flows.
- `packages/cli`: CLI scaffold for local developer workflows.
- `packages/watermark`: placeholder interface where a future DSP-backed watermark engine can plug in.

## Use Cases

- AI companies registering synthetic voices before commercial deployment.
- Media companies verifying talent-approved voice assets in publishing pipelines.
- Marketplaces enabling licensing and royalty distribution for voice IP.
- Web3 builders anchoring voice proofs to wallets, attestations, or onchain registries.
- Enterprise platforms creating compliance-grade provenance around voice interactions.

## Repository Structure

```text
assets/
  banner.png
  architecture.png
  demo.gif
  logo.png
  logo-readme.png
packages/
  core/
  api/
  cli/
  ledger/
  watermark/
examples/
  generate-audio.js
  verify-audio.js
  proof-package.json
docs/
  architecture.md
  verification.md
  system-overview.md
README.md
package.json
```

## Roadmap

### Core Audio & Cryptography (MVP) ✅
- [x] Publish protocol and whitepaper foundation.
- [x] Add branded repository assets and example tooling references.
- [x] Add local ledger batches and Merkle inclusion proofs.
- [x] **Canonical Audio pipeline** with deterministic resampling (16/24/32-bit PCM WAV, 44.1–96 kHz → 48 kHz).
- [x] **Watermark engine** (Hamming(7,4) ECC, sync word, blind extraction).
- [x] **Key management** with rotation, private key protection, and KMS/HSM adapter support.
- [x] **Production-grade external anchor** publication with HTTP integration and error handling.
- [x] **CLI commands** for querying events, batches, and proofs.
- [x] **API batch publication state** surfaced cleanly in register responses.

### Protocol & Compatibility (In Progress)
- [x] Protocol fixtures and validator for schema compliance.
- [ ] Introduce remote registry integration (mainnet anchor provider).
- [ ] Add service endpoints for proof-package signing and verification with key rotation.
- [ ] Ship reference dashboards for licensing and monetization flows.
- [ ] Expand to wallet-bound claims and programmable access control.

## Tasks

The live implementation task list is tracked in [docs/tasks.md](./docs/tasks.md).

## Vision

Voice is becoming a programmable interface, a commercial asset, and a new category of identity. VRI is designed to become the trust layer beneath that shift: a protocol that lets builders prove ownership, confirm origin, and route value with confidence across AI, media, and crypto-native ecosystems.

## Existing Protocol Material

This repository already contains the deeper protocol specification and companion documents:

- [VRI-PROTOCOL-v1.0.md](./VRI-PROTOCOL-v1.0.md)
- [WHITEPAPER.md](./WHITEPAPER.md)
- [DOCUMENTATION.md](./DOCUMENTATION.md)
- [docs/system-overview.md](./docs/system-overview.md)
- [docs/crypto-spec.md](./docs/crypto-spec.md)
- [docs/watermark-spec.md](./docs/watermark-spec.md)

## License

Apache 2.0
