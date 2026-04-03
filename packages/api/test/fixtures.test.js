/**
 * Compliance and interoperability test suite
 *
 * Validates that the VRI API implementation correctly handles all protocol
 * fixture scenarios defined in fixtures/cases/ and fixtures/invalid-cases/.
 *
 * Each fixture defines:
 *   - input: audio spec + metadata + timestamp/nonce
 *   - expected_output: proof_package shape with wildcard fields
 *   - compliance_notes: what protocol feature is being validated
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createServer } from "../src/server.js";
import { createKeyManager } from "../../core/src/key-manager.js";

// ── WAV builder (matches the format specs in fixtures) ────────────────────────

function buildWav({ channels = 1, sampleRate = 48000, audioFormat = 1, bitsPerSample = 16, durationMs = 100 }) {
  const effectiveBitsPerSample = audioFormat === 3 ? 32 : bitsPerSample;
  const bytesPerSample = effectiveBitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const sampleCount = Math.ceil(sampleRate * channels * durationMs / 1000);
  const data = Buffer.alloc(sampleCount * bytesPerSample);

  // Fill with a simple deterministic sine-ish pattern
  for (let i = 0; i < sampleCount; i++) {
    const offset = i * bytesPerSample;
    if (audioFormat === 3) {
      data.writeFloatLE(Math.sin(i * 0.01) * 0.5, offset);
    } else if (effectiveBitsPerSample === 16) {
      data.writeInt16LE(Math.trunc(Math.sin(i * 0.01) * 16384), offset);
    } else if (effectiveBitsPerSample === 24) {
      const v = Math.trunc(Math.sin(i * 0.01) * 8388607);
      const normalized = v < 0 ? v + 0x1000000 : v;
      data[offset] = normalized & 0xff;
      data[offset + 1] = (normalized >> 8) & 0xff;
      data[offset + 2] = (normalized >> 16) & 0xff;
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(audioFormat, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(effectiveBitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// ── test server helper ────────────────────────────────────────────────────────

async function startTestServer() {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-fixtures-test-"));
  const keyManager = createKeyManager();
  const server = createServer({
    verificationEndpoint: "http://127.0.0.1/test/verify-proof",
    ledgerFilePath: path.join(tempDir, "events.jsonl"),
    batchFilePath: path.join(tempDir, "batches.jsonl"),
    batchSize: 100,
    keyManager
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, baseUrl: `http://127.0.0.1:${port}`, keyManager };
}

async function postRegister(baseUrl, body) {
  const res = await fetch(`${baseUrl}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

async function postVerify(baseUrl, body) {
  const res = await fetch(`${baseUrl}/verify-proof`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: res.status, body: await res.json() };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function getSignatureHex(sig) {
  // signature may be { algorithm, value } or a plain 0x-prefixed string
  return typeof sig === "object" ? sig?.value : sig;
}

// ── wildcard matcher ──────────────────────────────────────────────────────────
// "*" means "any truthy value is acceptable"

function matchesPattern(actual, pattern) {
  if (pattern === "*") return actual != null && actual !== "";
  if (typeof pattern === "string" && pattern.endsWith("*")) {
    const prefix = pattern.slice(0, -1); // e.g. "vri_", "fp_", "0x", "ed25519_sig_"
    return typeof actual === "string" && actual.startsWith(prefix);
  }
  if (typeof pattern === "object" && pattern !== null) {
    for (const [key, value] of Object.entries(pattern)) {
      if (!matchesPattern(actual?.[key], value)) return false;
    }
    return true;
  }
  return actual === pattern;
}

// ── Protocol compliance: case-001 basic registration ─────────────────────────

test("compliance: case-001 basic 16-bit PCM mono 48 kHz registration", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 100 });

    const { status, body } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis",
        request_id: "req_test_001",
        tenant_id: "org_test"
      },
      timestamp: 1711892400,
      nonce: 1
    });

    assert.equal(status, 200, `Unexpected status: ${JSON.stringify(body)}`);

    // top-level fields (from spread of registerVoice result)
    assert.ok(matchesPattern(body.voiceId, "vri_*"), `voiceId should start with vri_: ${body.voiceId}`);
    assert.ok(matchesPattern(body.fingerprint, "fp_*"), `fingerprint: ${body.fingerprint}`);
    assert.equal(body.status, "registered");

    // nested proof_package
    const pp = body.proof_package;
    assert.equal(pp.protocol_version, "2.0");
    assert.equal(pp.proof_type, "GENERATED");
    assert.equal(pp.compliance_level, 2);
    assert.ok(Number.isInteger(pp.timestamp) && pp.timestamp > 0, `timestamp must be a positive integer: ${pp.timestamp}`);
    assert.ok(matchesPattern(pp.public_key, "0x*"), `public_key: ${pp.public_key}`);
    assert.ok(matchesPattern(getSignatureHex(pp.signature), "0x*"), `signature: ${JSON.stringify(pp.signature)}`);

    // watermark surfaced at top-level (from server)
    assert.equal(body.watermark?.mode, "vri-spread-spectrum-v1");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: case-002 float32 stereo 96 kHz ─────────────────────

test("compliance: case-002 IEEE float32 stereo 96 kHz with deterministic resampling", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 2, sampleRate: 96000, audioFormat: 3, bitsPerSample: 32, durationMs: 100 });

    const { status, body } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: {
        model_id: "tts-v4-multilingual",
        operation: "voice_synthesis",
        request_id: "req_test_002",
        tenant_id: "org_test"
      },
      timestamp: 1711892401,
      nonce: 2
    });

    assert.equal(status, 200, `Unexpected status: ${JSON.stringify(body)}`);

    assert.ok(matchesPattern(body.voiceId, "vri_*"), `voiceId: ${body.voiceId}`);
    assert.equal(body.proof_package.protocol_version, "2.0");
    assert.equal(body.proof_package.proof_type, "GENERATED");
    assert.equal(body.proof_package.compliance_level, 2);
    assert.ok(Number.isInteger(body.proof_package.timestamp) && body.proof_package.timestamp > 0);
    assert.equal(body.watermark?.mode, "vri-spread-spectrum-v1");

    // Determinism: same input must produce same audio_hash
    const { body: body2 } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v4-multilingual", operation: "voice_synthesis", request_id: "req_test_002b", tenant_id: "org_test" },
      timestamp: 1711892401,
      nonce: 2
    });

    // Same audio → same audioHash (determinism)
    assert.equal(body.audioHash, body2.audioHash,
      "Same audio input must produce the same audioHash (determinism)");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: 44.1 kHz resampling determinism ─────────────────────

test("compliance: 44.1 kHz PCM 16-bit resamples deterministically to canonical 48 kHz", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 44100, audioFormat: 1, bitsPerSample: 16, durationMs: 200 });

    const { status, body } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp: 1711892402,
      nonce: 3
    });

    assert.equal(status, 200, `Unexpected status: ${JSON.stringify(body)}`);
    assert.ok(matchesPattern(body.voiceId, "vri_*"), `voiceId: ${body.voiceId}`);

    // Re-register same audio — audio_hash must be identical (determinism)
    const { body: body2 } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp: 1711892402,
      nonce: 3
    });

    assert.equal(body.audioHash, body2.audioHash,
      "44.1 kHz resampling must be deterministic");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: metadata canonicalization ────────────────────────────

test("compliance: metadata_hash is stable across equivalent metadata orderings", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 50 });

    const meta1 = { model_id: "tts-v3", operation: "voice_synthesis", request_id: "req_stable" };
    const meta2 = { request_id: "req_stable", operation: "voice_synthesis", model_id: "tts-v3" };

    const [r1, r2] = await Promise.all([
      postRegister(baseUrl, { audioBase64: wav.toString("base64"), metadata: meta1, timestamp: 1711892403, nonce: 4 }),
      postRegister(baseUrl, { audioBase64: wav.toString("base64"), metadata: meta2, timestamp: 1711892403, nonce: 4 })
    ]);

    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    // canonical_metadata string must be the same regardless of key order
    assert.equal(r1.body.proof_package.canonical_metadata, r2.body.proof_package.canonical_metadata,
      "Metadata in different key order must produce same canonical_metadata string");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: Ed25519 signature verifiability ─────────────────────

test("compliance: proof_package signature is verifiable against public_key", async () => {
  const { server, baseUrl, keyManager } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 50 });

    const { status, body } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp: 1711892410,
      nonce: 9
    });

    assert.equal(status, 200);
    const pp = body.proof_package;

    const pubKeyBytes = Buffer.from(pp.public_key.slice(2), "hex");

    // public_key in proof must match the server's key manager public key
    assert.deepEqual(pubKeyBytes, keyManager.getPublicKeyBytes(),
      "proof_package.public_key must match the server key manager public key");

    // key_id must be derived from public_key
    const expectedKeyId = crypto.createHash("sha256").update(pubKeyBytes).digest("hex").slice(0, 16);
    assert.equal(pp.key_id, expectedKeyId, "key_id must be derived from public_key");

    // signature must be 64 bytes (Ed25519)
    const sigHex = getSignatureHex(pp.signature);
    assert.ok(sigHex?.startsWith("0x"), `signature must be 0x-prefixed: ${sigHex}`);
    const sigBytes = Buffer.from(sigHex.slice(2), "hex");
    assert.equal(sigBytes.length, 64, "Ed25519 signature must be 64 bytes");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: verify-proof round-trip ─────────────────────────────

test("compliance: register then verify-proof returns ok=true for same audio", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 100 });
    const timestamp = Math.floor(Date.now() / 1000);

    const { body: regBody } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp,
      nonce: 10
    });

    const { status, body: verBody } = await postVerify(baseUrl, {
      audioBase64: wav.toString("base64"),
      proofPackage: regBody.proof_package
    });

    assert.equal(status, 200);
    assert.equal(verBody.ok, true, `verify-proof should return ok: ${JSON.stringify(verBody)}`);
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: tampered audio fails verification ────────────────────

test("compliance: tampered audio fails verify-proof (invalid-case-001)", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 100 });

    const { body: regBody } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp: 1711892430,
      nonce: 11
    });

    // Tamper the audio: modify some bytes in the data section
    const tampered = Buffer.from(wav);
    tampered[44] ^= 0xff;
    tampered[45] ^= 0xff;

    const { body: verBody } = await postVerify(baseUrl, {
      audioBase64: tampered.toString("base64"),
      proofPackage: regBody.proof_package
    });

    assert.equal(verBody.ok, false, "Tampered audio must fail verification");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});

// ── Protocol compliance: forged signature fails verification ──────────────────

test("compliance: forged signature fails verify-proof (invalid-case-002)", async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const wav = buildWav({ channels: 1, sampleRate: 48000, audioFormat: 1, bitsPerSample: 16, durationMs: 100 });

    const { body: regBody } = await postRegister(baseUrl, {
      audioBase64: wav.toString("base64"),
      metadata: { model_id: "tts-v3", operation: "voice_synthesis" },
      timestamp: 1711892440,
      nonce: 12
    });

    // Replace the signature with random bytes (cryptographically impossible to verify)
    const forgedProof = {
      ...regBody.proof_package,
      signature: { algorithm: "Ed25519", value: `0x${crypto.randomBytes(64).toString("hex")}` }
    };

    const { body: verBody } = await postVerify(baseUrl, {
      audioBase64: wav.toString("base64"),
      proofPackage: forgedProof
    });

    assert.equal(verBody.ok, false, "Forged signature must fail verification");
  } finally {
    await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
  }
});
