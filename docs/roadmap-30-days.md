# 30-Day Execution Roadmap

This document captures the immediate execution plan for the next visible phase of VRI.

The priority order is:

1. close the Whitepaper v2.0 (aligned with session-based model),
2. ship a manual web verifier,
3. build a first VST/AU prototype for studio workflows.

The intent is to strengthen three things in sequence:

- technical credibility,
- public demonstrability,
- workflow adoption.

---

## Completed: Session-Based Architecture (pre-roadmap)

The following items are already implemented and tested as of the current codebase:

- **RecordingSession entity** — links every generated audio to an actor identity, studio context, and activation method
- **QR session activation** — `POST /recording-sessions` with `from_qr: true` sets `session_verified: true`
- **Pre-inference Gate 1** — `requireVerifiedSession`: rejects GENERATED proofs without a QR-verified session
- **Pre-inference Gate 2** — `requireInputVerification`: rejects GENERATED proofs whose source audio wasn't registered as `RECORDED` in this system
- **InferenceMetadata signing** — `model_id`, `actor_id`, `session_id` embedded in `canonical_metadata` before Ed25519 signing
- **107/107 tests passing**

---

## 1. Whitepaper v2.0

**Goal**: make the whitepaper the public technical constitution of VRI.

**Target window**: Week 1

**Definition of done**:

- `WHITEPAPER.md` fully aligned with `VRI-PROTOCOL-v2.0.md`
- mode separation (`RECORDED` / `GENERATED`) clearly explained
- compliance 1/2/3 clearly explained
- identity, timestamping, and Level 3 evidence clearly explained- session-based model (RecordingSession, InferenceMetadata, pre-inference gates) clearly explained- limits and non-claims stated explicitly
- public-facing language suitable for technical, legal, and partner review

**Key deliverables**:

- final whitepaper text
- short executive summary for partners and investors
- explicit “what VRI guarantees / does not guarantee” framing

---

## 2. Web Verifier

**Goal**: allow any beta audio artifact to be manually validated from a public-facing interface.

**Target window**: Week 2

**Definition of done**:

- user can upload audio and proof package
- verifier returns `VALID`, `PARTIAL`, or `LOW`
- key fields are displayed clearly:
  - `proof_type`
  - `compliance_level`
  - watermark status
  - identity status
  - timestamp / ledger evidence
  - lineage when present
  - `session_id`, `actor_id`, `inference_metadata` when present in the proof
- failure reasons are readable and fail-closed

**Key deliverables**:

- minimal web UI
- API integration with existing verifier
- demo-ready fixture flow
- basic error telemetry

---

## 3. VST/AU Prototype

**Goal**: demonstrate serious studio-path integration for professional recording workflows.

**Target window**: Weeks 3-4

**Definition of done**:

- first plugin prototype runs inside a DAW
- supports a minimal `RECORDED` flow with session activation
- can create a `RecordingSession` (QR or manual) and pass `session_id` to the proof
- can prepare or emit proof-related output tied to the session/export boundary
- produces reproducible output for at least one controlled demo workflow

**Suggested first scope**:

- focus on `RECORDED`, not `GENERATED`
- hash canonical audio at export or capture boundary
- call `POST /recording-sessions` at session start; embed `session_id` in proof
- prepare proof payload and metadata
- integrate local signing or API-assisted signing
- export proof package alongside audio

**Key deliverables**:

- DAW-compatible prototype
- demo session with session activation + RECORDED proof
- documented scope boundaries for v1 of the plugin

---

## Execution Notes

- The whitepaper should be closed before major partner outreach.
- The web verifier should ship before broad beta storytelling.
- The plugin should prove workflow fit, not feature completeness.

Avoid these traps:

- overbuilding the first plugin,
- changing protocol semantics while building product integrations,
- presenting probabilistic or partial evidence as stronger than it is,
- mixing protocol core with downstream business logic.
