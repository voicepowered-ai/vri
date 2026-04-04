# API Reference

## Status

This document describes the API surface currently implemented in the local Node reference server at [packages/api/src/server.js](../packages/api/src/server.js).

Current local base URL:

```text
http://localhost:8787
```

## Authentication (Beta)

API endpoints support optional Bearer token authentication via the `Authorization` header:

```
Authorization: Bearer <api_key>
```

When authentication is enabled (`requireAuth: true` in server options), all requests require a valid API key. API keys are generated per organization and have role-based permissions:

- `admin`: Full access to all operations, including API key management and audit logs
- `user`: Can register voices, verify proofs, and publish anchors
- `readonly`: Can only query events, verify proofs, and list organizations

Organizations have per-hour quota limits on registrations (default: 100/hour).

### Authentication Endpoints

- `POST /api-keys/create` — Create a new API key for an organization (requires `admin` role)
- `GET /api-keys` — List API keys for the authenticated organization (requires `admin` role)
- `GET /organizations/me` — Get current organization metadata (requires authentication)

This is a developer-oriented reference implementation. It includes optional API key authentication, local or pluggable storage backends, and external batch anchor publication.

### MongoDB Backend (Preferred Beta Reference)

To run the ledger on MongoDB, construct the server with a Mongo client/database and set `storageBackend: "mongodb"`:

```js
import { MongoClient } from "mongodb";
import { startServer } from "@vri/api";

const client = new MongoClient(process.env.MONGODB_URI);
await client.connect();

startServer({
  storageBackend: "mongodb",
  mongoClient: client,
  mongoDb: client.db(process.env.MONGODB_DB || "vri")
});
```

Collections used by default:

- `vri_events`
- `vri_batches`

## Implemented Endpoints

- `GET /health`
- `GET /ledger/status`
- `GET /scheduler/status`
- `GET /profiling/metrics` (requires admin role if authenticated)
- `GET /audit-log` (requires admin role)
- `POST /identity/challenges`
- `POST /identity/redeem`
- `GET /identity/sessions/:session_id`
- `POST /recording-sessions` — create a new `RecordingSession` for session-based workflows
- `GET /recording-sessions/:id` — retrieve a `RecordingSession` by ID
- `POST /register` (requires user role if authenticated)
- `POST /register-recorded` (requires user role if authenticated)
- `POST /register-export` (requires user role if authenticated)
- `POST /verify` (requires user role if authenticated)
- `POST /verify-proof`
- `POST /verify-timestamp-attestation`
- `POST /normalize-timestamp-attestation`
- `GET /trust/timestamp-authorities`
- `GET /trust/timestamp-policy`
- `GET /trust/timestamp-profiles`
- `GET /events/:event_id`
- `GET /batches/:batch_id`
- `POST /batches/:batch_id/publish-anchor` (requires user role if authenticated)
- `GET /proofs/:event_id`
- `POST /api-keys/create` (requires admin role)
- `GET /api-keys` (requires admin role)
- `GET /organizations/me` (requires authentication)
- `POST /key-revocations` (requires admin role)
- `GET /key-revocations/:key_id`

## Server Persistence Options

The reference server can persist security-critical state across restarts:

- `identitySessionStoreFilePath`: persists QR challenge/session state, used nonces, and consumed session ids.
- `recordingSessionStoreFilePath`: persists `RecordingSession` state for session-based workflows. If omitted, sessions are process-local.
- `revocationRegistryFilePath`: persists key revocation records used by `/key-revocations` and `/verify-proof`.
- `nonceReplayStoreFilePath`: persists verifier replay observations for `creator_id + nonce` freshness enforcement.
- `trustedTimestampAuthoritiesFilePath`: loads an auditable TSA trust policy from JSON at startup.
- `trustedTimestampAuthoritiesCatalogFilePath`: loads a catalog of published TSA trust profiles.
- `timestampTrustProfileId`: selects the active TSA trust profile from a catalog, or labels an inline policy.
- `openSslTimestampOptions`: enables a built-in RFC 3161 parser/validator adapter backed by the local `openssl` binary.

If these options are omitted, the corresponding state remains process-local.

## Server Enforcement Options (Session-Based Model)

These options gate inference-related registrations with policy-level controls:

- `requireVerifiedSession` (boolean, default `false`): when `true`, `POST /register` and `POST /register-export` (for `GENERATED` proofs) require the request to include a `session_id` referencing a QR-verified `RecordingSession` (`session_verified: true`). Requests without a valid verified session are rejected with `400 session_required` or `400 session_not_verified`.
- `requireInputVerification` (boolean, default `false`): when `true`, the same routes additionally require `inferenceMetadata.input_reference` to point to a `RECORDED` ledger event from this system. Requests referencing audio that was not registered as `RECORDED` within this system are rejected with `400 input_reference_not_recorded`.

These options may be combined. When both are enabled, a request must pass both gates before a `GENERATED` proof is issued.

`openSslTimestampOptions` is intended for deployments that want to ingest raw `DER/base64` RFC 3161 tokens without writing a custom parser callback. Supported fields:

- `caFile`, `caPath`, or `caStore`: trust roots for `openssl ts -verify`
- `untrustedFile`: extra intermediate certificates
- `tokenIn`: pass `-token_in` when the input is a PKCS#7 token rather than a TS response
- `attime`: verify certificate validity and revocation status at a specific epoch time
- `crlCheck`, `crlCheckAll`, `useDeltas`, `extendedCrl`: enable CRL-based revocation policy
- `policy`, `policyCheck`, `explicitPolicy`, `inhibitAny`, `inhibitMap`: enable X.509 policy processing
- `purpose`, `verifyName`, `verifyDepth`, `authLevel`, `x509Strict`, `partialChain`, `checkSsSig`, `noCheckTime`: certificate-path validation controls
- `verifyArgs`: extra validation flags forwarded to `openssl ts -verify`
- `binaryPath`: override the `openssl` executable path

By default, the adapter fails closed unless a trust store is configured. Set `skipVerify: true` only for non-production parsing workflows.

The repository test suite includes `openssl ts` integration coverage for this adapter using ephemeral local TSA fixtures.

Example TSA trust-policy file:

```json
{
  "profile_id": "tsa-eu-prod-v1",
  "profile_name": "EU Production TSA Policy",
  "version": 7,
  "effective_at": 1774995000,
  "validation_profile": {
    "adapter": "openssl-ts-verify",
    "attime": 1774995000,
    "crl_check": true,
    "x509_strict": true
  },
  "trusted_timestamp_authorities": [
    {
      "name": "tsa.example",
      "tsa": "tsa.example",
      "policy_oids": ["1.2.3.4.5"]
    }
  ]
}
```

Example TSA trust-profile catalog:

```json
{
  "version": 1,
  "profiles": [
    {
      "profile_id": "tsa-inline-staging",
      "profile_name": "Inline Staging TSA Policy",
      "version": 1,
      "effective_at": null,
      "validation_profile": {
        "adapter": "openssl-ts-verify",
        "policy": "1.2.3.4.5",
        "policy_check": true
      },
      "trusted_timestamp_authorities": [
        {
          "tsa": "tsa.staging.vri.example",
          "policy_oids": ["1.2.3.4.5"]
        }
      ]
    },
    {
      "profile_id": "tsa-eu-prod-v1",
      "profile_name": "EU Production TSA Policy",
      "version": 7,
      "effective_at": 1774995000,
      "validation_profile": {
        "adapter": "openssl-ts-verify",
        "attime": 1774995000,
        "crl_check": true,
        "x509_strict": true
      },
      "trusted_timestamp_authorities": [
        {
          "tsa": "tsa.example",
          "policy_oids": ["1.2.3.4.5"]
        }
      ]
    }
  ]
}
```

## GET /health

Basic liveness check.

### Response

```json
{
  "status": "ok",
  "service": "vri-api"
}
```

## GET /ledger/status

Returns the current local ledger status.

### Response

```json
{
  "event_count": 1,
  "batch_count": 1,
  "pending_event_count": 0,
  "latest_batch_id": "batch_abc123",
  "latest_batch_root": "0x..."
}
```

## POST /register

Registers an audio artifact, emits a `Proof Package`, and records a local `Usage Event`.

### Request

```json
{
  "audioBase64": "UklGR...",
  "anchorNow": true,
  "registry": "vri:testnet",
  "model": "tts-v3",
  "provider": "local",
  "verificationEndpoint": "http://localhost:8787/verify-proof",
  "metadata": {
    "model_id": "tts-v3",
    "operation": "voice_synthesis",
    "request_id": "req_123456",
    "tenant_id": "org_789"
  }
}
```

### Fields

| Field | Type | Required | Notes |
|------|------|----------|------|
| `audioBase64` | string | yes | WAV audio payload encoded as base64. Supports PCM 16-bit, 24-bit, and IEEE float32. Any sample rate is resampled to canonical 48 kHz deterministically. |
| `anchorNow` | boolean | no | If `true`, immediately anchors pending events into a local batch |
| `registry` | string | no | Registry label for the generated proof |
| `model` | string | no | Optional model hint stored in the ledger event |
| `provider` | string | no | Optional provider hint stored in the ledger event |
| `verificationEndpoint` | string | no | Included in the proof package |
| `metadata` | object | no | Must be a JSON object |
| `identity` | object | no | Signed identity assertion. Required only when the deployment enables strict identity verification. |
| `complianceLevel` | integer | no | Defaults to `2` for `/register`. Level `3` requires `anchorNow: true` plus valid `timestampAttestation`. |
| `timestampAttestation` | object | no | Level `3` input. Must validate against the canonical receipt digest under the configured TSA policy. |
| `timestampToken` | string or object | no | Alternative Level `3` input. Raw RFC 3161 token accepted as a string or `{ encoding, data }` when a parser or `openSslTimestampOptions` is configured. |
| `session_id` | string | no | ID of an existing `RecordingSession`. Required when `requireVerifiedSession` is enabled. |
| `actor_id` | string | no | Wallet or identity reference for the voice actor. Included in the signed proof. |
| `inferenceMetadata` | object | no | AI provenance payload. See sub-fields below. Required when `requireInputVerification` is enabled. |
| `inferenceMetadata.model_id` | string | conditional | Required when `inferenceMetadata` is present. Identifies the AI model used for generation. Included in the signed proof. |
| `inferenceMetadata.model_provider` | string | no | Optional AI model provider label. |
| `inferenceMetadata.input_reference` | string | no | Ledger event ID of the source `RECORDED` audio used as model input. Required when `requireInputVerification` is enabled. |
| `inferenceMetadata.input_verified` | boolean | no | Set to `true` by the server when `input_reference` passes system verification. Do not set this manually. |

Strict session mode note:

- when `registerRequireAuthorizedIdentitySession` is enabled in the server, `/register` requires an `identity` object whose `session_id` has already been redeemed server-side and is authorized for the `generation` scope.
- when `identitySessionStoreFilePath` is configured, this authorization state survives process restarts and remains single-use.

Level 3 attestation input note:

- `/register` accepts either `timestampAttestation` or `timestampToken`.
- `timestampToken` is normalized against the canonical Level 3 receipt digest before ledger append.
- if both are absent, Level 3 registration fails closed.

### Response

```json
{
  "voiceId": "vri_41182e0817c1197a",
  "status": "registered",
  "proofType": "GENERATED",
  "complianceLevel": 2,
  "fingerprint": "fp_...",
  "audioHash": "41182e0817c1197a...",
  "registry": "vri:testnet",
  "createdAt": "2026-03-31T21:34:37.000Z",
  "proofPackage": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 2,
    "watermark_format_version": "1.0",
    "watermark_payload": "base64(...)",
    "watermark_hex": "0x...",
    "audio_hash": "0x...",
    "signature": {
      "algorithm": "Ed25519",
      "value": "0x..."
    },
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877,
    "metadata": {
      "model_id": "tts-v3",
      "operation": "voice_synthesis",
      "request_id": "req_123456",
      "tenant_id": "org_789"
    },
    "canonical_metadata": "{\"model_id\":\"tts-v3\",\"operation\":\"voice_synthesis\",\"request_id\":\"req_123456\",\"tenant_id\":\"org_789\",\"session_id\":\"rsess_...\",\"actor_id\":\"wallet_...\",\"inference_metadata\":{\"model_id\":\"tts-v3\",\"model_provider\":\"openai\",\"input_reference\":\"evt_...\",\"input_verified\":true}}",
    "session_id": "rsess_...",
    "actor_id": "wallet_...",
    "inference_metadata": {
      "model_id": "tts-v3",
      "model_provider": "openai",
      "input_reference": "evt_...",
      "input_verified": true,
      "input_audio_hash": "0x..."
    },
    "identity": {
      "auth_method": "QR_SECURE_ENCLAVE",
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "public_key": "0x...",
      "device_attested": true,
      "session_timestamp": 1774992800,
      "signature": "0x..."
    },
    "verification_endpoint": "http://localhost:8787/verify-proof",
    "extensions": {}
  },
  "session_id": "rsess_...",
  "actor_id": "wallet_...",
  "inference_metadata": {
    "model_id": "tts-v3",
    "model_provider": "openai",
    "input_reference": "evt_...",
    "input_verified": true,
    "input_audio_hash": "0x..."
  },
  "proof_package": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 2,
    "watermark_format_version": "1.0",
    "watermark_payload": "base64(...)",
    "watermark_hex": "0x...",
    "audio_hash": "0x...",
    "signature": {
      "algorithm": "Ed25519",
      "value": "0x..."
    },
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877,
    "metadata": {
      "model_id": "tts-v3",
      "operation": "voice_synthesis",
      "request_id": "req_123456",
      "tenant_id": "org_789"
    },
    "canonical_metadata": "{\"model_id\":\"tts-v3\",\"operation\":\"voice_synthesis\",\"request_id\":\"req_123456\",\"tenant_id\":\"org_789\"}",
    "identity": {
      "auth_method": "QR_SECURE_ENCLAVE",
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "public_key": "0x...",
      "device_attested": true,
      "session_timestamp": 1774992800,
      "signature": "0x..."
    },
    "verification_endpoint": "http://localhost:8787/verify-proof",
    "extensions": {}
  },
  "ledger_event": {
    "event_id": "evt_...",
    "ledger_batch_id": "batch_...",
    "ledger_anchor": "0x...",
    "batch_anchor": "0x..."
  },
  "batch_publication": {
    "published": false,
    "confirmed": false,
    "provider": null,
    "network": null,
    "transaction_hash": null,
    "external_anchor_id": null,
    "published_at": null
  },
  "watermark": {
    "embedded": false,
    "mode": "vri-spread-spectrum-v1"
  }
}
```

Notes:

- `/register` currently emits `GENERATED` Level 2 proofs.
- `/register` MAY emit `GENERATED` Level 3 proofs only when `complianceLevel = 3`, `anchorNow = true`, and `timestampAttestation` validates.
- The API still records an operational ledger event, but that event is returned outside the proof package and does not upgrade the proof to Level 3.
- Level 3 requires both independent timestamp attestation and a concrete ledger anchor; otherwise registration fails closed.
- Both `proofPackage` and `proof_package` are returned for convenience. They currently carry the same object.
- `session_id`, `actor_id`, and `inference_metadata` are included inside `canonical_metadata` before signing, making them tamper-evident.
- The top-level `session_id`, `actor_id`, and `inference_metadata` fields in the response are convenience copies of what is in the proof package.

### Error Codes (Session / Inference Gates)

These errors are returned as `400` with `{ "error": "<code>", "message": "..." }` when enforcement is active:

| Code | Trigger |
|---|---|
| `session_required` | `requireVerifiedSession` is on but no `session_id` was provided |
| `recording_session_not_found` | `session_id` does not exist in the store |
| `session_not_verified` | Session exists but `session_verified === false` (not QR-activated) |
| `recording_session_invalid` | Session is expired or closed |
| `inference_metadata_required` | `requireInputVerification` is on but no `inferenceMetadata.model_id` was provided |
| `input_reference_required` | `requireInputVerification` is on but no `input_reference` was provided |
| `input_reference_not_found` | `input_reference` event does not exist in the ledger |
| `input_reference_not_recorded` | Referenced event is not of type `RECORDED` |

## POST /recording-sessions

Creates a new `RecordingSession` that links a voice actor to a recording context. A session is required when `requireVerifiedSession` is enabled. Sessions activated via QR scan have `session_verified: true`.

### Request (manual session)

```json
{
  "actor_id": "wallet_...",
  "studio_id": "studio_nyc_01",
  "verification_method": "manual"
}
```

### Request (QR-activated session)

```json
{
  "actor_id": "wallet_...",
  "studio_id": "studio_nyc_01",
  "from_qr": true
}
```

`from_qr: true` is equivalent to a QR-scan activation: the returned session has `session_verified: true`. Use this when the actor has scanned a QR code and you are forwarding that payload server-side.

### Fields

| Field | Type | Required | Notes |
|---|---|---|---|
| `actor_id` | string | yes | Wallet or identity reference for the voice actor |
| `studio_id` | string | no | Optional studio or room identifier |
| `verification_method` | string | no | `qr_scan` or `manual` (default: `manual`) |
| `from_qr` | boolean | no | If `true`, overrides `verification_method` to `qr_scan` and sets `session_verified: true` |

### Response (201)

```json
{
  "session_id": "rsess_...",
  "actor_id": "wallet_...",
  "studio_id": "studio_nyc_01",
  "start_time": "2026-04-04T00:00:00.000Z",
  "verification_method": "qr_scan",
  "session_verified": true,
  "status": "ACTIVE",
  "created_at": 1743800000
}
```

The `session_id` from this response should be passed as `session_id` in subsequent `/register` or `/register-export` calls.

## GET /recording-sessions/:id

Retrieves a `RecordingSession` by its ID.

### Response (200)

```json
{
  "session_id": "rsess_...",
  "actor_id": "wallet_...",
  "studio_id": "studio_nyc_01",
  "start_time": "2026-04-04T00:00:00.000Z",
  "verification_method": "qr_scan",
  "session_verified": true,
  "status": "ACTIVE",
  "created_at": 1743800000
}
```

Returns `404` with `{ "error": "recording_session_not_found" }` if no session with that ID exists.

## POST /register-recorded

Registers a studio-captured artifact as a `RECORDED` proof.

Behavior:

- default `proof_type` is `RECORDED`,
- default `complianceLevel` is `1`,
- Level 1 remains watermark-free,
- and strict session mode consumes only sessions authorized for `recording`.

The request and response shape matches [`POST /register`](#post-register), except the emitted proof is `RECORDED`.

## POST /register-export

Registers a final exported artifact and requires explicit proof mode selection.

Request additions relative to [`POST /register`](#post-register):

- `proofType` is REQUIRED and must be `RECORDED` or `GENERATED`.
- `complianceLevel` is optional and defaults to `2` for `GENERATED` and `1` for `RECORDED`.
- `includeWatermark` is optional. If omitted, it defaults to `true` only for `GENERATED` proofs with `complianceLevel >= 2`.
- `metadata.lineage` is REQUIRED and must include:
  - `parent_audio_hash`: `0x`-prefixed SHA-256 of the parent artifact,
  - `source_proof_type`: `RECORDED` or `GENERATED`,
  - `source_event_id`: non-empty source ledger/event reference.

The server validates `metadata.lineage` against the referenced local ledger event. Export registration fails closed unless:

- `source_event_id` exists,
- the parent event `audio_hash` matches `parent_audio_hash`,
- and the parent event `proof_type` matches `source_proof_type`.

Strict session mode note:

- when `registerRequireAuthorizedIdentitySession` is enabled in the server, `/register-export` requires an `identity` object whose `session_id` has already been redeemed server-side and is authorized for the `export` scope.

## POST /verify

Validates the format of a VRI voice identifier.

### Request

```json
{
  "voiceId": "vri_41182e0817c1197a",
  "registry": "vri:testnet"
}
```

### Response

```json
{
  "voiceId": "vri_41182e0817c1197a",
  "status": "verified",
  "authenticity": "confirmed",
  "registry": "vri:testnet",
  "checkedAt": "2026-03-31T21:34:37.000Z"
}
```

## POST /identity/challenges

Creates a single-use QR authorization challenge for device-backed identity bootstrap.

### Request

```json
{
  "verifierOrigin": "https://studio.vri.example",
  "sessionScope": ["recording"],
  "sessionPublicKey": "0xsessionpub",
  "ttlSeconds": 300
}
```

`sessionScope` accepts only the protocol-defined values `recording`, `generation`, and `export`. Any other value is rejected with `400`.

If `identitySessionStoreFilePath` is configured, the challenge and replay state are persisted immediately.

### Response

```json
{
  "challenge": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "verifier_origin": "https://studio.vri.example",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "nonce": "base64(...)",
    "session_scope": ["recording"],
    "session_expires_at": 1774993100,
    "session_public_key": "0xsessionpub"
  },
  "qr_payload": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "verifier_origin": "https://studio.vri.example",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "nonce": "base64(...)",
    "session_scope": ["recording"],
    "session_expires_at": 1774993100,
    "session_public_key": "0xsessionpub"
  },
  "status": "PENDING"
}
```

## POST /identity/redeem

Redeems a signed device identity assertion against a pending QR challenge.

### Request

```json
{
  "identity": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "verifier_origin": "https://studio.vri.example",
    "session_id": "550e8400-e29b-41d4-a716-446655440000",
    "nonce": "base64(...)",
    "session_scope": ["recording"],
    "session_public_key": "0xsessionpub",
    "public_key": "0x...",
    "session_timestamp": 1774992800,
    "session_expires_at": 1774993100,
    "device_attested": true,
    "attestation": {},
    "signature": "0x..."
  }
}
```

### Response

```json
{
  "status": "AUTHORIZED",
  "session_id": "550e8400-e29b-41d4-a716-446655440000",
  "redeemed_at": 1774992850,
  "identity": {
    "auth_method": "QR_SECURE_ENCLAVE",
    "session_id": "550e8400-e29b-41d4-a716-446655440000"
  }
}
```

Failure notes:

- replayed or already redeemed challenges fail closed,
- mismatched `session_id`, `nonce`, or `session_public_key` fail closed,
- untrusted `verifier_origin` fails closed.
- an authorized challenge is not enough to mint a proof unless the deployment also accepts its scope for the requested action.
- when `registerRequireAuthorizedIdentitySession` is enabled, a redeemed session is single-use for proof issuance and transitions from `AUTHORIZED` to `CONSUMED` after the first successful `/register`.
- route-level authorization is scope-bound: `/register` consumes only sessions authorized for `generation`; a session authorized only for `recording` or `export` fails closed.

## GET /identity/sessions/:session_id

Returns the current server-side authorization state for a challenge/session.

Session lifecycle:

- `PENDING`: issued but not yet redeemed,
- `AUTHORIZED`: redeemed once and eligible for one proof issuance in a compatible scope,
- `CONSUMED`: already used to authorize a successful proof issuance,
- `EXPIRED`: no longer valid because the session time window elapsed.

## POST /verify-proof

Runs cryptographic verification over the presented audio and proof package, then validates local ledger consistency and Merkle inclusion where available.

Default verifier policy (strict profile):

- `protocol_version` is required and must be `2.0`.
- `proof_type` is required and must be `RECORDED` or `GENERATED`.
- `identity` is required only when the deployment enables strict identity verification.
- Freshness window checks are enabled by default.
- Nonce replay tracking is enabled by default (same creator+nonce is rejected after first successful observation).
- `compliance_level` is required and must be an integer in `[1,3]`.
- Watermark evidence is mandatory only for `GENERATED` proofs with `compliance_level >= 2`; status MUST be `present`.
- Level 1 proofs fail if they carry watermark or ledger-attestation fields.
- Revocation output is reported separately as current key status and historical validity.

Revocation semantics in the current reference implementation:

- `current_key_status` reports whether the signing key is currently revoked,
- `historical_validity` is reported conservatively,
- without independent timestamp attestation, historical validity is `INDETERMINATE_UNATTESTED` even if the proof remains cryptographically valid.

Level 3 timestamp-attestation semantics in the current reference implementation:

- the core verifier validates the attestation object structure and receipt digest binding,
- the server may be configured with `verifyTimestampAttestation` to validate TSA-specific evidence,
- or with `trustedTimestampAuthorities` to use the built-in normalized `RFC3161` verifier profile,
- or with `trustedTimestampAuthoritiesFilePath` to load that policy from a JSON file,
- and `openSslTimestampOptions` can provide a built-in raw-token parser/validator for RFC 3161 inputs,
- loaded or inline TSA policy is exposed with a deterministic `policy_digest` for auditability,
- without that verifier, Level 3 proofs fail closed.

Server options to override policy:

- `verifyEnforceFreshness` (default: `true`)
- `verifyMaxTimestampSkewSeconds` (default: `86400`)
- `verifyTrackNonce` (default: `true`)
- `nonceReplayStoreFilePath` to persist replay state across process restarts

### Request

```json
{
  "audioBase64": "UklGR...",
  "proofPackage": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 2,
    "audio_hash": "0x...",
    "watermark_payload": "base64(...)",
    "watermark_hex": "0x...",
    "signature": {
      "algorithm": "Ed25519",
      "value": "0x..."
    },
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877,
    "metadata": {},
    "canonical_metadata": "{}",
    "identity": {
      "auth_method": "QR_SECURE_ENCLAVE",
      "session_id": "550e8400-e29b-41d4-a716-446655440000",
      "public_key": "0x...",
      "device_attested": true,
      "session_timestamp": 1774992800,
      "signature": "0x..."
    }
  }
}
```

### Response

```json
{
  "ok": true,
  "reason": "VALID",
  "details": {
    "mode": "v2.0",
    "proof_type": "GENERATED",
    "compliance_level": 2,
    "audioHash": "41182e0817c1197a...",
    "messageDigest": "c6fe53f23474971a..."
  },
  "ledger": {
    "ok": true,
    "reason": "LEDGER_NOT_REQUIRED"
  },
  "trust_policy": null
}
```

For Level 3 verification, `trust_policy` contains the TSA policy snapshot used by the verifier:

```json
{
  "profile_id": "inline-default",
  "profile_name": "Inline TSA Trust Policy",
  "version": 1,
  "effective_at": null,
  "source": "inline",
  "policy_digest": "0x...",
  "authority_count": 1,
  "validation_profile": null
}
```

Trust and policy notes:

- `watermark` can be `present`, `degraded`, `missing`, or `not_applicable`.
- In strict default mode, any non-`present` watermark status is rejected only for `GENERATED` proofs when compliance is `>= 2` (`WATERMARK_REQUIRED_NOT_PRESENT`).
- Identity failures return explicit `IDENTITY_*` rejection reasons in identity-enabled deployments.
- Valid Level 1 proofs return `trust_level = PARTIAL`.
- Valid Level 2 and Level 3 proofs return `trust_level = HIGH`.
- Replay failures return `REPLAY_DETECTED`.
- Timestamp freshness failures return `TIMESTAMP_OUT_OF_WINDOW`.

## POST /verify-timestamp-attestation

Validates a normalized timestamp-attestation object against the canonical Level 3 receipt digest derived from a presented `proofPackage`.

### Request

```json
{
  "proofPackage": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 3,
    "audio_hash": "0x...",
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877,
    "usage_event_id": "evt_...",
    "timestamp_attestation": {
      "type": "RFC3161",
      "tsa": "tsa.vri.example",
      "policy_oid": "1.2.3.4.5",
      "serial_number": "0x1234",
      "message_imprint_alg": "sha256",
      "message_imprint": "0x...",
      "attested_at": 1774992887,
      "gen_time": 1774992887,
      "token": "base64(tsr)",
      "digest": "0x..."
    }
  },
  "timestampAttestation": {
    "type": "RFC3161",
    "tsa": "tsa.vri.example",
    "policy_oid": "1.2.3.4.5",
    "serial_number": "0x1234",
    "message_imprint_alg": "sha256",
    "message_imprint": "0x...",
    "attested_at": 1774992887,
    "gen_time": 1774992887,
    "token": "base64(tsr)",
    "digest": "0x..."
  }
}
```

### Response

```json
{
  "ok": true,
  "reason": "VALID",
  "expected_digest": "0x...",
  "details": {
    "tsa": "tsa.vri.example",
    "serial_number": "0x1234",
    "policy_oid": "1.2.3.4.5",
    "attested_at": 1774992887
  },
  "trust_policy": {
    "profile_id": "inline-default",
    "profile_name": "Inline TSA Trust Policy",
    "version": 1,
    "effective_at": null,
    "source": "inline",
    "policy_digest": "0x...",
    "authority_count": 1,
    "validation_profile": null
  }
}
```

## POST /normalize-timestamp-attestation

Normalizes a raw RFC 3161 token or validates an already-normalized timestamp-attestation object against the canonical receipt digest derived from `proofPackage`.

This route is intended as an ingestion/preflight bridge for external TSA integrations.

### Request

```json
{
  "proofPackage": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 3,
    "audio_hash": "0x...",
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877,
    "usage_event_id": "evt_..."
  },
  "timestampToken": {
    "encoding": "base64",
    "data": "base64(raw-tsr)"
  }
}
```

`timestampToken` may also be provided as a plain string for compatibility, but the preferred form is `{ "encoding", "data" }` with `encoding` in `base64`, `hex`, or `utf8`.

Parser integration contract:

- the server option `parseRfc3161Token` receives the normalized token bytes/string plus verification context,
- it may return a normalized attestation object directly,
- or `{ "ok": true, "attestation": { ... } }`,
- or `{ "ok": false, "reason": "..." }`,
- and any other return shape fails closed.

### Response

```json
{
  "ok": true,
  "reason": "VALID",
  "expected_digest": "0x...",
  "timestamp_attestation": {
    "type": "RFC3161",
    "tsa": "tsa.vri.example",
    "policy_oid": "1.2.3.4.5",
    "serial_number": "0x1234",
    "message_imprint_alg": "sha256",
    "message_imprint": "0x...",
    "attested_at": 1774992887,
    "gen_time": 1774992887,
    "token": "base64(raw-tsr)"
  },
  "details": {
    "tsa": "tsa.vri.example",
    "serial_number": "0x1234",
    "policy_oid": "1.2.3.4.5",
    "attested_at": 1774992887
  },
  "trust_policy": {
    "profile_id": "inline-default",
    "profile_name": "Inline TSA Trust Policy",
    "version": 1,
    "effective_at": null,
    "source": "inline",
    "policy_digest": "0x...",
    "authority_count": 1,
    "validation_profile": null
  }
}
```

## GET /events/:event_id

Retrieves a recorded ledger event.

### Response

```json
{
  "event_id": "evt_...",
  "creator_id": "0x...",
  "public_key": "0x...",
  "audio_hash": "0x...",
  "watermark_payload": "base64(...)",
  "timestamp": 1774993174,
  "status": "RECORDED",
  "model": "tts-v3",
  "provider": "local",
  "metadata": {
    "request_id": "req_123456"
  },
  "canonical_metadata": "{\"request_id\":\"req_123456\"}",
  "verification_endpoint": "http://localhost:8787/verify-proof",
  "ledger_batch_id": "batch_...",
  "sequence": 1,
  "previous_anchor": "0x...",
  "content_hash": "0x...",
  "chain_anchor": "0x...",
  "ledger_anchor": "0x...",
  "batch_anchor": "0x...",
  "recorded_at": 1774993174,
  "batch_publication": {
    "published": false,
    "confirmed": false,
    "provider": null,
    "network": null,
    "transaction_hash": null,
    "external_anchor_id": null,
    "published_at": null
  }
}
```

## GET /batches/:batch_id

Retrieves a local anchored batch record.

### Response

```json
{
  "batch_id": "batch_...",
  "root_hash": "0x...",
  "event_count": 1,
  "event_ids": [
    "evt_..."
  ],
  "previous_batch_anchor": "0x...",
  "batch_anchor": "0x...",
  "anchor_time": 1774993174,
  "blockchain_chain": null,
  "blockchain_tx": null,
  "blockchain_confirmed": false
}
```

## GET /profiling/metrics

Returns accumulated runtime metrics for DSP-heavy and ledger operations.

### Response

```json
{
  "metricCount": 3,
  "metrics": {
    "dsp.watermark.embed_ms": {
      "count": 1,
      "avgMs": 4.3,
      "totalMs": 4.3,
      "minMs": 4.3,
      "maxMs": 4.3,
      "lastMs": 4.3
    }
  }
}
```

## GET /scheduler/status

Returns current scheduler queue metrics and queue items.

### Response

```json
{
  "status": {
    "queued": 0,
    "publishing": 0,
    "published": 1,
    "failed": 0,
    "paused": 0,
    "total": 1,
    "isProcessing": true
  },
  "queue": [
    {
      "batchId": "batch_...",
      "state": "published",
      "scheduledAt": "2026-04-01T12:00:00.000Z",
      "retryInfo": null
    }
  ]
}
```

## POST /batches/:batch_id/publish-anchor

Publishes a batch root to an external anchor provider and stores the resulting publication state on the batch.

### Request

Synchronous publish (default):

```json
{
  "provider": "external-http",
  "network": "sepolia",
  "endpoint": "https://anchor-provider.example/publish"
}
```

Asynchronous publish via scheduler:

```json
{
  "async": true,
  "provider": "external-http",
  "network": "sepolia",
  "endpoint": "https://anchor-provider.example/publish"
}
```

`endpoint` is required unless `VRI_EXTERNAL_ANCHOR_URL` is set in the environment.
When `async` is `true`, the endpoint returns `202` with scheduling metadata.

### Response

```json
{
  "batch_id": "batch_...",
  "root_hash": "0x...",
  "event_count": 1,
  "event_ids": [
    "evt_..."
  ],
  "previous_batch_anchor": "0x...",
  "batch_anchor": "0x...",
  "anchor_time": 1774993174,
  "blockchain_chain": "sepolia",
  "blockchain_tx": "0x...",
  "blockchain_confirmed": true,
  "external_anchor_provider": "external-http",
  "external_anchor_id": "anchor_..."
}
```

## GET /proofs/:event_id

Returns the Merkle inclusion proof for an event inside its batch.

### Response

```json
{
  "event": {
    "event_id": "evt_..."
  },
  "batch": {
    "batch_id": "batch_...",
    "root_hash": "0x..."
  },
  "proof": [
    {
      "position": "right",
      "hash": "0x..."
    }
  ],
  "leaf_hash": "0x...",
  "root_hash": "0x...",
  "verified": true,
  "batch_publication": {
    "published": false,
    "confirmed": false,
    "provider": null,
    "network": null,
    "transaction_hash": null,
    "external_anchor_id": null,
    "published_at": null
  }
}
```

For single-event batches, the proof array may be empty because the leaf hash is already the batch root.

## POST /key-revocations

Records a key revocation entry used by verification-time current-status and historical-validity checks.

If `revocationRegistryFilePath` is configured, the record is persisted to disk and reused after restart.

### Request

```json
{
  "keyId": "key_123",
  "creatorId": "0x...",
  "publicKey": "0x...",
  "effectiveAt": 1774994000,
  "reason": "key_compromise",
  "recordedAt": 1774994010
}
```

### Response

```json
{
  "key_id": "key_123",
  "creator_id": "0x...",
  "public_key": "0x...",
  "revoked_at": 1774994000,
  "reason": "key_compromise",
  "recorded_at": 1774994010
}
```

## GET /key-revocations/:key_id

Returns a previously recorded revocation entry.

## GET /trust/timestamp-authorities

Returns the currently loaded TSA trust policy used by the built-in normalized `RFC3161` verifier.

### Response

```json
{
  "trusted_timestamp_authorities": [
    {
      "name": "tsa.example",
      "tsa": "tsa.example",
      "policy_oids": ["1.2.3.4.5"]
    }
  ],
  "count": 1,
  "trust_policy": {
    "profile_id": "tsa-eu-prod-v1",
    "profile_name": "EU Production TSA Policy",
    "version": 7,
    "effective_at": 1774995000,
    "source": "/path/to/trusted-tsa.json",
    "policy_digest": "0x...",
    "authority_count": 1,
    "validation_profile": {
      "adapter": "openssl-ts-verify",
      "attime": 1774995000,
      "crl_check": true,
      "x509_strict": true
    }
  }
}
```

## GET /trust/timestamp-policy

Returns only the active TSA trust-profile metadata for the running verifier.

### Response

```json
{
  "trust_policy": {
    "profile_id": "tsa-inline-staging",
    "profile_name": "Inline Staging TSA Policy",
    "version": 1,
    "effective_at": null,
    "source": "inline",
    "policy_digest": "0x...",
    "authority_count": 1,
    "validation_profile": null
  }
}
```

## GET /trust/timestamp-profiles

Lists the published TSA trust profiles currently available from the loaded catalog.

### Response

```json
{
  "profiles": [
    {
      "profile_id": "tsa-inline-staging",
      "profile_name": "Inline Staging TSA Policy",
      "version": 1,
      "effective_at": null
    },
    {
      "profile_id": "tsa-eu-prod-v1",
      "profile_name": "EU Production TSA Policy",
      "version": 7,
      "effective_at": 1774995000
    }
  ],
  "count": 2,
  "active_profile_id": "tsa-eu-prod-v1"
}
```

## Error Shapes

Typical API errors look like:

```json
{
  "error": "audioBase64 is required"
}
```

Or:

```json
{
  "error": "internal_error",
  "message": "Detailed failure message"
}
```

## Notes

- The current implementation is local-first and file-backed.
- Ledger events and batches are local, while external anchor publication is performed via an HTTP provider integration.
- External publication requires either request-level `endpoint` or `VRI_EXTERNAL_ANCHOR_URL`.
- Watermark embedding and extraction use the production spread-spectrum engine with ECC and synchronization.
- The cryptographic proof package, canonical metadata serialization, ledger events, batches, and Merkle inclusion proofs are implemented and tested in the repository.
