# Implementation Tasks

## Current Priority

- [x] Proof package generation aligned with the VRI message format
- [x] Canonical metadata serialization
- [x] Local append-only usage-event ledger
- [x] Local batch anchoring with Merkle roots
- [x] Merkle inclusion proofs per event
- [x] External anchor publication for batches
- [x] Canonical Audio resampling to deterministic 48 kHz normalization
- [x] Production watermark engine with robust embedding and extraction
- [x] Key management and signer rotation strategy

## MVP Remaining

- [x] Deterministic resampling for non-48 kHz inputs
- [x] Wider audio input support: float32 IEEE PCM WAV in addition to 16/24-bit
- [x] Batch publication state surfaced cleanly in API responses
- [x] CLI commands for `events`, `batches`, and `proofs`
- [x] Protocol compatibility fixtures and documentation

## Beta Track

- [x] External anchoring integration shape beyond simulation
- [ ] Reference storage backend beyond local JSONL files
- [ ] Auth, multitenancy, and audit logging
- [ ] Background anchoring scheduler and retry policy
- [ ] Performance profiling for DSP-heavy paths

## Production Track

- [x] Robust watermarking with ECC, synchronization, and transform resistance
- [ ] Worker Thread or WASM acceleration for DSP kernels
- [ ] KMS/HSM-backed signing flow
- [x] External batch publication with confirmation tracking
- [ ] Compliance and interoperability test suite against protocol fixtures
