<p align="center">
  <img src="./assets/banner.png" alt="VRI Banner" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/status-protocol%20v1.0-0A1F3D?style=for-the-badge&logo=shield&logoColor=00E5FF" alt="Status Badge">
  <img src="https://img.shields.io/badge/license-Apache%202.0-0A1F3D?style=for-the-badge&logo=apache&logoColor=4FC3F7" alt="License Badge">
  <img src="https://img.shields.io/badge/verifier-reference%20implementation-0A1F3D?style=for-the-badge&logo=nodedotjs&logoColor=00E5FF" alt="Verifier Badge">
</p>

# VRI · Voice Rights Infrastructure

Protocol for verifiable audio generation and independent proof verification.

VRI does not detect audio. It verifies cryptographic proof attached to it.

## Quick Navigation

- [1) What VRI Actually Is](#1-what-vri-actually-is)
- [2) The Problem](#2-the-problem)
- [3) The Solution](#3-the-solution)
- [4) How It Works (Real Flow)](#4-how-it-works-real-flow)
- [5) Core Concepts](#5-core-concepts)
- [6) Verification Model](#6-verification-model)
- [7) Security and Formal Assurance](#7-security-and-formal-assurance)
- [8) Architecture](#8-architecture)
- [9) What This Repo Contains](#9-what-this-repo-contains)
- [10) What Is Not Included](#10-what-is-not-included)
- [11) Demo (Input -> Audio -> Proof -> Verify VALID)](#11-demo-input---audio---proof---verify-valid)
- [12) Roadmap](#12-roadmap)
- [13) Additional Docs](#13-additional-docs)

## 1) What VRI Actually Is

VRI is a protocol for generating and verifying cryptographic proofs for audio produced by AI systems.

At its core, VRI defines a reproducible proof path:

- deterministic audio hash
- watermark payload (embedded at inference time when VRI mode is enabled)
- Ed25519 signature
- proof package JSON

The Node.js code in this repository is a reference verifier and protocol implementation. It is not an audio generation engine.

## 2) The Problem

Current audio pipelines often cannot answer basic trust questions deterministically:

- Who generated this audio?
- Was the generation authorized?
- Can a third party verify the claim without trusting the generator?

Without deterministic verification, provenance claims become policy statements instead of technical guarantees.

## 3) The Solution

VRI defines a proof package that can be verified independently.

Verification uses public data (audio + proof package + public key material) and deterministic checks. No hidden server state is required for the core cryptographic validation path.

VRI does not detect audio. It verifies cryptographic proof attached to it.

## 4) How It Works (Real Flow)

```text
Inference Engine
  -> Audio Generation
  -> Watermark Injection (runtime; required for full VRI compliance)
  -> Proof Generation (audio hash + signature)
  -> External Verification
```

Important boundary:

- watermark injection happens during generation (inference runtime)
- verification can happen later, offline, by independent parties
- this repository provides reference verification and protocol tooling

## 5) Core Concepts

### Audio Hash

SHA-256 over canonical PCM bytes. Canonicalization is deterministic so equivalent inputs produce the same digest under the same rules.

### Watermark Payload

Fixed-length embedded payload used as a cryptographic carrier in VRI-enabled generation mode.

### Signature

Ed25519 signature over the protocol message digest derived from canonical metadata, hash, watermark payload, and timestamp fields.

### Proof Package

Canonical JSON document containing verification material (hash, signature, metadata, key references, and protocol fields).

## 6) Verification Model

Verification is deterministic and reproducible:

- parse proof package fields
- recompute canonical audio hash
- recompute message digest
- verify Ed25519 signature

Core cryptographic verification works without blockchain and can run offline.
When Level 3 ledger claims are present, verifiers additionally validate the referenced usage event and anchor evidence.

VRI does not detect audio. It verifies cryptographic proof attached to it.

## 7) Security and Formal Assurance

### 7.1 Verification Security Hardening (Implemented)

The reference verifier is now fail-closed for critical proof fields.

- `protocol_version` is required and validated (`1.0` in the strict path).
- `creator_id` is re-derived from `public_key` and enforced.
- `canonical_metadata` must match `metadata` when both are present.
- Conflicting watermark fields (`watermark_hex` vs `watermark_payload`) are rejected.

`/verify-proof` also returns structured trust signals:

- `cryptographic_valid`
- `watermark`: `present` | `missing` | `degraded` | `not_applicable`
- `identity_valid`
- `metadata_consistent`
- `protocol_valid`
- `trust_level`: `HIGH` | `PARTIAL` | `LOW`

Operational hardening included in the API and anchoring boundary:

- Request body and audio size limits (memory DoS protection).
- External anchor publication protections (SSRF controls, endpoint policy, network checks).
- External request timeout and response-size caps.
- Optional freshness and nonce replay checks for verification policy.

### 7.2 Formal Assurance Scope

A production-hardened implementation is not the same as a formally complete protocol proof.

For formal completeness, VRI tracks three explicit deliverables:

- Explicit threat model: attacker classes, trust boundaries, and assumptions.
- Formal properties: soundness and completeness statements for verification outcomes.
- Formal methods artifact: proof sketch, mechanized verification, or equivalent model checking.

Current status:

- Implementation hardening: implemented.
- Normative protocol specification: implemented.
- Formal threat model and property proofs: planned work.

This distinction is intentional: VRI currently provides deterministic, reproducible verification behavior, while formal proofs remain a dedicated milestone.

## 8) Architecture

### Inference Runtime (Not in this repo)

System that generates audio and injects watermark payload during runtime.

### Reference Verifier (This repo)

Node.js reference implementation for canonicalization, proof generation/validation logic, API surface, CLI, and interoperability tests.

### Optional Ledger

Append-only event and batch anchoring utilities for auditability. Useful for operations, not required for cryptographic proof verification itself.

## 9) What This Repo Contains

- Protocol specification and companion docs
- Node.js reference verifier and core cryptographic flow
- CLI and HTTP API for register/verify/proof workflows
- Optional ledger and batch anchoring components
- Examples and fixtures for interoperability tests

Key files and directories:

- [VRI-PROTOCOL-v1.0.md](VRI-PROTOCOL-v1.0.md)
- [docs](docs)
- [packages/core](packages/core)
- [packages/api](packages/api)
- [packages/cli](packages/cli)
- [packages/ledger](packages/ledger)
- [examples](examples)
- [fixtures](fixtures)

## 10) What Is Not Included

- No full inference engine or TTS runtime
- No production monetization platform
- No turnkey platform integration layer

The repository focuses on verifiable proof mechanics, reference verification, and protocol interoperability.

## 11) Demo (Input -> Audio -> Proof -> Verify VALID)

### Local verifier against fixture

```bash
node examples/verify-audio.js examples/test/audio.wav examples/test/proof.json
```

Expected output:

```text
VALID
```

### API and CLI quickstart

Start API:

```bash
node packages/api/src/server.js
```

Register via CLI:

```bash
node packages/cli/src/index.js register examples/test/audio.wav
```

Verify via CLI:

```bash
node packages/cli/src/index.js verify examples/test/audio.wav examples/test/proof.json
```

### Run test suite

```bash
npm test
```

## 12) Roadmap

### Current Priority

- [x] Proof package generation aligned with protocol message format
- [x] Canonical metadata serialization
- [x] Local append-only usage-event ledger
- [x] Local batch anchoring with Merkle roots
- [x] Merkle inclusion proofs per event
- [x] External anchor publication for batches
- [x] Canonical Audio deterministic normalization
- [x] Production watermark engine (inference-facing primitive)
- [x] Key management and signer rotation strategy

### MVP

- [x] Deterministic resampling for non-48 kHz inputs
- [x] Float32 IEEE PCM WAV support alongside 16/24-bit
- [x] Batch publication state in API responses
- [x] CLI support for events, batches, proofs
- [x] Protocol fixtures and compatibility docs

### Beta

- [x] Storage abstraction (JSONL, Memory, Postgres, MongoDB)
- [x] MongoDB as beta default reference backend
- [x] Audit logging for register/verify/anchoring events
- [x] API key auth and role-based access control
- [x] Multitenancy with organization quotas
- [x] Background anchoring scheduler with retry policy
- [x] Profiling for DSP-heavy paths

### Production

- [x] Worker-thread DSP acceleration (DspPool)
- [x] KMS/HSM signing adapter and coverage
- [x] External batch publication with confirmation tracking
- [x] Compliance and interoperability suite against fixtures

### Next Milestones

- [ ] Remote registry integration (mainnet anchor provider)
- [ ] Service endpoints for proof-package signing and verification with key rotation
- [ ] Reference dashboards for licensing and monetization flows
- [ ] Wallet-bound claims and programmable access control
- [ ] Publish explicit protocol threat model and adversary assumptions
- [ ] Specify soundness/completeness properties for verifier outcomes
- [ ] Add formal verification artifact (proof sketch/model checking/mechanized subset)

Live implementation checklist: [docs/tasks.md](docs/tasks.md)

## 13) Additional Docs

- [DOCUMENTATION.md](DOCUMENTATION.md)
- [docs/system-overview.md](docs/system-overview.md)
- [docs/crypto-spec.md](docs/crypto-spec.md)
- [docs/watermark-spec.md](docs/watermark-spec.md)
- [docs/verification.md](docs/verification.md)

## License

Apache-2.0
