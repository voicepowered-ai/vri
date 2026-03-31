# Legal Position Statement

## Status

This repository publishes a protocol specification, companion documentation, and a documentation integrity bundle. It does not, by itself, create legal rights, grant regulatory approval, or determine legal ownership of any voice, model, dataset, or generated artifact.

## Purpose of VRI

VRI is intended to provide technical provenance evidence for AI-generated voice artifacts at the generation boundary.

In particular, VRI is designed to support:

- technical attribution,
- integrity verification,
- reproducible signature validation,
- signal-bound provenance evidence where watermark recovery is successful,
- and ordered event recording where a ledger is used.

## What VRI Can Support

Where correctly implemented and operated, VRI may support evidentiary claims such as:

- a given artifact was emitted by a system controlling a particular signing key,
- a given Proof Package is consistent with a defined signing procedure,
- a given artifact matches the canonical audio representation used for hashing and signing,
- a given Usage Event was recorded in an append-only system with time-ordering semantics.

These are technical claims. They are not, by themselves, definitive legal conclusions.

## What VRI Does Not Establish By Itself

VRI does not, by itself, establish:

- absolute legal ownership,
- authorship in a copyright-law sense,
- consent,
- license scope,
- regulatory compliance,
- admissibility in court,
- validity of a contract,
- or exclusivity of a voice or vocal style.

VRI also does not prevent:

- cloning,
- imitation,
- resynthesis,
- copying,
- or downstream misuse.

## Public Key and Identity

Within VRI, trust is anchored in control of the signing key.

This means:

- a valid signature supports the proposition that the corresponding private key was used,
- `creator_id` is only a compact identifier derived from the public key,
- and human identity, legal identity, or corporate authority must be established through separate processes if needed.

## Watermark Evidence

Watermark evidence is probabilistic and signal-dependent.

Accordingly:

- successful watermark recovery may strengthen a provenance claim,
- failed watermark recovery does not necessarily prove absence of prior protocol participation,
- and watermark evidence should not be represented as perfect, universal, or guaranteed under hostile transformation conditions.

## Ledger Evidence

Ledger evidence supports ordering and time integrity. It is not an oracle of truth.

A ledger record does not, by itself, prove that a presented artifact is authentic. For full technical verification, ledger evidence must be interpreted together with signature evidence and, where available, watermark evidence.

## Recommended Legal Interpretation

The most defensible legal framing for VRI is:

> VRI provides technical provenance evidence that may be used as part of a broader evidentiary record.

The least defensible framing is:

> VRI proves legal ownership or prevents unauthorized voice use.

## Operational Recommendation

Any entity deploying VRI in a commercial, contractual, or regulated environment should obtain jurisdiction-specific legal advice on:

- evidentiary use,
- consumer disclosures,
- privacy obligations,
- biometric or voice-related regulation,
- contract drafting,
- and incident response for key compromise or disputed provenance.
