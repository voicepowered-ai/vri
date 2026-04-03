# Wallet And Settlement Scope

This document is intentionally no longer the specification for a core VRI component.

## Scope Clarification

VRI is a verification and provenance infrastructure for audio.

Its core scope is:

- canonical audio hashing
- watermark and proof semantics
- signatures and identity binding
- timestamp attestation
- ledger evidence
- verification and lineage

VRI core does not require:

- platform-specific usage metrics
- downstream pricing rules
- external account destinations
- business-operation providers
- balance tracking

Those belong to an optional business layer built on top of VRI evidence, not to the protocol itself.

## Why This File Changed

Earlier drafts mixed two layers:

1. `VRI core`
   This is the protocol and verification infrastructure.
2. `downstream business product logic`
   This is an optional downstream application that may consume VRI usage evidence.

That coupling created confusion because downstream business rules are not normative parts of the VRI standard.

## Current Status

The former wallet content should be read only as a product-extension concept, not as part of the protocol standard.

For the extension-oriented framing, see:

- [wallet-settlement.md](/home/angell/denoise/vri/docs/wallet-settlement.md)
- [api.md](/home/angell/denoise/vri/docs/api.md)
- [VRI-PROTOCOL-v2.0.md](/home/angell/denoise/vri/VRI-PROTOCOL-v2.0.md)
