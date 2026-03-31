# API Reference

## Base URL

**Production**: `https://api.vri.app/v1`  
**Staging**: `https://staging-api.vri.app/v1`  
**Development**: `http://localhost:3000/v1`

---

## Authentication

All requests require an API key via header:

```
Authorization: Bearer YOUR_API_KEY
```

Or via query parameter (less secure, for testing only):

```
?api_key=YOUR_API_KEY
```

### Rate Limits

```
Standard Tier:  1,000 req/min
Pro Tier:       10,000 req/min
Enterprise:     Custom

Rate limit headers:
  X-RateLimit-Limit: 1000
  X-RateLimit-Remaining: 998
  X-RateLimit-Reset: 1711892460

If exceeded: HTTP 429 Too Many Requests
```

---

## POST /generate

Create a proof-carrying audio artifact with VRI watermarking and signing.

### Request

```json
{
  "text": "Hello, this is an AI voice",
  "voice_id": "voice_xyz123",
  "model": "openai-tts",
  "model_params": {
    "voice": "nova",
    "speed": 1.0
  },
  "metadata": {
    "request_id": "req_123456",
    "model_id": "tts-v3",
    "tenant_id": "org_789",
    "operation": "voice_synthesis"
  },
  "quality": "high"
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | ✓ | Text to synthesize (max 4000 chars) |
| `voice_id` | string | ✓ | Creator's unique voice identifier |
| `model` | enum | ✓ | TTS model: `openai-tts`, `elevenlabs`, `google-tts`, `custom` |
| `model_params` | object | | Model-specific parameters (voice, speed, etc.) |
| `metadata` | object | | Inference-scoped metadata (request, model, tenant, operation) |
| `quality` | enum | | Audio quality: `low` (8kHz), `medium` (22kHz), `high` (44kHz) |

### Response

```json
{
  "request_id": "req_abc123def456",
  "audio_url": "https://cdn.vri.app/audio/uuid-abcd1234.wav",
  "audio_duration_seconds": 4.23,
  "watermark": {
    "payload": "AyJ...=",
    "payload_hex": "0x2f8bafbc...",
    "embedded": true,
    "quality": {
      "snr_db": 42.3,
      "confidence": 0.99
    }
  },
  "signature": {
    "value": "3c4e7a2b1f9d8e5c6a3b2f0d7e4a1c9b5d6c7a8f...",
    "algorithm": "EdDSA",
    "curve": "Ed25519"
  },
  "proof_package": {
    "watermark": {...},
    "signature": {...},
    "creator": {...},
    "metadata": {...},
    "ledger": {...},
    "verification": {...}
  },
  "created_at": 1711892400
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success |
| 400 | Invalid parameters |
| 401 | Authentication failed |
| 429 | Rate limit exceeded |
| 500 | Server error (retry safe) |

---

## POST /verify

Verify an emitted audio artifact and optionally record a verification event.

### Request

```json
{
  "audio_url": "https://example.com/audio.wav",
  "audio_buffer": "base64(...)",
  "proof_package": {
    "watermark": {...},
    "signature": {...},
    "creator": {...},
    "metadata": {...}
  },
  "expected_creator": "0x2f8bafbc",
  "context": {
    "request_id": "req_123456",
    "model_id": "tts-v3",
    "tenant_id": "org_789",
    "operation": "voice_synthesis"
  }
}
```

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `audio_url` | string | | URL to audio file (mutually exclusive with `audio_buffer`) |
| `audio_buffer` | string (base64) | | Audio file as base64 (mutually exclusive with `audio_url`) |
| `proof_package` | object | | Optional proof package for comparison |
| `expected_creator` | string | | Expected creator ID (for validation) |
| `context` | object | | Verification-scoped context (request, model, tenant, operation) |

### Response

**Watermark Found (Verified)**:

```json
{
  "verified": true,
  "status": "authentic_watermark",
  "creator_id": "0x2f8bafbc",
  "creator_name": "Jane Creator",
  "created_at": 1711892400,
  "confidence": 1.0,
  "usage_recorded": {
    "event_id": "evt_xyz123",
    "timestamp": 1711892405
  },
  "metadata": {
    "watermark_extracted": true,
    "signature_valid": true,
    "watermark_ber": 0.08,
    "processing_time_ms": 350
  }
}
```

**Watermark Not Found (Fingerprint Forensic Detection)**:

```json
{
  "verified": false,
  "status": "watermark_not_found",
  "confidence": 0.0,
  "usage_recorded": false,
  "fingerprint_matches": [
    {
      "creator_id": "0x1a2b3c4d",
      "creator_name": "Reference Voice",
      "confidence": 0.85
    }
  ],
  "metadata": {
    "watermark_extracted": false,
    "fingerprint_extracted": true,
    "processing_time_ms": 1200
  }
}
```

### Status Codes

| Code | Description |
|------|-------------|
| 200 | Success (verified or unverified) |
| 400 | Invalid audio/proof |
| 401 | Authentication failed |
| 429 | Rate limit exceeded |
| 500 | Processing error |

---

## GET /events/{event_id}

Retrieve usage event details.

### Request

```
GET /v1/events/evt_abc123def456
Authorization: Bearer YOUR_API_KEY
```

### Response

```json
{
  "event_id": "evt_abc123def456",
  "creator_id": "0x2f8bafbc",
  "creator_name": "Jane Creator",
  "audio_hash": "8b3f1c...",
  "timestamp": 1711892405,
  "source_system": "verification_service",
  "context": {
    "request_id": "req_123456",
    "tenant_id": "org_789",
    "device_class": "desktop"
  },
  "ledger_confirmed": true,
  "ledger_anchor": "0xbca3...",
  "batch_id": "batch_xyz"
}
```

---

## GET /status

System health check.

### Request

```
GET /v1/status
```

### Response

```json
{
  "status": "operational",
  "timestamp": 1711895600,
  "components": {
    "api": "operational",
    "watermarking": "operational",
    "verification": "operational",
    "ledger": "operational",
    "blockchain": "operational"
  },
  "metrics": {
    "events_per_second": 234,
    "avg_verification_time_ms": 380,
    "blockchain_latency_seconds": 480,
    "ledger_sync_status": "synced"
  }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": {
    "code": "INVALID_AUDIO",
    "message": "Audio file could not be decoded.",
    "details": {
      "format": "unknown",
      "size_bytes": 1024
    }
  },
  "request_id": "req_xyz123"
}
```

### Common Error Codes

| Code | HTTP | Description |
|------|------|-------------|
| INVALID_API_KEY | 401 | API key missing or invalid |
| RATE_LIMIT_EXCEEDED | 429 | Too many requests |
| INVALID_AUDIO | 400 | Audio file invalid or corrupted |
| INVALID_PROOF_PACKAGE | 400 | Proof package format error |
| INVALID_ACCOUNTING_STATE | 400 | Usage accounting state invalid |
| SETTLEMENT_UNAVAILABLE | 500 | Settlement subsystem unavailable |
| SERVICE_UNAVAILABLE | 503 | Service temporarily unavailable |

---

## Webhooks (Beta)

Subscribe to verification events delivered to your endpoint:

### Register Webhook

```
POST /v1/webhooks

{
  "url": "https://yourapp.com/vri-webhook",
  "events": ["usage_recorded", "ledger_anchored"]
}
```

### Webhook Payload

```json
{
  "event": "usage_recorded",
  "timestamp": 1711892405,
  "data": {
    "event_id": "evt_abc123",
    "creator_id": "0x2f8bafbc",
    "source_system": "verification_service",
    "request_id": "req_123456"
  }
}
```

---

## SDKs & Libraries

- **JavaScript/Node.js**: `npm install @vri/sdk`
- **Python**: `pip install vri-sdk`
- **Go**: `go get github.com/vrihq/vri-go`
- **Rust**: `cargo add vri`

---

**Next**: See [Data Model](./data-model.md) for schema details.
