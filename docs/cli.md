# CLI Reference

The `vri` CLI provides local proof generation and verification, plus read access to ledger state via the API.

## Installation

```bash
# From the repository root
npm install

# The CLI is available as:
node packages/cli/src/index.js <command> [args]

# Or, if installed globally:
vri <command> [args]
```

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `VRI_API_URL` | `http://localhost:8787` | Base URL of the VRI API server for ledger commands |
| `VRI_PRIVATE_KEY_PEM` | _(ephemeral)_ | PEM-encoded Ed25519 private key for signing. If absent, a key is generated per process and discarded. |

For production use, always set `VRI_PRIVATE_KEY_PEM` to a stable key. An ephemeral key means proofs cannot be re-verified against a known creator identity across restarts.

---

## Commands

### `vri register <audio-file>`

Registers a local audio file and emits a Proof Package.

```bash
vri register examples/test/audio.wav
```

Reads the WAV file, canonicalizes it (24-bit PCM, 48 kHz), computes `audio_hash`, signs the proof locally, and prints the full registration result as JSON to stdout.

**Output** (abridged):

```json
{
  "voiceId": "vri:local:0x2f8bafbc...",
  "status": "registered",
  "proofType": "GENERATED",
  "complianceLevel": 2,
  "audioHash": "0x...",
  "proofPackage": {
    "protocol_version": "2.0",
    "proof_type": "GENERATED",
    "compliance_level": 2,
    "audio_hash": "0x...",
    "signature": { "algorithm": "Ed25519", "value": "0x..." },
    "public_key": "0x...",
    "creator_id": "0x...",
    "timestamp": 1774992877
  }
}
```

**Note:** This command signs locally without contacting the API server. No ledger event is created. For Level 3 proofs with ledger anchoring, use `POST /register` on the API server.

---

### `vri verify <voice-id>`

Queries the API server to look up a previously registered voice by ID.

```bash
vri verify vri:local:0x2f8bafbc
```

Sends `GET /verify?voiceId=<id>` to the API and prints the response. Requires the API server to be running and the voice ID to exist in the ledger.

---

### `vri verify-proof <audio-file> <proof-file>`

Verifies a local audio file against a proof package JSON file, entirely offline.

```bash
vri verify-proof examples/test/audio.wav examples/test/proof.json
```

Reads both files, canonicalizes the audio, reconstructs the message digest, and verifies the Ed25519 signature. No network call is made.

**Output (valid proof):**

```json
{
  "ok": true,
  "reason": "VALID",
  "trust_level": "HIGH",
  "cryptographic_valid": true,
  "watermark": "present",
  "identity_valid": true
}
```

**Output (tampered audio):**

```json
{
  "ok": false,
  "reason": "HASH_MISMATCH",
  "trust_level": "LOW",
  "cryptographic_valid": false
}
```

---

### `vri events <event-id>`

Fetches a ledger usage event from the API server.

```bash
vri events evt_01abc123
```

Sends `GET /events/<event-id>` and prints the event record as JSON.

---

### `vri batches <batch-id>`

Fetches a ledger batch record from the API server.

```bash
vri batches batch_01abc123
```

Sends `GET /batches/<batch-id>` and prints the batch record including Merkle root, event count, and anchor status.

---

### `vri proofs <event-id>`

Fetches the Merkle inclusion proof for a ledger event.

```bash
vri proofs evt_01abc123
```

Sends `GET /proofs/<event-id>` and prints the inclusion proof object. The proof can be used to verify that the event is included in the declared batch root without downloading the full ledger.

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Missing arguments, unknown command, or runtime error |

Errors are printed to stderr as `{ "error": "<message>" }` JSON.

---

## Examples

**Register an audio file and save the proof:**

```bash
vri register recording.wav > proof.json
```

**Verify the proof later, offline:**

```bash
vri verify-proof recording.wav proof.json
```

**Check a ledger event after API registration:**

```bash
vri events evt_01abc123 | jq '.ledger_anchor'
```

**Check whether a batch has been anchored externally:**

```bash
vri batches batch_01abc123 | jq '.blockchain_tx'
```
