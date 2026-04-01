import test from "node:test";
import assert from "node:assert/strict";
import { createWatermarkEngine } from "../src/index.js";

// Minimal PCM-16 WAV builder for tests.
function createSilentWav({ sampleRate = 48000, channels = 1, durationMs = 2000 }) {
  const frameCount = Math.floor((sampleRate * durationMs) / 1000);
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);  // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, Buffer.alloc(dataSize)]);
}

// Sinusoidal audio for better embedding SNR.
function createToneWav({ sampleRate = 48000, channels = 1, durationMs = 2000, frequencyHz = 440 }) {
  const frameCount = Math.floor((sampleRate * durationMs) / 1000);
  const blockAlign = channels * 2;
  const byteRate = sampleRate * blockAlign;
  const dataSize = frameCount * blockAlign;
  const data = Buffer.alloc(dataSize);

  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(Math.sin((2 * Math.PI * frequencyHz * i) / sampleRate) * 16000);

    for (let ch = 0; ch < channels; ch += 1) {
      data.writeInt16LE(sample, (i * channels + ch) * 2);
    }
  }

  const header = Buffer.alloc(44);

  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);

  return Buffer.concat([header, data]);
}

const TEST_PAYLOAD = "0xdeadbeefcafebabe";

test("embed without payload returns embedded: false and vri-spread-spectrum-v1 mode", async () => {
  const engine = createWatermarkEngine();
  const audio = createSilentWav({});
  const result = await engine.embed(audio, {});

  assert.equal(result.watermark.embedded, false);
  assert.equal(result.watermark.mode, "vri-spread-spectrum-v1");
  assert.deepEqual(result.audio, audio);
});

test("embed with payload returns embedded: true with ECC metadata", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({});
  const result = await engine.embed(audio, { payload: TEST_PAYLOAD });

  assert.equal(result.watermark.embedded, true);
  assert.equal(result.watermark.mode, "vri-spread-spectrum-v1");
  assert.equal(result.watermark.ecc, "hamming-7-4");
  assert.equal(result.watermark.sync_word, "0x5a5a");
  assert.ok(result.watermark.total_bits > 0);
  assert.ok(result.watermark.tiles_embedded > 0);
  assert.ok(result.audio.length === audio.length);
});

test("embed is deterministic: same payload produces same watermarked audio", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({});
  const r1 = await engine.embed(audio, { payload: TEST_PAYLOAD });
  const r2 = await engine.embed(audio, { payload: TEST_PAYLOAD });

  assert.deepEqual(r1.audio, r2.audio);
});

test("blind extract recovers payload after embed (tone audio)", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({ durationMs: 3000 });
  const { audio: watermarked } = await engine.embed(audio, { payload: TEST_PAYLOAD });
  const extracted = await engine.extract(watermarked, {});

  assert.equal(extracted.mode, "vri-spread-spectrum-v1");
  assert.equal(extracted.ecc, "hamming-7-4");
  assert.ok(extracted.sync_quality >= 0.5, `sync_quality too low: ${extracted.sync_quality}`);
  assert.equal(extracted.payload_hex, TEST_PAYLOAD);
  assert.equal(extracted.recovered, true);
});

test("informed extract with correct payload reports high bit match ratio", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({ durationMs: 3000 });
  const { audio: watermarked } = await engine.embed(audio, { payload: TEST_PAYLOAD });
  const extracted = await engine.extract(watermarked, { payload: TEST_PAYLOAD });

  assert.equal(extracted.mode, "vri-spread-spectrum-v1");
  assert.ok(extracted.bit_match_ratio >= 0.75, `bit_match_ratio too low: ${extracted.bit_match_ratio}`);
  assert.ok(extracted.sync_quality >= 0.5);
  assert.equal(extracted.recovered, true);
});

test("informed extract with wrong payload reports low bit match ratio or recovered: false", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({ durationMs: 3000 });
  const { audio: watermarked } = await engine.embed(audio, { payload: TEST_PAYLOAD });
  const extracted = await engine.extract(watermarked, { payload: "0x0000000000000000" });

  assert.equal(extracted.recovered, false);
});

test("extract from non-watermarked audio returns recovered: false", async () => {
  const engine = createWatermarkEngine();
  const audio = createSilentWav({ durationMs: 3000 });
  const extracted = await engine.extract(audio, {});

  assert.equal(extracted.recovered, false);
  assert.equal(extracted.mode, "vri-spread-spectrum-v1");
});

test("embed and extract work correctly with stereo audio", async () => {
  const engine = createWatermarkEngine();
  const audio = createToneWav({ channels: 2, durationMs: 3000 });
  const { audio: watermarked } = await engine.embed(audio, { payload: TEST_PAYLOAD });
  const extracted = await engine.extract(watermarked, { payload: TEST_PAYLOAD });

  assert.ok(extracted.bit_match_ratio >= 0.75, `stereo bit_match_ratio: ${extracted.bit_match_ratio}`);
  assert.equal(extracted.recovered, true);
});
