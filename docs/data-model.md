# Data Model

## Database Schema

VRI uses PostgreSQL for persistent storage with the following core tables:

Core VRI storage covers signing identities, proof events, append-only ledger state, and auditability. Any downstream business workflows are optional product extensions and are not required by the protocol core.

---

## Core Tables

### creators

Registered signing identities.

```sql
CREATE TABLE creators (
    creator_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    public_key BYTEA NOT NULL UNIQUE,    -- Ed25519, 32 bytes
    public_key_version INT DEFAULT 1,    -- For key rotation
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata JSONB,
    verification_status VARCHAR(20),     -- verified, pending, unverified
    
    INDEX (verification_status)
);
```

### usage_events

Verification and evidence records (immutable log).

```sql
CREATE TABLE usage_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES creators(creator_id) ON DELETE RESTRICT,
    audio_hash VARCHAR(64) NOT NULL,
    watermark_payload BYTEA,
    watermark_extracted BOOLEAN DEFAULT true,
    timestamp BIGINT NOT NULL,            -- Unix seconds (server time)
    source_system VARCHAR(50),            -- generation system or verification system
    context JSONB,                        -- {request_id: "...", tenant_id: "...", ...}
    verified BOOLEAN DEFAULT true,
    signature VARCHAR(128),               -- Signed by verification service
    batch_id VARCHAR(64) REFERENCES merkle_batches(batch_id),
    created_at BIGINT NOT NULL,
    
    INDEX (creator_id, timestamp DESC),
    INDEX (source_system, timestamp DESC),
    INDEX (verified),
    INDEX (batch_id)
);
```

### merkle_batches

Cryptographic hash anchors for ledger integrity.

```sql
CREATE TABLE merkle_batches (
    batch_id VARCHAR(64) PRIMARY KEY,
    root_hash VARCHAR(64) NOT NULL UNIQUE,
    event_count INT NOT NULL,
    merkle_proof BYTEA,                   -- Merkle tree structure
    anchor_time BIGINT NOT NULL,
    blockchain_chain VARCHAR(20),         -- ethereum, solana, etc.
    blockchain_tx VARCHAR(66),            -- Transaction hash
    blockchain_confirmed BOOLEAN DEFAULT false,
    created_at BIGINT NOT NULL,
    
    INDEX (anchor_time),
    INDEX (blockchain_tx),
    INDEX (blockchain_confirmed)
);
```

### audit_log

All modifications logged for compliance.

```sql
CREATE TABLE audit_log (
    log_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    action VARCHAR(50),                   -- create, update, delete
    table_name VARCHAR(50),
    record_id UUID,
    user_id VARCHAR(255),                 -- API key or service account
    changes JSONB,                        -- {old: {...}, new: {...}}
    signature VARCHAR(128),               -- Signed by audit key
    timestamp BIGINT NOT NULL,
    
    INDEX (timestamp DESC),
    INDEX (user_id, timestamp DESC),
    INDEX (action)
);
```

---

## Relationships

```
creators (1) ──────→ (N) usage_events

usage_events (N) ──────→ (1) merkle_batches
merkle_batches (1) ──────→ (N) usage_events
```

---

## Indexing Strategy

### High-Priority Indexes

```sql
-- Creator evidence queries
CREATE INDEX idx_usage_events_creator_timestamp 
  ON usage_events(creator_id, timestamp DESC);

-- Source-system analytics
CREATE INDEX idx_usage_events_source_time 
  ON usage_events(source_system, timestamp DESC);

-- Ledger integrity checks
CREATE INDEX idx_usage_events_batch_id 
  ON usage_events(batch_id);
```

### Partitioning Strategy (Optional)

For high-volume deployments:

```sql
-- Partition usage_events by month
CREATE TABLE usage_events_2024_03 
  PARTITION OF usage_events
  FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

```

---

## Data Types

### Timestamps

All timestamps are **BIGINT** (Unix seconds):

```
1711892400 = March 31, 2026 at 14:00:00 UTC

Conversion:
  To ISO: datetime.utcfromtimestamp(timestamp).isoformat()
  To Unix: int(datetime.utcnow().timestamp())
```

### Hashes

Stored as **VARCHAR(64)** (hex strings):

```
SHA256: 64 hex chars = 32 bytes
Example: "8b3f1c7e2b4a6d9f1c3e5a7b9d1f3e5a"
```

### Cryptographic Keys

Stored as **BYTEA** (binary):

```
Ed25519 public key:  32 bytes
EdDSA signature:     64 bytes
Watermark payload:   8 bytes (64 bits)
```

---

## Query Patterns

### Get Creator's Recent Verified Events

```sql
SELECT
  c.creator_id,
  COUNT(ue.event_id) as verified_event_count,
  MAX(ue.timestamp) as last_verified_timestamp
FROM creators c
LEFT JOIN usage_events ue ON c.creator_id = ue.creator_id AND ue.verified = true
WHERE c.creator_id = ?;
```

### Verified Events By Source System (Last 30 Days)

```sql
SELECT
  source_system,
  COUNT(*) as event_count
FROM usage_events
WHERE
  creator_id = ?
  AND timestamp > EXTRACT(EPOCH FROM NOW()) - 30*86400
  AND verified = true
GROUP BY source_system
ORDER BY event_count DESC;
```

### Ledger Integrity Verification

```sql
SELECT
  mb.batch_id,
  COUNT(ue.event_id) as actual_count,
  mb.event_count as recorded_count,
  CASE
    WHEN COUNT(ue.event_id) = mb.event_count THEN 'OK'
    ELSE 'MISMATCH'
  END as integrity_status
FROM merkle_batches mb
LEFT JOIN usage_events ue ON mb.batch_id = ue.batch_id
GROUP BY mb.batch_id, mb.event_count;
```

---

## Data Retention

```
Policy:

usage_events:      Retained indefinitely (immutable ledger)
audit_log:         Retained for 7 years (regulatory compliance)

Backups:
  - Daily snapshots (retained 30 days)
  - Monthly archives (retained 7 years)
  - Cross-region replication (for disaster recovery)
```

---

## Consistency & Durability

### ACID Properties

- **Atomicity**: All ledger entries ACID-compliant
- **Consistency**: Merkle root computed atomically with batch
- **Isolation**: Serializable isolation for critical paths
- **Durability**: Write-ahead logging (WAL), 2+ replicas

### Ledger Write Guarantee

```
Usage Event Recording:

1. Write event to usage_events table (WAL enabled)
2. Check event was persisted (READ COMMITTED isolation)
3. Trigger any downstream systems outside the core transaction boundary
4. Return event_id to client

Retry logic:
  - Connection timeout: Retry up to 3 times
  - Deadlock: Retry with exponential backoff
  - Serialization conflict: Retry atomically
```

---

## Monitoring Queries

### Detect Watermark Failures

```sql
SELECT
  DATE_TRUNC('hour', TO_TIMESTAMP(timestamp)),
  COUNT(*) as total_events,
  SUM(CASE WHEN watermark_extracted = FALSE THEN 1 ELSE 0 END) as failed_extractions,
  ROUND(
    100.0 * SUM(CASE WHEN watermark_extracted = FALSE THEN 1 ELSE 0 END) / COUNT(*),
    2
  ) as failure_rate_percent
FROM usage_events
WHERE timestamp > EXTRACT(EPOCH FROM NOW()) - 86400
GROUP BY DATE_TRUNC('hour', TO_TIMESTAMP(timestamp))
ORDER BY DATE_TRUNC DESC;
```

### Verification Activity Summary

```sql
SELECT
  creator_id,
  COUNT(*) as recent_events,
  MAX(timestamp) as last_event_time
FROM usage_events
WHERE timestamp > EXTRACT(EPOCH FROM NOW()) - 86400
GROUP BY creator_id
ORDER BY recent_events DESC;
```

---

**Next**: See [Threat Model](./threat-model.md) for security analysis.
