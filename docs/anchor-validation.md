# Anchor Validation

This document describes how VRI validates ledger batches, Merkle inclusion proofs, and external anchor publications.

---

## Ledger Event Chain

Every event appended to the ledger carries:

| Field | Description |
|---|---|
| `event_id` | Unique identifier (`evt_<uuid>`) |
| `sequence` | Monotonically increasing integer (1-based) |
| `content_hash` | `SHA-256(canonical_event_json)` — integrity of the event payload |
| `previous_anchor` | `chain_anchor` of the preceding event (or `0x00…00` for the first) |
| `chain_anchor` | `SHA-256(previous_anchor \|\| event_fields)` — chain integrity |

The `chain_anchor` links every event to all prior events. Inserting, deleting, or modifying any event breaks the chain from that point forward.

---

## Merkle Batch Structure

When events are anchored into a batch, the ledger:

1. Collects all pending events (those with `ledger_batch_id: null`).
2. Computes `root_hash = buildMerkleRoot(event.content_hash for each event)`.
3. Creates a batch record with `batch_id`, `root_hash`, `event_ids`, and `batch_anchor`.
4. Writes the batch **before** rewriting events (crash-safe order).
5. Updates each event with `ledger_batch_id`, `ledger_anchor = root_hash`, and `batch_anchor`.

### Batch record fields

```json
{
  "batch_id": "batch_<uuid>",
  "root_hash": "0x...",
  "event_count": 12,
  "event_ids": ["evt_...", "..."],
  "previous_batch_anchor": "0x...",
  "batch_anchor": "0x...",
  "anchor_time": 1774992877,
  "blockchain_chain": null,
  "blockchain_tx": null,
  "blockchain_confirmed": false,
  "external_anchor_provider": null,
  "external_anchor_id": null,
  "external_anchor_published_at": null
}
```

---

## Merkle Inclusion Proof

`GET /proofs/:event-id` returns a Merkle inclusion proof for a single event:

```json
{
  "event": { ... },
  "batch": { ... },
  "proof": ["0x...", "0x..."],
  "leaf_hash": "0x...",
  "root_hash": "0x...",
  "verified": true
}
```

### Verifying the inclusion proof

To verify independently:

1. Compute `leaf_hash = event.content_hash`.
2. Walk the `proof` array. At each step, combine the current hash with the sibling:
   - If the current node is a left child: `parent = SHA-256(current || sibling)`.
   - If the current node is a right child: `parent = SHA-256(sibling || current)`.
3. The final computed hash must equal `batch.root_hash`.
4. Confirm `batch.root_hash` matches the `ledger_anchor` stored on the event.

A `verified: false` response means the event is not yet batched or the proof cannot be reconstructed.

---

## External Anchor Publication

Level 3 proofs may include an external anchor that publishes the batch root to an external service (blockchain, notary, transparency log).

### Publication flow

1. Client calls `POST /batches/:id/publish-anchor` with `{ provider, endpoint, network }`.
2. The API validates the endpoint against the configured allowlist.
3. The API posts the batch payload to the external endpoint.
4. The response is validated before being stored.

### Response validation rules

The API enforces the following on the anchor response before updating the batch record:

| Field | Validation |
|---|---|
| `transactionHash` | If present, must be a 64-character hex string (with or without `0x` prefix) |
| `publishedAt` | If present, must be a Unix timestamp within ±30 days of now |
| `anchorId` | If present, must be a string |
| `confirmed` | Stored as-is; defaults to `false` if absent |

A response that fails these checks throws an error and the batch record is not updated. The publication can be retried.

### Allowlist configuration

External anchor endpoints must be explicitly allowed:

```js
const server = createServer({
  externalAnchorAllowlist: ["https://anchor.example.com"],
  externalAnchorAllowPrivateNetworks: false,   // block 10.x, 192.168.x, etc.
  externalAnchorAllowLocalhost: false,          // block 127.0.0.1 / ::1
  externalAnchorAllowInsecureHttp: false,       // require HTTPS
  externalAnchorTimeoutMs: 10000,
  externalAnchorMaxResponseBytes: 65536
});
```

If `externalAnchorAllowlist` is empty, all external anchor publication is blocked.

### Async scheduling

For non-blocking publication, use the batch scheduler:

```bash
POST /batches/:id/publish-anchor
{ "provider": "ethereum", "endpoint": "https://anchor.example.com", "network": "mainnet", "async": true }
```

The scheduler retries with exponential backoff (default: up to 5 retries, max 60 seconds between attempts). Queue size is limited to 1000 items; exceeding it raises an error.

`GET /scheduler/status` returns current queue metrics.

---

## Verifying a Level 3 Proof

A Level 3 proof carries `usage_event_id` and `ledger_anchor`. To verify independently:

1. Fetch the event: `GET /events/:usage_event_id`.
2. Verify `event.ledger_anchor` matches `proof_package.ledger_anchor`.
3. Fetch the inclusion proof: `GET /proofs/:usage_event_id`.
4. Verify the Merkle proof (see above).
5. If external anchoring is present, verify `batch.blockchain_tx` exists on the declared blockchain and that the transaction payload contains `batch.root_hash`.

Steps 1–4 can be performed offline against a downloaded ledger snapshot. Step 5 requires access to the external anchor service or blockchain.

---

## Crash Safety

The batch-first write order ensures that a crash between the two ledger writes produces a recoverable state:

| Scenario | State | Recovery |
|---|---|---|
| Crash before batch write | No batch, events unbatched | Next anchor cycle includes these events in a new batch |
| Crash after batch write, before event rewrite | Batch exists, events still unbatched | Next anchor cycle detects events as pending, may create a second batch |
| Crash after both writes | Consistent | None needed |

Orphaned batches (batch exists but no events reference it) are harmless. They do not affect the integrity of proofs issued from valid batches.
