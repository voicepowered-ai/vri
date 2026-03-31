# Data Model

## Database Schema

VRI uses PostgreSQL for persistent storage with the following core tables:

---

## Core Tables

### creators

Registered voice creators.

```sql
CREATE TABLE creators (
    creator_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    wallet_address VARCHAR(255),         -- Payment address
    public_key BYTEA NOT NULL UNIQUE,    -- Ed25519, 32 bytes
    public_key_version INT DEFAULT 1,    -- For key rotation
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    metadata JSONB,
    verification_status VARCHAR(20),     -- verified, pending, unverified
    
    INDEX (wallet_address),
    INDEX (verification_status)
);
```

### usage_events

Usage records (immutable log).

```sql
CREATE TABLE usage_events (
    event_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES creators(creator_id) ON DELETE RESTRICT,
    audio_hash VARCHAR(64) NOT NULL,
    watermark_payload BYTEA,
    watermark_extracted BOOLEAN DEFAULT true,
    timestamp BIGINT NOT NULL,            -- Unix seconds (server time)
    platform VARCHAR(50),                  -- youtube, spotify, etc.
    context JSONB,                        -- {views: 1000, country: "US", ...}
    verified BOOLEAN DEFAULT true,
    royalty_usdc BIGINT,                  -- In cents (microUSD)
    signature VARCHAR(128),               -- Signed by verification service
    batch_id VARCHAR(64) REFERENCES merkle_batches(batch_id),
    created_at BIGINT NOT NULL,
    
    INDEX (creator_id, timestamp DESC),
    INDEX (platform, timestamp DESC),
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

### wallets

Creator earnings tracking.

```sql
CREATE TABLE wallets (
    creator_id UUID PRIMARY KEY REFERENCES creators(creator_id) ON DELETE CASCADE,
    balance_usdc BIGINT DEFAULT 0,        -- In cents
    lifetime_earnings_usdc BIGINT DEFAULT 0,
    last_settlement BIGINT,               -- Timestamp
    settlement_address VARCHAR(255),      -- External payment address
    settlement_method VARCHAR(20),        -- stripe, ach, crypto
    pending_settlement BIGINT DEFAULT 0,
    updated_at BIGINT NOT NULL,
    
    INDEX (balance_usdc DESC)
);
```

### transactions

Payout records (settlement history).

```sql
CREATE TABLE transactions (
    transaction_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    creator_id UUID REFERENCES creators(creator_id) ON DELETE RESTRICT,
    amount_usdc BIGINT NOT NULL,
    status VARCHAR(20) NOT NULL,          -- pending, completed, failed
    payment_method VARCHAR(20) NOT NULL,
    error_message TEXT,
    external_id VARCHAR(255),             -- Stripe tx, Ethereum hash, etc.
    created_at BIGINT NOT NULL,
    completed_at BIGINT,
    
    INDEX (creator_id, status),
    INDEX (created_at DESC),
    INDEX (status)
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
              └─────→ (1) wallets
                      └──→ (N) transactions

usage_events (N) ──────→ (1) merkle_batches
merkle_batches (1) ──────→ (N) usage_events
```

---

## Indexing Strategy

### High-Priority Indexes

```sql
-- Creator earnings queries
CREATE INDEX idx_usage_events_creator_timestamp 
  ON usage_events(creator_id, timestamp DESC);

-- Platform analytics
CREATE INDEX idx_usage_events_platform_time 
  ON usage_events(platform, timestamp DESC);

-- Ledger integrity checks
CREATE INDEX idx_usage_events_batch_id 
  ON usage_events(batch_id);

-- Wallet balance queries
CREATE INDEX idx_wallets_balance 
  ON wallets(balance_usdc DESC);
```

### Partitioning Strategy (Optional)

For high-volume deployments:

```sql
-- Partition usage_events by month
CREATE TABLE usage_events_2024_03 
  PARTITION OF usage_events
  FOR VALUES FROM ('2024-03-01') TO ('2024-04-01');

-- Partition transactions by year
CREATE TABLE transactions_2024 
  PARTITION OF transactions
  FOR VALUES FROM ('2024') TO ('2025');
```

---

## Data Types

### Monetary Values

All monetary values stored as **BIGINT** (cents, unsigned):

```
1 USD = 100 cents
$54.28 = 5428 (stored as integer)

Arithmetic: Always int64, divide by 100 for display
```

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

### Get Creator's Total Earnings

```sql
SELECT
  c.creator_id,
  w.lifetime_earnings_usdc / 100.0 as total_earned_usd,
  w.balance_usdc / 100.0 as current_balance_usd
FROM creators c
LEFT JOIN wallets w ON c.creator_id = w.creator_id
WHERE c.creator_id = ?;
```

### Total Royalties by Platform (Last 30 Days)

```sql
SELECT
  platform,
  COUNT(*) as usage_count,
  SUM(royalty_usdc) / 100.0 as total_royalties_usd,
  AVG(royalty_usdc) / 100.0 as avg_royalty_usd
FROM usage_events
WHERE
  creator_id = ?
  AND timestamp > EXTRACT(EPOCH FROM NOW()) - 30*86400
  AND verified = true
GROUP BY platform
ORDER BY total_royalties_usd DESC;
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
transactions:      Retained indefinitely (audit trail)
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
2. Increment wallet balance (atomic transaction)
3. Check event was persisted (READ COMMITTED isolation)
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

### Pending Settlements

```sql
SELECT
  c.creator_id,
  w.balance_usdc / 100.0 as pending_usd,
  COUNT(t.transaction_id) as total_payouts,
  MAX(t.completed_at) as last_payout_time
FROM wallets w
JOIN creators c ON w.creator_id = c.creator_id
LEFT JOIN transactions t ON c.creator_id = t.creator_id AND t.status = 'completed'
WHERE w.balance_usdc >= 1000  -- $10 minimum
GROUP BY c.creator_id, w.balance_usdc
ORDER BY w.balance_usdc DESC;
```

---

**Next**: See [Threat Model](./threat-model.md) for security analysis.
