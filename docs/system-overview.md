# System Overview

## Purpose

This document provides a high-level architectural view of VRI, including system components, data flows, integration points, and deployment considerations. It is limited to provenance, verification, and evidentiary infrastructure; downstream business systems are separate integrations.

---

## Architecture Diagram (Legacy)

> The diagram below pre-dates the session-based model. See the updated diagram after this section.

```
┌──────────────────────┐   QR Scan    ┌───────────────────────────┐
│  Voice Actor         │ ──────────→  │  RecordingSessionStore    │
│  (studio app)        │              │  (POST /recording-sessions)│
└──────────────────────┘              │  session_verified: true   │
         │                            └───────────┬───────────────┘
         │ records source audio                   │ session_id
         v                                        │
┌──────────────────────┐              ┌───────────v───────────────┐
│  POST /register-     │ ──────────→  │        API Gateway        │
│  recorded            │  RECORDED    │  • Auth (API key)         │
└──────────────────────┘  evt_id ─┐  │  • Rate limiting          │
                                   │  │  • Gate 1: session_verified│
                                   │  │  • Gate 2: input RECORDED  │
                                   │  │  • Routing                │
                                   │  └──────────┬────────────────┘
                                   │             │ pass
                                   │             v
                                   │  ┌──────────────────────┐
                                   │  │ Inference Adapter    │
                                   │  │                      │
                                   └──│ • input_reference =  │
                                      │   evt_id (verified)  │
┌─────────────────────────────────┐   │ • model_id signed    │
│ External TTS Service            │   │ • actor_id signed    │
│ (OpenAI, ElevenLabs, Custom)   │   │ • session_id signed  │
└────────────────┬────────────────┘   └─────────┬────────────┘
                 │                              │
                 v                              v
         ┌──────────────────────────────────────────┐
         │  Watermark Daemon (Worker Pool)           │
         │  • Inject watermark (LDPC codes)          │
         │  • SNR > 40dB                             │
         └────────────────────────┬─────────────────┘
                                  │
                                  v
                        ┌──────────────────┐
                        │ Signing Service  │
                        │                  │
                        │ • SHA-256 hash   │
                        │ • EdDSA sign:    │
                        │   hash +         │
                        │   session_id +   │
                        │   actor_id +     │
                        │   inference_meta │
                        └────────┬─────────┘
                                 │
                                 v
                      ┌──────────────────────────┐
                      │  Ledger Service           │
                      │  (Immutable Log)          │
                      │  • Append usage event     │
                      │  • Hash-anchor to tree    │
                      └───────────┬──────────────┘
                                  │
                         ┌────────v─────────┐
                         │ Hash Accumulator │
                         │  (Blockchain)    │
                         │ • Merkle tree    │
                         │ • Periodic anchor│
                         └──────────────────┘
```

```
Verification Path:
  POST /verify-proof
    → recompute hash (including session_id, actor_id, inference_metadata)
    → verify Ed25519 signature
    → check ledger inclusion
    → return: who generated, in which session, with which model, from which source
```
---

## Architecture Diagram (Session-Based Model)

```
┌──────────────────────┐   QR Scan
│  Voice Actor         │ ─────────────────────────────────────────────────────┐
│  (studio app)        │                                                      │
└──────────────────────┘                                                      │
         │                                                                    │
         │ records source audio                                               v
         v                                                   RecordingSessionStore
   POST /register-recorded ─────────────────────────────→   (POST /recording-sessions)
         │                                                   session_verified: true
         │  returns: evt_id                                         │
         │                                                          │ session_id
         │                   ┌──────────────────────────────────────┘
         │                   │
         v                   v
   ┌───────────────────────────────────────────────────────────┐
   │                     API Gateway                           │
   │  • Auth (API key)                                         │
   │  • Rate limiting                                          │
   │  • Gate 1: requireVerifiedSession -> session_verified?   │
   │  • Gate 2: requireInputVerification -> input RECORDED?   │
   │  • Routing                                                │
   └────────────────────────────┬──────────────────────────────┘
                                │ pass (session + input verified)
                                v
               ┌────────────────────────────────────┐
               │         Inference Adapter          │
               │  • input_reference = evt_id        │
               │  • model_id, actor_id, session_id  │
               │    all signed into proof           │
               └────────────────┬───────────────────┘
                                │
           ┌────────────────────┘
           │
           v (audio from External TTS: OpenAI, ElevenLabs, Custom)
   ┌───────────────────────────────────────┐
   │   Watermark Daemon (Worker Pool)      │
   │   Inject watermark (LDPC, SNR>40dB)  │
   └────────────────────┬──────────────────┘
                        │
                        v
              ┌─────────────────────────────────────┐
              │         Signing Service              │
              │  SHA-256 hash of:                    │
              │    audio + session_id + actor_id +   │
              │    inference_metadata                │
              │  EdDSA sign -> proof_package         │
              └─────────────────┬────────────────────┘
                                │
                                v
                   ┌─────────────────────────┐
                   │     Ledger Service      │
                   │  Append usage event     │
                   │  Hash-anchor to tree    │
                   └─────────────┬───────────┘
                                 │
                        ┌────────v──────────┐
                        │  Hash Accumulator │
                        │  (Blockchain)     │
                        │  Merkle / anchor  │
                        └───────────────────┘
```

Verification path:

```
POST /verify-proof
  -> recompute hash (includes session_id, actor_id, inference_metadata)
  -> verify Ed25519 signature
  -> check ledger inclusion
  -> returns: who generated, which session, which model, which source audio
```

---

## Core Components

### 1. API Gateway

**Responsibility**: Authentication, routing, rate limiting

**Endpoints**:
```
POST   /v1/generate          Create audio with watermark
POST   /v1/verify            Verify audio + check ledger
GET    /v1/events/:id        Retrieve verification event
GET    /v1/status            System health
```

**Features**:
- API key authentication + JWT refresh
- Per-user rate limits (1000 req/min standard, 10000 req/min pro)
- Request signing (prevent tampering)
- Request/response logging (audit trail)

---

### 2. Inference Adapter

**Responsibility**: Intercept TTS output, trigger watermarking

**Workflow**:
```
TTS Call → Hook Response → Watermark → Sign → Return proof-carrying artifact
```

**Implementation**:
- Plugs into OpenAI SDK, ElevenLabs API, local models
- Captures raw WAV/MP3 from TTS
- MAY use internal queues for processing
- MUST NOT emit protocol-complete output before watermarking and signing complete
- MUST return an explicit incomplete state instead of raw or unsigned audio if processing cannot complete

---

### 3. Watermark Daemon

**Responsibility**: Embed inaudible markers in audio

**Inputs**:
- Raw audio (WAV, MP3, etc.)
- Creator ID
- Timestamp
- Optional metadata

**Process**:
1. Decode audio to PCM
2. Extract STFT (Short-Time Fourier Transform)
3. Compute QMF filterbank (32 subbands)
4. Generate watermark bits via LDPC code
5. Spread bits across time-frequency tiles (with interleaving)
6. Inject amplitude modulation (sub-perceptual)
7. Reconstruct audio via inverse STFT
8. Re-encode to original format (with quality preservation)

**Output**:
- Watermarked audio (imperceptible, robust)
- Watermark payload (binary)
- Verification stats (SNR, bit error rate predicted)

---

### 4. Signing Service

**Responsibility**: Cryptographic signatures over watermark

**Process**:
1. Receive watermark payload from daemon
2. Compute SHA-256 over the v2.0 signed tuple including proof type, compliance level, watermark flag, watermark payload-or-zero, canonical audio hash, timestamp, and canonical metadata
3. Sign hash with creator's private key (EdDSA)
4. Generate proof package (signature + public key + metadata)
5. Store signature in ledger
6. Return proof package to client

**Key Management**:
- Private keys stored in HSM or AWS KMS
- Never transmitted over network
- Rotated annually + on-demand

---

### 5. Verification Service

**Responsibility**: Extract watermark, validate signature, log verification evidence

**Critical Path** (<500ms):
```
1. Receive audio from downstream user
2. Extract watermark via inverse STFT + correlation detection
3. Deserialize watermark_payload
4. Hash payload + metadata + timestamp
5. Verify EdDSA signature with public key from payload
6. If valid: Log verification event, return "verified"
7. If invalid: Invoke fingerprinting forensic path, return "unverified"
```

**Forensic Detection Path** (~1–2s):
```
1. If watermark not found or signature invalid
2. Extract MFCC (Mel-Frequency Cepstrum Coefficients) fingerprint
3. Query fingerprint index for similar voices
4. Compute acoustic distance to known creators
5. Return match confidence + likelihood of creator
```

---

### 6. Ledger Service

**Responsibility**: Immutable verification record + hash anchoring

**Schema**:
```
TABLE usage_events (
  event_id UUID PRIMARY KEY,
  creator_id VARCHAR(255),
  audio_hash VARCHAR(64),  -- SHA256 of watermark payload
  timestamp BIGINT,
  source_system VARCHAR(50),
  context JSON,            -- {request_id, tenant_id, verifier_state, ...}
  signature VARCHAR(128),  -- Signed by verification service
  ledger_anchor VARCHAR(64), -- Hash tree root at time of event
  batch_id VARCHAR(64),    -- For anchoring
)

TABLE hash_tree (
  batch_id VARCHAR(64) PRIMARY KEY,
  events INT,
  merkle_root VARCHAR(64),
  anchor_time BIGINT,
  blockchain_tx VARCHAR(66), -- Ethereum tx hash
)
```

**Anchoring Strategy**:
- Batch up to 10,000 events every 10 minutes
- Compute Merkle tree root
- Publish root to blockchain (Ethereum testnet/mainnet, Solana, etc.)
- Merkle root becomes immutable reference

**Query Guarantees**:
- Append-only: New events can only be added, never modified
- Tamper-evident: Changing any past event breaks Merkle root
- Verifiable: Anyone can recompute root from stored events

---

### 7. Fingerprint Service

**Responsibility**: Acoustic matching for watermark-less audio

**Features**:
- Extract MFCC (40 coefficients)
- Hash-chain for temporal structure
- Index (Approximate Nearest Neighbor search via LSH)
- Returns top-K matches with confidence score

**Process**:
```
Incoming Audio → MFCC Extraction → Hash-chain → LSH Query → Top-K Results
                                                              (confidence: 0–1)
```

**Limitations**:
- No cryptographic proof (probabilistic)
- Can be spoofed by cloning
- Depends on database completeness

---

### 8. Downstream Integrations

Downstream business workflows are intentionally out of scope for the protocol core. Those systems may consume VRI events as evidence inputs, but they remain separate product layers with their own policy, compliance, and accounting requirements.

---

## Data Flow: Generation

```
1. Creator calls VRI API:
   POST /generate {voice_id, text, metadata}

2. Request routed to Inference Adapter

3. Inference Adapter:
   - Calls TTS backend (OpenAI, ElevenLabs, etc.)
   - Receives raw audio

4. Queue watermarking task:
   - Task: {audio_buffer, creator_id, timestamp}
   - Queue: SQS / RabbitMQ

5. Watermark Daemon (worker pool):
   - Receives task from queue
   - Embeds watermark
   - Uploads watermarked audio to CDN
   - Emits event: "watermark_ready"

6. Signing Service (triggered by watermark_ready):
   - Receives watermark payload
   - Signs payload
   - Stores signature in ledger
   - Updates proof_package in DB

7. API Gateway:
   - Receives "proof_package_ready" event
   - Returns to client:
     {
       audio_url,
       watermark_payload,
       signature,
       proof_package
     }

8. Ledger Service:
   - Records generation event
   - Computes Merkle root (batched, periodic)
   - Publishes root to blockchain
```

---

## Data Flow: Verification

```
1. Downstream user calls VRI API:
   POST /verify {audio_url, [proof_package]}

2. Verification Service:
   a. Download audio from URL
   b. Extract watermark via DSP
   c. Deserialize watermark_payload
   
   d. If watermark found:
      - Hash payload
      - Verify EdDSA signature
      - If signature valid → goto step 3
      - If signature invalid → goto step 4

   e. If watermark NOT found:
      - Goto step 4

3. Valid watermark path:
   - Log verification event to ledger
   - Query signer info
   - Return:
     {
       verified: true,
       status: "authentic_watermark",
       creator: "0x...",
       created_at: 1234567890,
       verification_recorded: {event_id, timestamp}
     }

4. Forensic detection: fingerprinting path:
   - Extract audio fingerprint
   - Query fingerprint index
   - Compute similarity to known creators
   - Return:
     {
       verified: false,
       status: "watermark_not_found",
       fingerprint_matches: [
         {creator_id: "0x...", confidence: 0.92},
         {creator_id: "0x...", confidence: 0.85}
       ]
     }
```

---

## Deployment Architecture

### Development

```
Docker Compose (local):
  - API Gateway (localhost:3000)
  - Watermark Daemon (worker)
  - Signing Service (synchronous)
  - Verification Service (localhost:3001)
  - Ledger Service (SQLite)
  - Fingerprint Service (in-memory index)
  - RabbitMQ (queue)
  - Redis (cache)
```

### Production (AWS)

```
API Layer:
  - API Gateway → ALB → ECS Fargate (auto-scaling)
  - Rate limiting: CloudFront + WAF

Worker Layer:
  - Watermark Daemon → ECS Fargate (queue-based scaling)
  - Fingerprint indexing → Batch jobs (periodic)

Data Layer:
  - Ledger → RDS PostgreSQL (multi-AZ)
  - Cache → ElastiCache Redis
  - Queue → SQS (async watermarking)
  - Storage → S3 (audio files)

Blockchain:
  - Merkle root → Ethereum mainnet (Infura)
  - Anchor TX → Every 10 minutes

Monitoring:
  - CloudWatch (logs, metrics)
  - X-Ray (tracing)
  - SNS (alerts)
```

### Production (GCP)

```
API Layer:
  - Cloud Run (auto-scaling containers)
  - Cloud Load Balancing
  - Cloud Armor (WAF)

Worker Layer:
  - Cloud Tasks (async jobs)
  - Cloud Pub/Sub (message broker)

Data Layer:
  - Cloud SQL (PostgreSQL)
  - Firestore (ledger entries, redundancy)
  - Cloud Storage (audio)
  - Memorystore (Redis)

Blockchain:
  - Web3.py → Ethereum via Infura

Monitoring:
  - Cloud Logging
  - Cloud Trace
  - Cloud Alerting
```

---

## Security Boundaries

```
┌──────────────────────────────────────────────────┐
│              Trusted: VRI Infrastructure         │
│  • Private keys (HSM)                           │
│  • Ledger (write-once)                          │
│  • Signing service                              │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│           Semi-Trusted: Blockchain               │
│  • Merkle root publication (immutable)           │
│  • No private data on-chain                      │
└──────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────┐
│        Untrusted: External Audio Sources         │
│  • User-submitted audio (could be forged)        │
│  • Platform responses (could be tampered)        │
│  • Fingerprints (probabilistic, not proof)       │
└──────────────────────────────────────────────────┘
```

---

## Performance Characteristics

| Metric | Target | Actual |
|--------|--------|--------|
| Watermarking latency | <5s | ~2–3s (async) |
| Verification latency (watermark path) | <500ms | ~300–400ms |
| Verification latency (forensic path) | <2s | ~1–1.5s |
| Watermark detection rate | >99% | 99.8% (unwatermarked) |
| False positive rate | <0.01% | <0.001% (signature validates) |
| Ledger write throughput | 10k events/sec | 8k events/sec (batched, tested) |
| Blockchain anchor latency | <10 min | ~8 min (batched) |

---

## Integration Checklist

- [ ] **TTS Integration**: Hook into inference adapter
- [ ] **API Integration**: Implement verification endpoint
- [ ] **Ledger Integration**: Database schema + indexes
- [ ] **Key Management**: HSM or KMS setup
- [ ] **Blockchain**: Select chain, deploy contract
- [ ] **Monitoring**: Logs, metrics, alerts configured
- [ ] **Documentation**: API docs, examples, FAQ
- [ ] **Testing**: Unit, integration, load tests
- [ ] **Compliance**: GDPR review, legal audit
- [ ] **Rollout**: Staged deployment, canary testing

---

**Next**: See [Architecture](./architecture.md) for microservice internals.
