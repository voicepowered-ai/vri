# Identity Layer for VRI v2.0

## Purpose

This document defines the VRI identity layer based on QR bootstrapping and Secure Enclave-backed signing.

The identity layer complements the core VRI proof model. It does not replace:

- the audio-bound watermark layer,
- the artifact integrity signature,
- or timestamp and ledger evidence.

---

## IdentitySession vs RecordingSession

VRI v2.0 has two distinct session concepts that serve different purposes and are often confused:

### IdentitySession (this document)

`IdentitySession` is a **cryptographic device-identity bootstrap mechanism**. It proves that a specific mobile device (identified by a Secure Enclave-backed key) authorized a session challenge at a specific time.

- Created via: `POST /identity/challenges` + `POST /identity/redeem`
- Scope: `recording`, `generation`, `export`
- Key property: the device private key never leaves the hardware
- Single-use: consumed after one proof issuance in its declared scope
- Surviving fields in proof: `identity.auth_method`, `identity.session_id`, `identity.public_key`, `identity.signature`
- Use case: cryptographic proof that a specific mobile device was present and authorized an action

### RecordingSession (new in v2.0, see [data-model.md](data-model.md))

`RecordingSession` is a **recording context entity** that links a voice actor to a recording session for AI provenance traceability.

- Created via: `POST /recording-sessions`
- Key property: `session_verified: true` is set only for QR-activated sessions (`from_qr: true`)
- Reusable within a recording session (not single-use)
- Surviving fields in proof: `session_id`, `actor_id` (inside signed `canonical_metadata`)
- Use case: traceability — prove WHO was the voice actor in WHICH session that generated a given audio artifact

### How They Relate

| | IdentitySession | RecordingSession |
|---|---|---|
| Purpose | Device-level cryptographic authorization | Recording context for AI provenance |
| Created by | QR + Secure Enclave mobile app | Studio-side call to `/recording-sessions` |
| QR activation | Required (core mechanism) | Optional (`from_qr: true` sets `session_verified: true`) |
| Single-use | Yes (for proof issuance) | No (covers full recording session) |
| Signed into proof | `identity` object hash | `session_id`, `actor_id` in `canonical_metadata` |
| Required for inference | Optional (via `registerRequireAuthorizedIdentitySession`) | Optional (via `requireVerifiedSession`) |

In high-security deployments, both can be used together: the actor activates a `RecordingSession` via QR (setting `session_verified: true`), AND includes an `IdentitySession` assertion in each proof request for device-level non-repudiation.

---

## 1. Protocol Flow

### 1.1 Challenge Creation

The verifier, such as a DAW plugin or API gateway, creates a challenge containing:

- `verifier_origin`
- `session_id`
- `nonce`
- `session_scope`
- `session_expires_at`
- `session_public_key`

Requirements:

- `session_id` MUST be generated from a cryptographically secure RNG.
- `nonce` MUST be generated from a cryptographically secure RNG.
- `session_expires_at` MUST be bounded.
- `session_public_key` MUST be unique per authorized session.

### 1.2 QR Bootstrap

The challenge is encoded into the QR payload.

The mobile authenticator MUST:

- verify `verifier_origin`,
- reject untrusted origins,
- and refuse to sign if the challenge is expired or malformed.

### 1.3 Mobile Signing

The mobile device constructs the unsigned identity assertion:

```json
{
  "auth_method": "QR_SECURE_ENCLAVE",
  "verifier_origin": "https://studio.vri.example",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "nonce": "base64(...)",
  "session_scope": ["recording"],
  "session_public_key": "0x...",
  "public_key": "0x...",
  "session_timestamp": 1774992800,
  "session_expires_at": 1774993100,
  "device_attested": true,
  "attestation": {}
}
```

The device signs the canonical unsigned assertion using the Secure Enclave-backed private key.

The private key MUST NOT leave the device.

### 1.4 Verifier Authorization

The verifier receives the signed identity object and MUST:

1. verify the device signature,
2. verify origin trust,
3. verify `session_id` uniqueness,
4. verify `nonce` freshness,
5. verify `session_public_key` equality with the challenge,
6. verify `session_expires_at`,
7. verify attestation when `device_attested = true`,
8. persist the authorized session state.

If any check fails, the session MUST NOT be authorized.

Authorized session semantics:

- an authorized session MUST be bound to its declared `session_scope`,
- an authorized session MUST be single-use for proof issuance,
- a verifier MUST reject use of a session outside its declared scope,
- and a verifier MUST transition a successfully used session into a terminal consumed state.

### 1.5 Proof Binding

When a proof is created, the VRI proof signature binds:

- proof type,
- compliance level,
- watermark state and payload when applicable,
- canonical audio hash,
- timestamp,
- canonical metadata,
- and SHA-256 of the full canonical `identity` object when present.

This prevents an attacker from swapping identity objects after proof creation.

## 2. Proof Package Extension

The `identity` object is embedded in the Proof Package:

```json
{
  "identity": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "verifier_origin": "https://studio.vri.example",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "nonce": "base64(...)",
    "session_scope": ["recording", "export"],
    "session_public_key": "0x...",
    "public_key": "0x...",
    "session_timestamp": 1774992800,
    "session_expires_at": 1774993100,
    "device_attested": true,
    "attestation": {},
    "signature": "0x..."
  }
}
```

Semantics:

- `public_key` is the device identity key.
- `session_public_key` is the ephemeral session authorization key.
- `signature` is the device signature over the unsigned identity assertion.

Strict identity profile:

- `identity` is REQUIRED.

Compatibility profile:

- `identity` MAY be absent.

## 3. Verification Logic

Identity verification is separate from artifact verification, but both are required in identity-strict deployments.

Verifier steps:

1. canonicalize the unsigned identity assertion
2. compute `SHA-256("VRI-ID-QR-V1\\0" || len || canonical_unsigned_identity)`
3. verify the device signature with `identity.public_key`
4. verify `verifier_origin`
5. verify session freshness and expiry
6. verify session challenge bindings when operating online
7. verify device attestation evidence when claimed
8. verify authorization state and required `session_scope` when operating online
9. consume the authorized session after a successful scope-matched proof issuance
10. verify the proof signature, which binds the canonical `identity` object hash

## 4. Security Guarantees

When correctly implemented, the identity layer provides:

- passwordless session bootstrap,
- no private-key export from the mobile device,
- verifier-authenticated session authorization,
- replay resistance for online authorization,
- and proof-level binding between identity session and artifact proof.

## 5. Attack Resistance

### QR Replay

Prevented by:

- fresh `session_id`,
- fresh `nonce`,
- expiry,
- and verifier-side session state.

### QR Substitution / Phishing

Prevented by:

- trusted `verifier_origin` validation on the mobile device,
- and rejection of untrusted origins by the verifier.

### Session Hijacking

Prevented by:

- binding the signed response to `session_public_key`,
- and rejecting mismatched session keys.

### Offline Signature Reuse

A reused identity object cannot authorize a different proof transparently because the proof signature binds the identity object hash.

## 6. Non-Repudiation

The identity layer proves that the device-held private key authorized a session.

It does not prove legal identity by itself.

Historical validity survives revocation only when:

- signature verification succeeds,
- revocation occurred after the independently attested proof time,
- and the key was valid at the authorized time.

## 7. Known Limitations

- device attestation validation is platform-specific and may require external trust roots,
- offline proof verification cannot prove that a challenge was unused unless replay state was recorded at authorization time,
- and key-holder identity is not equivalent to legal identity without external binding.
