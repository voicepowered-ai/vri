# Evidentiary Notes

## Purpose

This document explains how VRI evidence should be understood at a high level when used in audit, dispute, compliance, or review contexts.

It is not legal advice. It is a technical interpretation note.

## Evidence Layers

VRI uses multiple evidence layers that should be evaluated together.

### 1. Signature Evidence

Signature evidence supports the claim that:

- a private key corresponding to a declared public key signed the protocol-defined message,
- and the signed fields were serialized and hashed according to the protocol.

Signature evidence does not, by itself, establish:

- legal ownership,
- human identity,
- or integrity of a transformed copy if the presented artifact no longer matches the originally emitted artifact.

### 2. Watermark Evidence

Watermark evidence supports the claim that:

- provenance data was embedded into the audio artifact,
- and the presented audio still retains recoverable signal-bound evidence.

Watermark evidence is probabilistic and transformation-sensitive.

### 3. Ledger Evidence

Ledger evidence supports the claim that:

- a Usage Event was recorded,
- event ordering was preserved,
- and time integrity may be checked against an append-only record and, where implemented, an external anchor.

Ledger evidence is not sufficient by itself to authenticate a presented artifact.

## Strongest Technical Case

The strongest technical provenance case is present when:

- the presented artifact yields a matching recovered watermark payload,
- the Proof Package verifies successfully,
- the signature validates against the declared public key,
- and the Usage Event is consistent with ledger state.

## Weaker but Still Relevant Cases

A weaker but still meaningful case may exist when:

- the Proof Package validates,
- the signature is valid,
- but watermark recovery fails because the artifact has been transformed after emission.

In such a case, the evidence may still support provenance of the originally emitted artifact, while providing weaker support for integrity of the transformed presented copy.

## Probabilistic Signals

Forensic similarity or acoustic matching should be treated as investigatory support only.

Such signals:

- may justify further review,
- may help cluster related artifacts,
- but should not be represented as equivalent to cryptographic verification.

## Suggested Evidentiary Framing

The safest technical framing is:

> VRI evidence contributes to a provenance record.

It should not be framed as:

> a complete and self-sufficient proof of legal entitlement.

## Recommended Supporting Material

Where VRI evidence may matter in a formal dispute, it is advisable to preserve:

- the original emitted artifact,
- the Proof Package,
- the public key record,
- the signing and verification software version,
- the relevant manifest and release metadata,
- and any key-management or audit logs available under applicable policy.
