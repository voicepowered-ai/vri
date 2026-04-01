/**
 * DSP Worker Thread
 *
 * Runs canonicalization and watermark embedding in a Worker Thread,
 * keeping the event loop free during CPU-intensive audio processing.
 *
 * Message protocol:
 *   Request:  { op, id, payload: ArrayBuffer }
 *   Response: { id, result?: ArrayBuffer, error?: string }
 *
 * Supported ops:
 *   "canonicalize"  — Buffer → canonical 24-bit LE PCM at 48 kHz
 *   "sha256"        — Buffer → 32-byte SHA-256 digest
 */

import { workerData, parentPort } from "node:worker_threads";
import crypto from "node:crypto";

void workerData; // reserved for future warm-start config

// ── inline DSP (same logic as packages/core/src/index.js) ────────────────────
// Duplicated here deliberately so the worker has zero dynamic imports at
// runtime, keeping startup latency minimal and avoiding circular dependencies.

const SPKI_PREFIX_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
void SPKI_PREFIX_ED25519;

function decodeInt24LE(buffer, offset) {
  const value = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16);
  return (value << 8) >> 8;
}

function writeInt24LE(buffer, offset, value) {
  const normalized = value < 0 ? value + 0x1000000 : value;
  buffer[offset] = normalized & 0xff;
  buffer[offset + 1] = (normalized >> 8) & 0xff;
  buffer[offset + 2] = (normalized >> 16) & 0xff;
}

function parseWavFile(buffer) {
  if (buffer.length < 12) throw new Error("WAV file is too small.");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Unsupported audio format. Expected RIFF/WAVE.");
  }

  let offset = 12;
  let format = null;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;
    if (chunkEnd > buffer.length) throw new Error(`WAV chunk ${chunkId} extends beyond file length.`);

    if (chunkId === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(chunkStart),
        channels: buffer.readUInt16LE(chunkStart + 2),
        sampleRate: buffer.readUInt32LE(chunkStart + 4),
        byteRate: buffer.readUInt32LE(chunkStart + 8),
        blockAlign: buffer.readUInt16LE(chunkStart + 12),
        bitsPerSample: buffer.readUInt16LE(chunkStart + 14)
      };
    } else if (chunkId === "data") {
      dataOffset = chunkStart;
      dataSize = chunkSize;
    }
    offset = chunkEnd + (chunkSize % 2);
  }

  if (!format) throw new Error("WAV file missing fmt chunk.");
  if (dataOffset < 0) throw new Error("WAV file missing data chunk.");
  return { format, dataOffset, dataSize };
}

function validateCanonicalWavFormat(format) {
  if (format.audioFormat !== 1 && format.audioFormat !== 3) {
    throw new Error("Only PCM (16/24-bit) and IEEE float (32-bit) WAV input is supported for Canonical Audio.");
  }
  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`Unsupported sample rate ${format.sampleRate}.`);
  }
  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(`Unsupported channel count ${format.channels}.`);
  }
  if (format.audioFormat === 1 && format.bitsPerSample !== 16 && format.bitsPerSample !== 24) {
    throw new Error(`Unsupported PCM bit depth ${format.bitsPerSample}.`);
  }
  if (format.audioFormat === 3 && format.bitsPerSample !== 32) {
    throw new Error(`Unsupported IEEE float bit depth ${format.bitsPerSample}.`);
  }
}

function decodePcmSamplesToInt32(buffer, dataOffset, frameCount, channels, bitsPerSample, audioFormat) {
  const decoded = new Int32Array(frameCount * channels);
  let inputOffset = dataOffset;

  if (bitsPerSample === 16) {
    for (let i = 0; i < decoded.length; i++) {
      decoded[i] = buffer.readInt16LE(inputOffset) << 8;
      inputOffset += 2;
    }
    return decoded;
  }
  if (bitsPerSample === 24) {
    for (let i = 0; i < decoded.length; i++) {
      decoded[i] = decodeInt24LE(buffer, inputOffset);
      inputOffset += 3;
    }
    return decoded;
  }
  if (audioFormat === 3 && bitsPerSample === 32) {
    const MAX_INT32 = 2147483647;
    for (let i = 0; i < decoded.length; i++) {
      const f = buffer.readFloatLE(inputOffset);
      decoded[i] = Math.max(-MAX_INT32 - 1, Math.min(MAX_INT32, Math.trunc(f * MAX_INT32)));
      inputOffset += 4;
    }
    return decoded;
  }
  throw new Error("Unsupported audio format/bit depth combination.");
}

function divRoundSignedBigInt(numerator, denominator) {
  if (numerator >= 0n) return Number((numerator + denominator / 2n) / denominator);
  return Number(-((-numerator + denominator / 2n) / denominator));
}

function resampleInterleavedLinearInt32(input, channels, inputSampleRate, outputSampleRate) {
  const inputFrameCount = input.length / channels;
  if (inputFrameCount === 0) return new Int32Array(0);

  const outputFrameCount = Number(
    (BigInt(inputFrameCount) * BigInt(outputSampleRate) + BigInt(inputSampleRate) / 2n) / BigInt(inputSampleRate)
  );

  const output = new Int32Array(outputFrameCount * channels);
  const inputRateBig = BigInt(inputSampleRate);
  const outputRateBig = BigInt(outputSampleRate);

  for (let outFrame = 0; outFrame < outputFrameCount; outFrame++) {
    const sourcePosition = BigInt(outFrame) * inputRateBig;
    const leftIndex = Number(sourcePosition / outputRateBig);
    const frac = sourcePosition % outputRateBig;
    const rightIndex = Math.min(leftIndex + 1, inputFrameCount - 1);

    for (let ch = 0; ch < channels; ch++) {
      const leftSample = BigInt(input[leftIndex * channels + ch]);
      const rightSample = BigInt(input[rightIndex * channels + ch]);
      const interpolated = leftSample * (outputRateBig - frac) + rightSample * frac;
      output[outFrame * channels + ch] = divRoundSignedBigInt(interpolated, outputRateBig);
    }
  }
  return output;
}

function writeInterleavedInt32To24BitLE(samples) {
  const output = Buffer.alloc(samples.length * 3);
  for (let i = 0; i < samples.length; i++) {
    writeInt24LE(output, i * 3, samples[i]);
  }
  return output;
}

function canonicalizeWavTo24BitLE(buffer) {
  const TARGET_SAMPLE_RATE = 48000;
  const wav = parseWavFile(buffer);
  const { format, dataOffset, dataSize } = wav;
  validateCanonicalWavFormat(format);

  const bytesPerSample = format.bitsPerSample / 8;
  const frameSize = bytesPerSample * format.channels;
  if (dataSize % frameSize !== 0) throw new Error("WAV data chunk is not aligned to complete sample frames.");

  const frameCount = dataSize / frameSize;
  const decoded = decodePcmSamplesToInt32(buffer, dataOffset, frameCount, format.channels, format.bitsPerSample, format.audioFormat);

  if (format.sampleRate === TARGET_SAMPLE_RATE) {
    return writeInterleavedInt32To24BitLE(decoded);
  }

  const resampled = resampleInterleavedLinearInt32(decoded, format.channels, format.sampleRate, TARGET_SAMPLE_RATE);
  return writeInterleavedInt32To24BitLE(resampled);
}

// ── message handler ───────────────────────────────────────────────────────────

parentPort.on("message", ({ op, id, payload }) => {
  try {
    const inputBuffer = Buffer.from(payload);

    if (op === "canonicalize") {
      const result = canonicalizeWavTo24BitLE(inputBuffer);
      parentPort.postMessage({ id, result: result.buffer }, [result.buffer]);
      return;
    }

    if (op === "sha256") {
      const digest = crypto.createHash("sha256").update(inputBuffer).digest();
      parentPort.postMessage({ id, result: digest.buffer }, [digest.buffer]);
      return;
    }

    parentPort.postMessage({ id, error: `Unknown op: ${op}` });
  } catch (err) {
    parentPort.postMessage({ id, error: err.message });
  }
});
