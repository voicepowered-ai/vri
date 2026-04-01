const DEFAULT_OPTIONS = {
  frameSize: 2048,
  hopLength: 512,
  subbandCount: 32,
  lowFrequencyHz: 125,
  highFrequencyHz: 8000,
  modulationDepthHigh: 0.004,
  modulationDepthLow: 0.002,
  energyThreshold: 0.02,
  repetitionFactor: 4
};

// Synchronization word prepended to each repetition block.
// Allows blind extraction to validate embedding integrity.
const SYNC_WORD = 0x5a5a;
const SYNC_BITS = 16;

// Fixed payload length for VRI: 8 bytes.
const PAYLOAD_BYTES = 8;

// Hamming(7,4): encode a 4-bit nibble [d1,d2,d3,d4] to a 7-bit codeword.
// Codeword layout: [p1, p2, d1, p4, d2, d3, d4] (1-indexed positions 1-7).
function hammingEncode(d) {
  const p1 = d[0] ^ d[1] ^ d[3];
  const p2 = d[0] ^ d[2] ^ d[3];
  const p4 = d[1] ^ d[2] ^ d[3];

  return [p1, p2, d[0], p4, d[1], d[2], d[3]];
}

// Hamming(7,4): decode codeword [r1..r7] to [d1,d2,d3,d4] with single-bit correction.
function hammingDecode(r) {
  const s1 = r[0] ^ r[2] ^ r[4] ^ r[6];
  const s2 = r[1] ^ r[2] ^ r[5] ^ r[6];
  const s4 = r[3] ^ r[4] ^ r[5] ^ r[6];
  const errorPos = (s4 << 2) | (s2 << 1) | s1;
  const c = [...r];

  if (errorPos > 0 && errorPos <= 7) {
    c[errorPos - 1] ^= 1;
  }

  return [c[2], c[4], c[5], c[6]];
}

function clampSample(value) {
  if (value > 1) {
    return 1;
  }

  if (value < -1) {
    return -1;
  }

  return value;
}

function isHexString(value) {
  return typeof value === "string" && /^(?:0x)?[0-9a-f]+$/i.test(value);
}

function decodePayloadBytes(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }

  if (typeof value !== "string") {
    throw new TypeError("payload must be a Buffer, Uint8Array, or string.");
  }

  if (isHexString(value)) {
    const normalized = value.startsWith("0x") ? value.slice(2) : value;
    return Buffer.from(normalized, "hex");
  }

  return Buffer.from(value, "base64");
}

function normalizePayload(payload) {
  if (payload == null) {
    return null;
  }

  const payloadBytes = decodePayloadBytes(payload);

  if (payloadBytes.length !== 8) {
    throw new TypeError(`payload must be exactly 8 bytes, got ${payloadBytes.length}.`);
  }

  return payloadBytes;
}

function payloadToBits(payloadBytes, repetitionFactor) {
  const bits = [];

  for (let repetition = 0; repetition < repetitionFactor; repetition += 1) {
    for (let byteIndex = 0; byteIndex < payloadBytes.length; byteIndex += 1) {
      const byte = payloadBytes[byteIndex];

      for (let bitIndex = 7; bitIndex >= 0; bitIndex -= 1) {
        bits.push((byte >> bitIndex) & 1);
      }
    }
  }

  return bits;
}

// Encode payload bytes to bits with sync word + Hamming(7,4) ECC per nibble.
// Layout per repetition: [16 sync bits] + [16 nibbles × 7 code bits] = 128 bits.
function payloadToBitsECC(payloadBytes, repetitionFactor) {
  const syncBits = [];

  for (let i = 15; i >= 0; i -= 1) {
    syncBits.push((SYNC_WORD >> i) & 1);
  }

  const eccBits = [];

  for (let byteIndex = 0; byteIndex < payloadBytes.length; byteIndex += 1) {
    const byte = payloadBytes[byteIndex];
    const hi = [(byte >> 7) & 1, (byte >> 6) & 1, (byte >> 5) & 1, (byte >> 4) & 1];
    const lo = [(byte >> 3) & 1, (byte >> 2) & 1, (byte >> 1) & 1, byte & 1];

    eccBits.push(...hammingEncode(hi));
    eccBits.push(...hammingEncode(lo));
  }

  const blockBits = [...syncBits, ...eccBits];
  const bits = [];

  for (let rep = 0; rep < repetitionFactor; rep += 1) {
    bits.push(...blockBits);
  }

  return bits;
}

// Blind ECC decoding: recover payload from raw bit array using majority vote
// across repetitions and Hamming correction within each codeword.
function decodeBitsECC(bits, repetitionFactor) {
  const NIBBLES_PER_PAYLOAD = PAYLOAD_BYTES * 2;
  const BITS_PER_CODE = 7;
  const BLOCK_BITS = SYNC_BITS + NIBBLES_PER_PAYLOAD * BITS_PER_CODE; // 128

  const expectedSync = [];

  for (let i = 15; i >= 0; i -= 1) {
    expectedSync.push((SYNC_WORD >> i) & 1);
  }

  let syncOk = 0;

  for (let rep = 0; rep < repetitionFactor; rep += 1) {
    const offset = rep * BLOCK_BITS;
    let matches = 0;

    for (let i = 0; i < SYNC_BITS; i += 1) {
      if (bits[offset + i] === expectedSync[i]) {
        matches += 1;
      }
    }

    if (matches >= Math.floor(SYNC_BITS * 0.75)) {
      syncOk += 1;
    }
  }

  const recoveredBits = [];

  for (let nibbleIndex = 0; nibbleIndex < NIBBLES_PER_PAYLOAD; nibbleIndex += 1) {
    const nibbleCodeOffset = SYNC_BITS + nibbleIndex * BITS_PER_CODE;
    const votes = new Array(BITS_PER_CODE).fill(0);

    for (let rep = 0; rep < repetitionFactor; rep += 1) {
      const base = rep * BLOCK_BITS + nibbleCodeOffset;

      for (let bit = 0; bit < BITS_PER_CODE; bit += 1) {
        votes[bit] += bits[base + bit] === 1 ? 1 : -1;
      }
    }

    const codeword = votes.map((v) => (v >= 0 ? 1 : 0));
    const nibble = hammingDecode(codeword);

    recoveredBits.push(...nibble);
  }

  const payload = Buffer.alloc(PAYLOAD_BYTES);

  for (let bitIndex = 0; bitIndex < recoveredBits.length; bitIndex += 1) {
    if (recoveredBits[bitIndex] === 1) {
      payload[Math.floor(bitIndex / 8)] |= 1 << (7 - (bitIndex % 8));
    }
  }

  return {
    payload,
    syncQuality: syncOk / repetitionFactor
  };
}

function createHannWindow(frameSize) {
  const window = new Float32Array(frameSize);

  for (let index = 0; index < frameSize; index += 1) {
    window[index] = 0.5 * (1 - Math.cos((2 * Math.PI * index) / (frameSize - 1)));
  }

  return window;
}

function createSubbandCenterFrequencies(sampleRate, subbandCount, lowFrequencyHz, highFrequencyHz) {
  const centers = new Float32Array(subbandCount);
  const lowLog = Math.log(lowFrequencyHz);
  const highLog = Math.log(highFrequencyHz);

  for (let index = 0; index < subbandCount; index += 1) {
    const t = subbandCount === 1 ? 0 : index / (subbandCount - 1);
    centers[index] = Math.exp(lowLog + (highLog - lowLog) * t);
  }

  return centers;
}

function createCarrierTable(frameSize, sampleRate, frequencies, window) {
  const carriers = new Array(frequencies.length);

  for (let carrierIndex = 0; carrierIndex < frequencies.length; carrierIndex += 1) {
    const frequency = frequencies[carrierIndex];
    const carrier = new Float32Array(frameSize);
    const angularStep = (2 * Math.PI * frequency) / sampleRate;

    for (let sampleIndex = 0; sampleIndex < frameSize; sampleIndex += 1) {
      carrier[sampleIndex] = Math.sin(angularStep * sampleIndex) * window[sampleIndex];
    }

    carriers[carrierIndex] = carrier;
  }

  return carriers;
}

function createSpreadingPlan(bitCount, frameCount, subbandCount) {
  const plan = new Array(bitCount);

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
    plan[bitIndex] = {
      bitIndex,
      frameIndex: frameCount === 0 ? 0 : (bitIndex * 37) % frameCount,
      subbandIndex: (bitIndex * 19) % subbandCount
    };
  }

  return plan;
}

function computeFrameRms(channel, start, frameSize, window) {
  let energy = 0;
  const available = Math.min(frameSize, channel.length - start);

  for (let index = 0; index < available; index += 1) {
    const sample = channel[start + index] * window[index];
    energy += sample * sample;
  }

  return available === 0 ? 0 : Math.sqrt(energy / available);
}

function parseWav(buffer) {
  if (buffer.length < 44) {
    throw new Error("WAV buffer too small.");
  }

  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Only RIFF/WAVE input is supported.");
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

    if (chunkEnd > buffer.length) {
      throw new Error(`Invalid WAV chunk ${chunkId}.`);
    }

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

  if (!format) {
    throw new Error("WAV file missing fmt chunk.");
  }

  if (dataOffset < 0) {
    throw new Error("WAV file missing data chunk.");
  }

  return {
    format,
    dataOffset,
    dataSize
  };
}

function decodePcm16Wav(buffer) {
  const wav = parseWav(buffer);

  if (wav.format.audioFormat !== 1) {
    throw new Error("Only PCM WAV input is supported.");
  }

  if (wav.format.bitsPerSample !== 16) {
    throw new Error("Only 16-bit PCM WAV input is currently supported.");
  }

  const { channels, sampleRate, blockAlign } = wav.format;
  const frameCount = Math.floor(wav.dataSize / blockAlign);
  const channelData = Array.from({ length: channels }, () => new Float32Array(frameCount));
  let byteOffset = wav.dataOffset;

  for (let frameIndex = 0; frameIndex < frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const sample = buffer.readInt16LE(byteOffset);
      channelData[channelIndex][frameIndex] = sample / 32768;
      byteOffset += 2;
    }
  }

  return {
    sampleRate,
    channels,
    bitsPerSample: 16,
    frameCount,
    channelData,
    wav
  };
}

function encodePcm16Wav(sourceBuffer, decoded) {
  const output = Buffer.from(sourceBuffer);
  let byteOffset = decoded.wav.dataOffset;

  for (let frameIndex = 0; frameIndex < decoded.frameCount; frameIndex += 1) {
    for (let channelIndex = 0; channelIndex < decoded.channels; channelIndex += 1) {
      const sample = clampSample(decoded.channelData[channelIndex][frameIndex]);
      const quantized = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      output.writeInt16LE(quantized, byteOffset);
      byteOffset += 2;
    }
  }

  return output;
}

function embedBitsIntoChannel(channel, bits, plan, carriers, window, options) {
  let tilesEmbedded = 0;

  for (let planIndex = 0; planIndex < plan.length; planIndex += 1) {
    const tile = plan[planIndex];
    const start = tile.frameIndex * options.hopLength;

    if (start >= channel.length) {
      continue;
    }

    const carrier = carriers[tile.subbandIndex];
    const available = Math.min(options.frameSize, channel.length - start);
    const rms = computeFrameRms(channel, start, options.frameSize, window);
    const modulationDepth = rms > options.energyThreshold
      ? options.modulationDepthHigh
      : options.modulationDepthLow;
    const polarity = bits[tile.bitIndex] === 1 ? 1 : -1;

    for (let sampleIndex = 0; sampleIndex < available; sampleIndex += 1) {
      channel[start + sampleIndex] = clampSample(
        channel[start + sampleIndex] + (carrier[sampleIndex] * modulationDepth * polarity)
      );
    }

    tilesEmbedded += 1;
  }

  return tilesEmbedded;
}

function correlateChannel(channel, plan, carriers, frameSize, hopLength) {
  const scores = new Float32Array(plan.length);

  for (let planIndex = 0; planIndex < plan.length; planIndex += 1) {
    const tile = plan[planIndex];
    const start = tile.frameIndex * hopLength;

    if (start >= channel.length) {
      continue;
    }

    const carrier = carriers[tile.subbandIndex];
    const available = Math.min(frameSize, channel.length - start);
    let correlation = 0;

    for (let sampleIndex = 0; sampleIndex < available; sampleIndex += 1) {
      correlation += channel[start + sampleIndex] * carrier[sampleIndex];
    }

    scores[planIndex] = available === 0 ? 0 : correlation / available;
  }

  return scores;
}

function averageScores(perChannelScores) {
  if (perChannelScores.length === 0) {
    return new Float32Array(0);
  }

  const length = perChannelScores[0].length;
  const averaged = new Float32Array(length);

  for (let channelIndex = 0; channelIndex < perChannelScores.length; channelIndex += 1) {
    const scores = perChannelScores[channelIndex];

    for (let index = 0; index < length; index += 1) {
      averaged[index] += scores[index];
    }
  }

  for (let index = 0; index < length; index += 1) {
    averaged[index] /= perChannelScores.length;
  }

  return averaged;
}

function summarizeRecoveredBits(scores, repetitionFactor) {
  const repeatedBitCount = scores.length;
  const payloadBitCount = repeatedBitCount / repetitionFactor;
  const recoveredBits = new Array(payloadBitCount).fill(0);
  let confidenceSum = 0;

  for (let payloadBitIndex = 0; payloadBitIndex < payloadBitCount; payloadBitIndex += 1) {
    let vote = 0;
    let magnitude = 0;

    for (let repetition = 0; repetition < repetitionFactor; repetition += 1) {
      const score = scores[(repetition * payloadBitCount) + payloadBitIndex];
      vote += score >= 0 ? 1 : -1;
      magnitude += Math.abs(score);
    }

    recoveredBits[payloadBitIndex] = vote >= 0 ? 1 : 0;
    confidenceSum += magnitude / repetitionFactor;
  }

  const payload = Buffer.alloc(payloadBitCount / 8);

  for (let bitIndex = 0; bitIndex < recoveredBits.length; bitIndex += 1) {
    if (recoveredBits[bitIndex] === 1) {
      payload[Math.floor(bitIndex / 8)] |= 1 << (7 - (bitIndex % 8));
    }
  }

  return {
    recoveredPayload: payload,
    confidence: payloadBitCount === 0 ? 0 : confidenceSum / payloadBitCount
  };
}

function comparePayloadBits(expectedPayload, recoveredPayload) {
  let matches = 0;
  const totalBits = expectedPayload.length * 8;

  for (let index = 0; index < expectedPayload.length; index += 1) {
    const xor = expectedPayload[index] ^ recoveredPayload[index];
    matches += 8 - xor.toString(2).replace(/0/g, "").length;
  }

  return totalBits === 0 ? 0 : matches / totalBits;
}

export function decodeAudioToFloat32(audioBuffer) {
  return decodePcm16Wav(audioBuffer);
}

export function encodeFloat32ToAudio(sourceBuffer, decodedAudio) {
  return encodePcm16Wav(sourceBuffer, decodedAudio);
}

export function createAnalysisContext(sampleRate, options = {}) {
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const window = createHannWindow(resolved.frameSize);
  const centerFrequencies = createSubbandCenterFrequencies(
    sampleRate,
    resolved.subbandCount,
    resolved.lowFrequencyHz,
    resolved.highFrequencyHz
  );
  const carriers = createCarrierTable(resolved.frameSize, sampleRate, centerFrequencies, window);

  return {
    options: resolved,
    window,
    centerFrequencies,
    carriers
  };
}

export class WatermarkEngine {
  constructor(options = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async embed(audioBuffer, context = {}) {
    const payload = normalizePayload(context.payload);

    if (!payload) {
      return {
        audio: audioBuffer,
        watermark: {
          embedded: false,
          mode: "vri-spread-spectrum-v1"
        }
      };
    }

    const decoded = decodePcm16Wav(audioBuffer);
    const analysis = createAnalysisContext(decoded.sampleRate, this.options);
    const frameCount = Math.max(1, Math.floor(Math.max(0, decoded.frameCount - analysis.options.frameSize) / analysis.options.hopLength) + 1);
    const bits = payloadToBitsECC(payload, analysis.options.repetitionFactor);
    const plan = createSpreadingPlan(bits.length, frameCount, analysis.options.subbandCount);

    let tilesEmbedded = 0;

    for (let channelIndex = 0; channelIndex < decoded.channelData.length; channelIndex += 1) {
      tilesEmbedded += embedBitsIntoChannel(
        decoded.channelData[channelIndex],
        bits,
        plan,
        analysis.carriers,
        analysis.window,
        analysis.options
      );
    }

    return {
      audio: encodePcm16Wav(audioBuffer, decoded),
      watermark: {
        embedded: true,
        mode: "vri-spread-spectrum-v1",
        payload: payload.toString("base64"),
        payload_hex: `0x${payload.toString("hex")}`,
        sample_rate: decoded.sampleRate,
        channels: decoded.channels,
        frame_size: analysis.options.frameSize,
        hop_length: analysis.options.hopLength,
        subbands: analysis.options.subbandCount,
        total_bits: bits.length,
        tiles_embedded: tilesEmbedded,
        ecc: "hamming-7-4",
        sync_word: `0x${SYNC_WORD.toString(16).padStart(4, "0")}`
      }
    };
  }

  async extract(audioBuffer, context = {}) {
    const expected = normalizePayload(context.payload);
    const decoded = decodePcm16Wav(audioBuffer);
    const analysis = createAnalysisContext(decoded.sampleRate, this.options);

    // ECC bit count: repetitionFactor × (SYNC_BITS + PAYLOAD_BYTES×2×7) = 4×128 = 512
    const BITS_PER_BLOCK = SYNC_BITS + PAYLOAD_BYTES * 2 * 7;
    const totalBits = analysis.options.repetitionFactor * BITS_PER_BLOCK;
    const frameCount = Math.max(1, Math.floor(Math.max(0, decoded.frameCount - analysis.options.frameSize) / analysis.options.hopLength) + 1);
    const plan = createSpreadingPlan(totalBits, frameCount, analysis.options.subbandCount);
    const perChannelScores = decoded.channelData.map((channel) => (
      correlateChannel(channel, plan, analysis.carriers, analysis.options.frameSize, analysis.options.hopLength)
    ));
    const average = averageScores(perChannelScores);

    // Convert correlation scores to hard bits via sign threshold
    const hardBits = Array.from(average).map((s) => (s >= 0 ? 1 : 0));
    const decoded_ecc = decodeBitsECC(hardBits, analysis.options.repetitionFactor);

    const result = {
      recovered: decoded_ecc.syncQuality >= 0.5,
      mode: "vri-spread-spectrum-v1",
      payload_hex: `0x${decoded_ecc.payload.toString("hex")}`,
      sync_quality: Number(decoded_ecc.syncQuality.toFixed(4)),
      ecc: "hamming-7-4"
    };

    if (expected) {
      const bitMatchRatio = comparePayloadBits(expected, decoded_ecc.payload);

      result.expected_payload_hex = `0x${expected.toString("hex")}`;
      result.bit_match_ratio = Number(bitMatchRatio.toFixed(4));
      result.recovered = bitMatchRatio >= 0.75 && decoded_ecc.syncQuality >= 0.5;
    }

    return result;
  }
}

export function createWatermarkEngine(options) {
  return new WatermarkEngine(options);
}
