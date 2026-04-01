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
- `POST /register` (requires user role if authenticated)
- `POST /verify` (requires user role if authenticated)
- `POST /verify-proof`
- `GET /events/:event_id`
- `GET /batches/:batch_id`
- `POST /batches/:batch_id/publish-anchor` (requires user role if authenticated)
- `GET /proofs/:event_id`
- `POST /api-keys/create` (requires admin role)
- `GET /api-keys` (requires admin role)
- `GET /organizations/me` (requires authentication)

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

### Response

```json
{
  "voiceId": "vri_41182e0817c1197a",
  "status": "registered",
  "complianceLevel": 3,
  "fingerprint": "fp_...",
  "audioHash": "41182e0817c1197a...",
  "registry": "vri:testnet",
  "createdAt": "2026-03-31T21:34:37.000Z",
  "proofPackage": {
    "protocol_version": "1.0",
    "compliance_level": 3,
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
    "usage_event_id": "evt_...",
    "ledger_anchor": "0x...",
    "verification_endpoint": "http://localhost:8787/verify-proof",
    "extensions": {}
  },
  "proof_package": {
    "protocol_version": "1.0",
    "compliance_level": 3,
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
    "usage_event_id": "evt_...",
    "ledger_anchor": "0x...",
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

- `complianceLevel` is `2` when the event has been recorded but not yet batch-anchored.
- `complianceLevel` is `3` when the event has been assigned a local ledger batch root.
- Both `proofPackage` and `proof_package` are returned for convenience. They currently carry the same object.

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

## POST /verify-proof

Runs cryptographic verification over the presented audio and proof package, then validates local ledger consistency and Merkle inclusion where available.

### Request

```json
{
  "audioBase64": "UklGR...",
  "proofPackage": {
    "protocol_version": "1.0",
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
    "usage_event_id": "evt_...",
    "ledger_anchor": "0x..."
  }
}
```

### Response

```json
{
  "ok": true,
  "reason": "VALID",
  "details": {
    "mode": "v1.0",
    "audioHash": "41182e0817c1197a...",
    "messageDigest": "c6fe53f23474971a..."
  },
  "ledger": {
    "ok": true,
    "reason": "LEDGER_CONFIRMED",
    "event": {
      "event_id": "evt_..."
    },
    "batch": {
      "batch_id": "batch_...",
      "root_hash": "0x..."
    },
    "merkle_proof": {
      "leaf_hash": "0x...",
      "root_hash": "0x...",
      "proof": [],
      "verified": true
    }
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
