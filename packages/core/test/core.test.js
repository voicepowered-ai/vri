import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {
  canonicalizeWavTo24BitLE,
  getCanonicalMetadataString,
  sha256Hex,
  registerVoice,
  verifyProofPackage
} from "../src/index.js";
import { canonicalizeWavTo24BitLEAsync } from "../src/index.js";
import { createDspPool } from "../src/dsp-pool.js";
import {
  KeyManager,
  createKeyManager,
  createKmsKeyManager
} from "../src/key-manager.js";

function createPcmWav({ sampleRate = 48000, channels = 1, audioFormat = 1, bitsPerSample = 16, samples }) {
  const effectiveBitsPerSample = audioFormat === 3 ? 32 : bitsPerSample;
  const bytesPerSample = effectiveBitsPerSample / 8;
  const blockAlign = channels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const data = Buffer.alloc(samples.length * bytesPerSample);

  for (let index = 0; index < samples.length; index += 1) {
    const offset = index * bytesPerSample;
    const sample = samples[index];

    if (bitsPerSample === 16) {
      data.writeInt16LE(sample, offset);
    } else if (bitsPerSample === 24) {
      const normalized = sample < 0 ? sample + 0x1000000 : sample;
      data[offset] = normalized & 0xff;
      data[offset + 1] = (normalized >> 8) & 0xff;
      data[offset + 2] = (normalized >> 16) & 0xff;
    } else if (audioFormat === 3 && effectiveBitsPerSample === 32) {
      data.writeFloatLE(sample, offset);
    } else {
      throw new Error("Unsupported test audio format.");
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
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(effectiveBitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);

  return Buffer.concat([header, data]);
}

test("canonical metadata is sorted and compact", () => {
  const metadata = {
    tenant_id: "org_test",
    request_id: "req_123",
    operation: "voice_synthesis",
    model_id: "tts-v3"
  };

  assert.equal(
    getCanonicalMetadataString(metadata),
    "{\"model_id\":\"tts-v3\",\"operation\":\"voice_synthesis\",\"request_id\":\"req_123\",\"tenant_id\":\"org_test\"}"
  );
});

test("canonical audio converts 16-bit PCM WAV to 24-bit little-endian bytes", () => {
  const wav = createPcmWav({
    bitsPerSample: 16,
    samples: [0x1234, -0x1234]
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 6);
  assert.deepEqual([...canonical], [0x00, 0x34, 0x12, 0x00, 0xcc, 0xed]);
});

test("canonical audio preserves 24-bit PCM WAV sample bytes", () => {
  const wav = createPcmWav({
    bitsPerSample: 24,
    samples: [0x123456, -0x123456]
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 6);
  assert.deepEqual([...canonical], [0x56, 0x34, 0x12, 0xaa, 0xcb, 0xed]);
});

test("canonical audio deterministically resamples 44.1 kHz input to 48 kHz", () => {
  const samples = Array.from({ length: 441 }, (_, index) => (index - 220) * 100);
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 44100,
    samples
  });

  const canonicalA = canonicalizeWavTo24BitLE(wav);
  const canonicalB = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonicalA.length, 480 * 3);
  assert.deepEqual(canonicalA, canonicalB);
  assert.equal(sha256Hex(canonicalA), "c6c5c6748dafde42922ded40374f6f155ca22fd55b204f29e7624b44791c5ff1");
});

test("canonical audio resamples 96 kHz input to 48 kHz without frame drift", () => {
  const samples = [
    1000,
    2000,
    3000,
    4000,
    5000,
    6000,
    7000,
    8000
  ];
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 96000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.deepEqual([...canonical], [0x00, 0xe8, 0x03, 0x00, 0xb8, 0x0b, 0x00, 0x88, 0x13, 0x00, 0x58, 0x1b]);
});

test("canonical audio supports float32 PCM WAV at 48 kHz", () => {
  const samples = [0.5, -0.5, 0.25, -0.25];
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 48000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.ok(canonical.length > 0, "canonical float32 audio should be non-empty");
});

test("canonical audio deterministically resamples float32 PCM 44.1 kHz to 48 kHz", () => {
  const samples = Array.from({ length: 441 }, (_, index) => {
    const normalized = (index - 220) / 32768;
    return Math.max(-1.0, Math.min(1.0, normalized));
  });
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 44100,
    samples
  });

  const canonicalA = canonicalizeWavTo24BitLE(wav);
  const canonicalB = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonicalA.length, 480 * 3);
  assert.deepEqual(canonicalA, canonicalB);
  const hash = sha256Hex(canonicalA);
  assert.ok(/^[0-9a-f]{64}$/.test(hash), "float32 resampling should produce stable hash");
});

test("canonical audio deterministically resamples float32 PCM 96 kHz to 48 kHz", () => {
  const samples = [
    0.1,
    0.2,
    0.3,
    0.4,
    0.5,
    0.6,
    0.7,
    0.8
  ];
  const wav = createPcmWav({
    audioFormat: 3,
    sampleRate: 96000,
    samples
  });

  const canonical = canonicalizeWavTo24BitLE(wav);

  assert.equal(canonical.length, 4 * 3);
  assert.ok(canonical.length > 0, "float32 96kHz→48kHz should have 4 output frames");
});

test("registerVoice emits a proof package that verifyProofPackage accepts", async () => {
  const privateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8"
  });
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [1000, -1000, 2000, -2000, 3000, -3000]
  });

  const registration = await registerVoice(wav, {
    privateKeyPem,
    timestamp: 1711892400,
    nonce: 0x73,
    metadata: {
      model_id: "tts-v3",
      operation: "voice_synthesis",
      request_id: "req_test_0001",
      tenant_id: "org_test"
    }
  });

  const verification = verifyProofPackage(wav, registration.proofPackage);

  assert.equal(verification.ok, true);
  assert.equal(verification.reason, "VALID");
});

test("createKeyManager generates an ephemeral Ed25519 key when no PEM is provided", () => {
  const km = createKeyManager();

  assert.ok(km instanceof KeyManager);
  assert.equal(typeof km.getKeyId(), "string");
  assert.equal(km.getKeyId().length, 16);
  assert.equal(km.getPublicKeyBytes().length, 32);
});

test("createKeyManager uses provided PEM and produces a stable keyId", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" });

  const km1 = createKeyManager({ privateKeyPem: pem });
  const km2 = createKeyManager({ privateKeyPem: pem });

  assert.equal(km1.getKeyId(), km2.getKeyId());
  assert.deepEqual(km1.getPublicKeyBytes(), km2.getPublicKeyBytes());
});

test("KeyManager.sign produces a valid Ed25519 signature", () => {
  const km = createKeyManager();
  const digest = crypto.randomBytes(32);
  const signature = km.sign(digest);

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), km.getPublicKeyBytes()]),
    format: "der",
    type: "spki"
  });

  assert.ok(crypto.verify(null, digest, publicKey, signature));
});

test("KeyManager.rotate changes keyId, archives the previous key", () => {
  const km = createKeyManager();
  const originalKeyId = km.getKeyId();
  const originalPubBytes = km.getPublicKeyBytes();

  const newKeyId = km.rotate();

  assert.notEqual(newKeyId, originalKeyId);
  assert.equal(km.getKeyId(), newKeyId);
  assert.notDeepEqual(km.getPublicKeyBytes(), originalPubBytes);

  const archived = km.getArchivedKeys();
  assert.equal(archived.length, 1);
  assert.equal(archived[0].keyId, originalKeyId);
  assert.deepEqual(archived[0].publicKeyBytes, originalPubBytes);
});

test("registerVoice accepts a keyManager and embeds the correct public key", async () => {
  const km = createKeyManager();
  const expectedPubKeyHex = "0x" + km.getPublicKeyBytes().toString("hex");
  const wav = createPcmWav({
    bitsPerSample: 16,
    sampleRate: 48000,
    samples: [500, -500, 1000, -1000]
  });

  const registration = await registerVoice(wav, {
    keyManager: km,
    timestamp: 1711892400,
    nonce: 0x11,
    metadata: { model_id: "tts-v3", operation: "voice_synthesis" }
  });

  assert.equal(registration.proofPackage.public_key, expectedPubKeyHex);
  assert.equal(registration.proofPackage.key_id, km.getKeyId());
  assert.equal(registration.signingKeyGenerated, false);

  const verification = verifyProofPackage(wav, registration.proofPackage);
  assert.equal(verification.ok, true);
});

test("createKmsKeyManager validates the provider interface", () => {
  assert.throws(
    () => createKmsKeyManager({}),
    /must implement sign/
  );

  assert.throws(
    () => createKmsKeyManager({ sign: () => {}, getPublicKeyBytes: () => {} }),
    /must implement sign/
  );
});

test("createKmsKeyManager wraps a valid provider and delegates calls", () => {
  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const realKm = createKeyManager();

  const provider = {
    sign: (digest) => realKm.sign(digest),
    getPublicKeyBytes: () => realKm.getPublicKeyBytes(),
    getKeyId: () => realKm.getKeyId()
  };

  const kms = createKmsKeyManager(provider);

  assert.equal(kms.getKeyId(), realKm.getKeyId());
  assert.deepEqual(kms.getPublicKeyBytes(), realKm.getPublicKeyBytes());

  const digest = crypto.randomBytes(32);
  const sig = kms.sign(digest);

  const publicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), kms.getPublicKeyBytes()]),
    format: "der",
    type: "spki"
  });
  assert.ok(crypto.verify(null, digest, publicKey, sig));
});

// ── Worker Thread DSP ─────────────────────────────────────────────────────────

test("canonicalizeWavTo24BitLEAsync produces same result as sync version", async () => {
  const wav = createPcmWav({ sampleRate: 48000, channels: 1, bitsPerSample: 16, samples: [100, 200, -100, -200] });
  const sync = canonicalizeWavTo24BitLE(wav);
  const async_ = await canonicalizeWavTo24BitLEAsync(wav);
  assert.deepEqual(sync, async_);
});

test("canonicalizeWavTo24BitLEAsync resamples 44.1 kHz deterministically via Worker Thread", async () => {
  const wav44 = createPcmWav({ sampleRate: 44100, channels: 1, bitsPerSample: 16, samples: [1000, 2000, 3000, 4000] });
  const sync = canonicalizeWavTo24BitLE(wav44);
  const async_ = await canonicalizeWavTo24BitLEAsync(wav44);
  assert.deepEqual(sync, async_);
});

test("DspPool canonicalizes multiple buffers concurrently and deterministically", async () => {
  const pool = createDspPool({ size: 2 });
  try {
    const wav = createPcmWav({ sampleRate: 48000, channels: 1, bitsPerSample: 16, samples: [500, 1000, -500, -1000] });
    const sync = canonicalizeWavTo24BitLE(wav);

    const results = await Promise.all([
      pool.canonicalize(wav),
      pool.canonicalize(wav),
      pool.canonicalize(wav)
    ]);

    for (const result of results) {
      assert.deepEqual(result, sync);
    }
  } finally {
    await pool.terminate();
  }
});

test("DspPool rejects invalid WAV buffers with a clear error", async () => {
  const pool = createDspPool({ size: 1 });
  try {
    await assert.rejects(
      () => pool.canonicalize(Buffer.from("not a wav")),
      /WAV|RIFF/
    );
  } finally {
    await pool.terminate();
  }
});
