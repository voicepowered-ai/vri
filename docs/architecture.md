# Architecture

## Overview

This document describes the detailed architecture of VRI components, including API specifications, data models, state machines, and internal protocols.

---

## Microservice Design

### 1. API Gateway

**Language**: Node.js + Express  
**Port**: 3000  
**Scaling**: Stateless, horizontal (auto-scaling)

#### Responsibilities
- Request authentication (API key, JWT)
- Request validation
- Rate limiting
- Request/response logging
- Error handling + standardized responses
- Routing to internal services

#### Key Endpoints

```
POST /v1/generate
  Input: {voice_id, text, model, metadata}
  Output: {audio_url, watermark_payload, signature, proof_package}
  Latency: <5s (async)

POST /v1/verify
  Input: {audio_url, [proof_package]}
  Output: {verified, status, creator, created_at, usage_recorded}
  Latency: <500ms (critical path)

GET /v1/events/:event_id
  Output: {audio_hash, creator_id, timestamp, source_system, context}
```

#### Rate Limiting

```javascript
Standard tier:  1000 req/min per API key
Pro tier:       10000 req/min per API key
Enterprise:     Custom

Burst: 50 req in 1-second window (token bucket algorithm)
```

---

### 2. Watermark Daemon

**Language**: Python (librosa + scipy)  
**Concurrency**: Process pool (8–64 workers depending on CPU)  
**Queue**: RabbitMQ / SQS

#### Signal Processing Pipeline

Input: Raw WAV (reference implementation assumption)

```
1. Decode Audio
   └─ Load WAV/MP3 → PCM @ 44.1kHz

2. Feature Extraction
   └─ Compute STFT (hop_length=512, n_fft=2048)
   └─ Frequency resolution: 21.5 Hz/bin

3. QMF Filterbank
   └─ 32 subbands (1.4kHz each)
   └─ Filter banks preserve perceptual qualities

4. Watermark Generation
   └─ Input: [creator_id (32b), timestamp (24b), nonce (8b)]
   └─ LDPC encode: 64b → 256b (4x redundancy)
   └─ Hamming weight optimization

5. Time-Frequency Spreading
   └─ Tile spacing: 512 samples (11.6ms) apart
   └─ Frequency spreading: ±4 bins
   └─ Temporal interleaving: prevent burst error

6. Amplitude Modulation
   └─ Modulation depth: 2–4% of local RMS
   └─ Target SNR: > 40 dB
   └─ Psychoacoustic masking applied

7. Reconstruction
   └─ Inverse STFT
   └─ Overlap-add windowing
   └─ Normalization to prevent clipping

8. Quality Check
   └─ Measure SNR: log(P_signal / P_noise)
   └─ Blind BER estimation (error correcting code check)
   └─ Output stats: {snr_db, ber_est, quality_score}
```

#### Implementation Details

```python
# Pseudocode
def watermark_audio(audio_buffer, creator_id, timestamp):
    # Load audio
    pcm = librosa.load(audio_buffer, sr=44100, mono=False)
    
    # STFT
    stft = librosa.stft(pcm, n_fft=2048, hop_length=512)
    magnitude = np.abs(stft)
    phase = np.angle(stft)
    
    # QMF filterbank
    mel_spec = librosa.feature.melspectrogram(S=magnitude, n_mels=32)
    
    # Watermark payload
    payload = create_watermark_payload(creator_id, timestamp)  # 64b
    
    # LDPC encode
    encoded = ldpc_encode(payload, rate=0.25)  # 256b with 4x redundancy
    
    # Spread across time-frequency
    for i, bit in enumerate(encoded):
        tile_t = (i % 60) * 512  # 60 tiles over duration
        tile_f = (i // 60) * 4    # 4 frequency bins apart
        
        if bit == 1:
            # Modulate amplitude
            magnitude[tile_f:tile_f+4, tile_t:tile_t+512] *= 1.03
    
    # Reconstruct
    watermarked_stft = magnitude * np.exp(1j * phase)
    watermarked_pcm = librosa.istft(watermarked_stft, hop_length=512)
    
    # Quality check
    snr = measure_snr(pcm, watermarked_pcm)
    ber_est = estimate_ber(encoded, channel_model='mp3_96')
    
    return {
        'audio': watermarked_pcm,
        'payload': payload,
        'quality': {
            'snr_db': snr,
            'ber_est': ber_est,
            'score': quality_score(snr, ber_est)
        }
    }
```

#### Worker Pool Management

```
Queue Consumer (RabbitMQ):
  1. Consume task: {audio_s3_uri, creator_id, timestamp, metadata}
  2. Download audio from S3
  3. Process watermarking (2–3 seconds)
  4. Upload watermarked audio to S3
  5. Emit event: "watermark_ready"
  6. Ack message to queue
  7. Back to consuming (next task)

Auto-scaling:
  - CPU threshold: 60% → spin up more workers
  - Queue depth: > 100 messages → add workers
  - Max workers: 64
```

---

### 3. Signing Service

**Language**: Node.js + crypto (TweetNaCl.js for EdDSA)  
**Storage**: Key management service (AWS KMS or HashiCorp Vault)

#### Signing Process

```python
def sign_watermark(creator_id, watermark_payload, metadata):
    # Retrieve creator's private key from KMS
    private_key = kms.get_key(f"creator_{creator_id}")
    
    # Construct the v2.0 signed tuple
    timestamp = int(time.time())
    message = hashlib.sha256(
        b"VRI-SIG-V2\x00" +
        proof_type_code +
        compliance_level_byte +
        watermark_flag +
        watermark_payload_or_zero +
        audio_hash +
        timestamp.to_bytes(8, "big") +
        canonical_metadata
    ).digest()
    
    # Sign with EdDSA
    signature = nacl.signing.SigningKey(private_key).sign(message).signature
    
    # Create proof package
    proof_package = {
        'protocol_version': '2.0',
        'proof_type': 'GENERATED',
        'compliance_level': 2,
        'watermark_payload': base64.b64encode(watermark_payload).decode(),
        'watermark_hex': watermark_payload.hex(),
        'signature': signature.hex(),
        'public_key': public_key_for_creator(creator_id),
        'timestamp': timestamp,
        'metadata': metadata,
        'verification_endpoint': 'https://api.vri.app/v1/verify'
    }
    
    # Store in ledger
    store_signature_in_ledger(creator_id, watermark_payload, signature)
    
    return proof_package
```

#### Key Rotation Policy

```
- Keys rotated annually
- Emergency rotation triggered by:
  - Compromise suspicion
  - Stakeholder request
  - Regulatory requirement
  
- Old keys marked "deprecated" (new generation uses new key)
- Verification still accepts both old and current keys
- 90-day grace period before deleting old keys
```

---

### 4. Verification Service

**Language**: Python (scipy for watermark extraction)  
**Latency Budget**: <500ms critical path, <2s forensic detection path

#### Critical Path (Watermark Present)

```
Input: audio_buffer, [proof_package]

1. Extract Watermark (300ms)
   ├─ STFT analysis (same as watermarking)
   ├─ Correlation detection across time-frequency tiles
   ├─ Error correction (LDPC decoding)
   ├─ Payload deserialization: [creator_id, timestamp, nonce]
   └─ Output: watermark_payload or None

2. Signature Verification (50ms)
   ├─ Hash: watermark_payload + metadata + timestamp
   ├─ EdDSA verify with public_key from payload
   └─ Output: valid (bool)

3. Logging (50ms)
   ├─ Create usage_event record
   ├─ Append to ledger
   └─ Return to client

Total: ~400ms
```

#### Forensic Detection Path (Watermark Missing)

```
Input: audio_buffer

1. Extract Fingerprint (200ms)
   ├─ MFCC extraction (40 coefficients)
   ├─ Hash-chain for temporal structure
   └─ Compute fingerprint hash

2. Index Lookup (500ms)
   ├─ LSH nearest-neighbor search
   ├─ Return top-K matches (K=5)
   ├─ Compute similarity scores (0–1)
   └─ Filter results (confidence > 0.7)

3. Return Partial Results (unverified)
   {
     verified: false,
     status: "watermark_not_found",
     fingerprint_matches: [
       {creator_id, confidence},
       ...
     ]
   }

Total: ~700ms
```

#### Implementation

```python
def verify_audio(audio_buffer, proof_package=None):
    # Load audio
    pcm = librosa.load(audio_buffer, sr=44100, mono=True)
    
    # Try watermark extraction
    watermark_payload = extract_watermark(pcm)
    
    if watermark_payload is not None:
        # Critical path
        signature = proof_package.get('signature')
        public_key = proof_package.get('public_key')
        
        valid = verify_signature(
            watermark_payload,
            signature,
            public_key
        )
        
        if valid:
            # Log to ledger
            creator_id = extract_creator_id(watermark_payload)
            log_usage_event(creator_id, watermark_payload)
            
            return {
                'verified': True,
                'status': 'authentic_watermark',
                'creator': creator_id,
                'created_at': extract_timestamp(watermark_payload),
                'usage_recorded': True
            }
    
    # Forensic detection path
    fingerprint = extract_fingerprint(pcm)
    matches = search_fingerprint_index(fingerprint, top_k=5)
    
    return {
        'verified': False,
        'status': 'watermark_not_found',
        'fingerprint_matches': matches
    }
```

---

### 5. Ledger Service

**Language**: Python + PostgreSQL ORM  
**Database**: PostgreSQL (multi-AZ replication)

#### Database Schema

```sql
CREATE TABLE creators (
    creator_id UUID PRIMARY KEY,
    public_key BYTEA NOT NULL UNIQUE,
    created_at BIGINT,
    updated_at BIGINT,
    metadata JSONB
);

CREATE TABLE usage_events (
    event_id UUID PRIMARY KEY,
    creator_id UUID REFERENCES creators(creator_id),
    audio_hash VARCHAR(64) NOT NULL,
    watermark_payload BYTEA,
    timestamp BIGINT NOT NULL,
    source_system VARCHAR(50),
    context JSONB,  -- {request_id: "...", tenant_id: "...", ...}
    signature VARCHAR(128),
    batch_id VARCHAR(64) REFERENCES merkle_batches(batch_id),
    created_at BIGINT,
    
    FOREIGN KEY (creator_id) REFERENCES creators(creator_id),
    INDEX (creator_id, timestamp),
    INDEX (audio_hash),
    INDEX (batch_id)
);

CREATE TABLE merkle_batches (
    batch_id VARCHAR(64) PRIMARY KEY,
    root_hash VARCHAR(64) NOT NULL UNIQUE,
    event_count INT,
    merkle_proof BYTEA,
    anchor_time BIGINT,
    blockchain_tx VARCHAR(66),
    blockchain_chain VARCHAR(20),
    created_at BIGINT,
    
    INDEX (anchor_time),
    INDEX (blockchain_tx)
);

CREATE TABLE audit_log (
    log_id UUID PRIMARY KEY,
    action VARCHAR(50),  -- create, update, delete
    table_name VARCHAR(50),
    record_id UUID,
    user_id VARCHAR(255),
    changes JSONB,
    timestamp BIGINT,
    signature VARCHAR(128),  -- signed by audit key
    
    INDEX (timestamp),
    INDEX (user_id)
);
```

#### Ledger Operations

```python
def log_usage_event(creator_id, audio_hash, watermark_payload, context):
    """
    Append to ledger (write-once).
    Returns event_id immediately.
    """
    event = UsageEvent(
        event_id=uuid.uuid4(),
        creator_id=creator_id,
        audio_hash=audio_hash,
        watermark_payload=watermark_payload,
        timestamp=int(time.time()),
        source_system=context.get('source_system'),
        context=context,
        batch_id=None  # Will be set during anchoring
    )
    
    session.add(event)
    session.commit()
    
    return event.event_id

def anchor_to_merkle_tree():
    """
    Batch process: every 10 minutes or when event count > threshold.
    """
    # Get unanchored events
    unanchored = session.query(UsageEvent).filter_by(batch_id=None).all()
    
    if len(unanchored) == 0:
        return None
    
    # Build Merkle tree
    hashes = [event.audio_hash.encode() for event in unanchored]
    merkle_root = build_merkle_tree(hashes)
    
    # Create batch
    batch = MerkleBatch(
        batch_id=uuid.uuid4().hex,
        root_hash=merkle_root,
        event_count=len(unanchored),
        anchor_time=int(time.time())
    )
    
    # Update events
    for event in unanchored:
        event.batch_id = batch.batch_id
    
    session.commit()
    
    # Publish to blockchain
    tx_hash = publish_to_blockchain(merkle_root)
    batch.blockchain_tx = tx_hash
    session.commit()
    
    return batch.batch_id

def verify_ledger_tamper():
    """
    Verify Merkle tree integrity.
    """
    batch = session.query(MerkleBatch).filter_by(batch_id=batch_id).first()
    events = session.query(UsageEvent).filter_by(batch_id=batch_id).all()
    
    # Recompute root
    hashes = [event.audio_hash.encode() for event in events]
    recomputed_root = build_merkle_tree(hashes)
    
    # Check against stored root
    if recomputed_root != batch.root_hash:
        return False  # Tampered
    
    # Check against blockchain anchor
    on_chain_root = fetch_from_blockchain(batch.blockchain_tx)
    if recomputed_root != on_chain_root:
        return False  # Blockchain anchor mismatch
    
    return True  # No tampering detected
```

---

### 6. Downstream Business Integrations

Any downstream business workflow is intentionally outside the VRI core. Those capabilities may consume VRI evidence, but they are product extensions rather than protocol requirements.

Implementations that need them should keep them behind a separate service boundary with their own schemas, policies, trust controls, and legal review.

The VRI core should expose canonical proofs, verification events, timestamp evidence, and append-only ledger records. Downstream systems may consume those artifacts, but they MUST NOT redefine the proof semantics or alter canonical protocol outputs.

---

## State Machines

### Audio Watermarking

```
┌─────────────┐
│   PENDING   │
│  (queued)   │
└──────┬──────┘
       │ start processing
       v
┌─────────────┐
│  PROCESSING │
│ (daemon)    │
└──────┬──────┘
       │ watermark complete
       v
┌─────────────┐
│  SIGNED     │
│ (signature) │
└──────┬──────┘
       │ signature verified
       v
┌─────────────┐
│   READY     │
│  (to use)   │
└─────────────┘
```

### Verification Event

```
┌──────────────┐
│  SUBMITTED   │
│ (received)   │
└──────┬───────┘
       │ extract watermark
       v
┌──────────────┐
│  EXTRACTING  │
└──────┬───────┘
       │ watermark found?
       ├─→ YES ────────────────┐
       │                       │
       └─→ NO → FINGERPRINT ┐  │
                              │  │
                              │  ├─→ VALIDATING (signature check)
                              │  │
                              └──┴─→ LOGGING
                                     │
                                     v
                              ┌──────────────┐
                              │  VERIFIED    │
                              │ (+ logged)   │
                              └──────────────┘
```

---

## Communication Protocols

### Service-to-Service (Internal)

**Queue Protocol** (RabbitMQ message format):

```json
{
  "type": "WatermarkTask",
  "task_id": "task_xyz123",
  "creator_id": "0x...",
  "audio_s3_uri": "s3://bucket/key/audio.wav",
  "metadata": {
    "request_id": "req_123456",
    "model_id": "tts-v3",
    "tenant_id": "org_789",
    "operation": "voice_synthesis"
  },
  "timestamp": 1711892400,
  "retry_count": 0,
  "deadline": 1711892410
}
```

**Event Protocol** (async notifications):

```json
{
  "event_type": "watermark_ready",
  "task_id": "task_xyz123",
  "audito_url": "https://cdn.vri.app/...",
  "watermark_payload": "base64(...)",
  "quality_metrics": {
    "snr_db": 42.3,
    "ber_est": 0.001
  },
  "timestamp": 1711892403
}
```

---

## Performance Optimization

### Caching Strategy

```
Layer 1: Application Cache (Redis)
  - Creator public keys (TTL: 1 hour)
  - Recent verification results (TTL: 5 min)
  - Fingerprint index (persistent + updates)

Layer 2: CDN Cache
  - Watermarked audio (served globally)
  - Proof package JSON (cache headers: 1 year)

Layer 3: Database Cache
  - Query results (prepared statements)
  - Ledger reads (read replicas)
```

### Batching & Async

```
Synchronous (critical path):
  - API request → Signature verification → Response
  
Asynchronous (can be delayed):
  - Watermarking (queue-based)
  - Ledger anchoring (batched, 10-min periods)
  - Fingerprint indexing (offline, periodic)
  - Downstream business processing (on-demand, outside core scope)
```

---

**Next**: See [Watermark Specification](./watermark-spec.md) for signal processing details.
