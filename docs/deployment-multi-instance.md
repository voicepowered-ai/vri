# Multi-Instance Deployment

The reference implementation stores session, nonce, revocation, and ledger state in local files. This is correct for single-process deployments and sufficient for studio-local or single-node API setups. When running multiple API server instances behind a load balancer, these stores must be shared or replaced.

This document describes the consistency requirements for each state component and the available options.

---

## State Components and Consistency Requirements

### 1. Nonce Replay Tracker (`nonceReplayStoreFilePath`)

**Purpose:** Prevents signature replay attacks. Records `(creator_id, nonce)` pairs seen during `verify-proof`.

**Consistency requirement:** Strong. If two instances maintain separate nonce stores, a replayed proof can be accepted by the instance that hasn't seen the nonce.

**Options:**

- **Single instance:** file-backed store is sufficient.
- **Multi-instance:** use a shared Redis key (SET NX with TTL) or a Postgres table with a unique constraint on `(creator_id, nonce)`. Inject a custom `nonceTracker` via the `createServer` option.

**Risk of inconsistency:** A replayed proof gets accepted on one node but not another. Depending on load balancer routing, an attacker may exploit this if nonce checking is the only replay guard. The identity session single-use guard (`#usedSessionIds`) provides independent replay protection for identity-bound proofs.

---

### 2. Identity Session Store (`identitySessionStoreFilePath`)

**Purpose:** Tracks QR challenge/redemption lifecycle (`PENDING → AUTHORIZED → CONSUMED`). Prevents session replay.

**Consistency requirement:** Strong. A session MUST be consumed globally, not per-instance.

**Options:**

- **Single instance:** file-backed store is sufficient.
- **Multi-instance:** use a shared store (Redis, Postgres). Inject a custom `identitySessionStore` that implements the same `issue/get/redeem/consume` interface as `IdentitySessionStore`.

**Risk of inconsistency:** An `AUTHORIZED` session could be consumed on two different instances simultaneously if the state is not shared. This would allow a single session to authorize two proofs.

**Implementation pattern for Redis:**

```js
import { createServer } from "@vri/api";
import { createRedisIdentitySessionStore } from "./your-redis-store.js";

const server = createServer({
  identitySessionStore: createRedisIdentitySessionStore({ redis })
});
```

---

### 3. Recording Session Store (`recordingSessionStoreFilePath`)

**Purpose:** Links audio registrations to a voice actor and recording context. Stores `RecordingSession` entities created by studio clients.

**Consistency requirement:** Moderate. Recording sessions are read-heavy (looked up on every `/register` call). Writes happen at session creation and close.

**Options:**

- **Single instance:** file-backed store is sufficient.
- **Multi-instance:** use a shared Postgres table or MongoDB collection. Inject a custom `recordingSessionStore`.

**Risk of inconsistency:** A session created on instance A may not be visible on instance B before replication. This causes 404 errors on `/register` calls routed to a different instance. Sticky sessions or a shared store resolve this.

---

### 4. Revocation Registry (`revocationRegistryFilePath`)

**Purpose:** Records revoked public keys and the time of revocation.

**Consistency requirement:** Eventual consistency is acceptable. A short propagation delay (seconds to minutes) means a revoked key is briefly still accepted. For high-security deployments, use strong consistency.

**Options:**

- **Single instance:** file-backed.
- **Multi-instance:** shared Postgres table or MongoDB collection. Inject a custom `revocationRegistry`.

---

### 5. Ledger (`ledgerFilePath`, `batchFilePath`)

**Purpose:** Append-only event log and batch anchoring. Provides Merkle inclusion proofs.

**Consistency requirement:** Strong for writes. Two instances must not append to the same JSONL file simultaneously (no locking in the reference implementation).

**Options:**

- **Single instance:** JSONL file-backed ledger.
- **Multi-instance:** use the built-in Postgres or MongoDB storage backends:

```js
const server = createServer({
  storageBackend: "postgres",
  batchStorageBackend: "postgres",
  postgresPool: yourPgPool,
  eventTableName: "vri_events",
  batchTableName: "vri_batches"
});
```

Or MongoDB:

```js
const server = createServer({
  storageBackend: "mongodb",
  batchStorageBackend: "mongodb",
  mongoClient: yourMongoClient,
  mongoDb: "vri",
  eventCollectionName: "events",
  batchCollectionName: "batches"
});
```

**Risk of JSONL in multi-instance:** concurrent appends to the same file produce interleaved or truncated lines. The reference JSONL storage does not implement advisory locking.

---

## Deployment Profiles

### Single-Node Studio

All state is file-backed. Suitable for:
- A DAW plugin host.
- A single-server recording studio API.
- Local development and testing.

```js
const server = createServer({
  ledgerFilePath: "/data/vri/events.jsonl",
  batchFilePath: "/data/vri/batches.jsonl",
  nonceReplayStoreFilePath: "/data/vri/nonces.json",
  identitySessionStoreFilePath: "/data/vri/sessions.json",
  recordingSessionStoreFilePath: "/data/vri/recording-sessions.json",
  revocationRegistryFilePath: "/data/vri/revocations.json"
});
```

### Multi-Node API Cluster

Shared backends for all stateful components. File paths are omitted; all state lives in the database.

```js
const server = createServer({
  storageBackend: "postgres",
  batchStorageBackend: "postgres",
  postgresPool,
  identitySessionStore: createRedisIdentitySessionStore({ redis }),
  nonceTracker: createRedisNonceTracker({ redis }),
  recordingSessionStore: createPgRecordingSessionStore({ pool: postgresPool }),
  revocationRegistry: createPgRevocationRegistry({ pool: postgresPool })
});
```

---

## File Permissions

All file-backed stores are written with mode `0600` (owner read/write only). This prevents other OS users from reading session nonces, identity tokens, or revocation records. Ensure the process runs under a dedicated service account with no shell access.

---

## Ledger Crash Recovery

If the API process crashes between writing a batch record and rewriting the event records (the two-step commit in `anchorPendingEvents`), the state on restart is:

- The batch record exists in `batches.jsonl`.
- Some or all events still have `ledger_batch_id: null`.

On the next anchor cycle, pending events (those with no `ledger_batch_id`) will be included in a new batch. The orphaned batch from the crashed cycle will remain in storage but will not affect correctness — it simply has no events pointing to it.

If you require strict reconciliation, scan for batches whose `event_ids` list contains event IDs that do not reference that `batch_id`, and re-run the rewrite step.
