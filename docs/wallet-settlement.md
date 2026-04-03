# Business Operations Extension

## Status

Non-normative product extension.

This document describes an optional downstream business layer that may consume VRI usage evidence. It is not part of the VRI core protocol or verifier conformance surface.

## Relationship To VRI Core

VRI can provide evidence that an audio artifact:

- was registered
- was verified
- belongs to a creator key or authorized identity context
- has lineage and timestamp evidence

A downstream system may then use that evidence to support:

- internal accounting
- external business records
- reconciliation workflows
- reporting
- implementation-specific business automation

Those concerns are outside the cryptographic and protocol standard itself.

## Important Boundary

Implementation-specific concepts such as:

- platform-specific usage counts
- payment thresholds
- external rail selection

must be treated as deployment or product policy, not as normative VRI protocol rules.

## Recommended Interpretation

If a team wants to build downstream business workflows on top of VRI, they should model that as:

1. `VRI proof and verification layer`
2. `usage accounting layer`
3. `business policy layer`
4. `external operations layer`

That separation keeps the protocol stable even when downstream business rules change.
