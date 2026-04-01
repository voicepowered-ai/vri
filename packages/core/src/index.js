import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

export const DEFAULT_REGISTRY = "vri:testnet";
const SPKI_PREFIX_ED25519 = Buffer.from("302a300506032b6570032100", "hex");
const SIGNATURE_CONTEXT_PREFIX = Buffer.from("VRI-SIG-V1\0", "utf8");

export async function readAudioInput(input) {
  if (typeof input === "string") {
    return readFile(input);
  }

  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }

  throw new TypeError("Expected a file path, Buffer, or Uint8Array.");
}

export function sha256Hex(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

export function createVoiceFingerprint(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  const digest = sha256Hex(Buffer.concat([Buffer.from(String(buffer.length)), Buffer.from(":"), sample]));
  return `fp_${digest.slice(0, 24)}`;
}

export function createVoiceId(audioHash) {
  return `vri_${audioHash.slice(0, 16)}`;
}

export function hex(buffer) {
  return `0x${buffer.toString("hex")}`;
}

export function decodeHex(value, label) {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) {
    throw new TypeError(`${label} must be a 0x-prefixed hex string.`);
  }

  return Buffer.from(value.slice(2), "hex");
}

function decodeProofBytes(value, label, expectedLength = null) {
  if (Buffer.isBuffer(value)) {
    if (expectedLength != null && value.length !== expectedLength) {
      throw new TypeError(`${label} must be ${expectedLength} bytes.`);
    }
    return value;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }

  let decoded;

  if (/^0x[0-9a-f]+$/i.test(value)) {
    decoded = Buffer.from(value.slice(2), "hex");
  } else {
    decoded = Buffer.from(value, "base64");
  }

  if (expectedLength != null && decoded.length !== expectedLength) {
    throw new TypeError(`${label} must be ${expectedLength} bytes.`);
  }

  return decoded;
}

class NonceReplayTracker {
  constructor() {
    this.map = new Map();
  }

  has(creatorIdHex, nonce) {
    const set = this.map.get(creatorIdHex);
    return Boolean(set && set.has(nonce));
  }

  add(creatorIdHex, nonce) {
    if (!this.map.has(creatorIdHex)) {
      this.map.set(creatorIdHex, new Set());
    }

    this.map.get(creatorIdHex).add(nonce);
  }
}

export function createNonceReplayTracker() {
  return new NonceReplayTracker();
}

export function canonicalizeJsonValue(value) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new TypeError("metadata numbers must be finite integers.");
    }
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonValue(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key])}`).join(",")}}`;
  }

  throw new TypeError("metadata contains an unsupported value type.");
}

export function getCanonicalMetadataString(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new TypeError("metadata must be a JSON object.");
  }

  return canonicalizeJsonValue(metadata);
}

export function encodeUint64BigEndian(value) {
  const normalizedValue = typeof value === "bigint" ? value : BigInt(value);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(normalizedValue);
  return buffer;
}

export function encodeUint32BigEndian(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

export function parseWavFile(buffer) {
  if (buffer.length < 12) {
    throw new Error("WAV file is too small.");
  }

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

    if (chunkEnd > buffer.length) {
      throw new Error(`WAV chunk ${chunkId} extends beyond file length.`);
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

function validateCanonicalWavFormat(format) {
  if (format.audioFormat !== 1 && format.audioFormat !== 3) {
    throw new Error("Only PCM (16/24-bit) and IEEE float (32-bit) WAV input is supported for Canonical Audio.");
  }

  if (!Number.isInteger(format.sampleRate) || format.sampleRate <= 0) {
    throw new Error(`Unsupported sample rate ${format.sampleRate}. Expected a positive integer sample rate.`);
  }

  if (format.channels !== 1 && format.channels !== 2) {
    throw new Error(`Unsupported channel count ${format.channels}. Only mono or stereo is allowed.`);
  }

  if (format.audioFormat === 1 && format.bitsPerSample !== 16 && format.bitsPerSample !== 24) {
    throw new Error(`Unsupported PCM bit depth ${format.bitsPerSample}. Only 16-bit and 24-bit PCM are supported.`);
  }

  if (format.audioFormat === 3 && format.bitsPerSample !== 32) {
    throw new Error(`Unsupported IEEE float bit depth ${format.bitsPerSample}. Only 32-bit float is supported.`);
  }
}

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

function decodePcmSamplesToInt32(buffer, dataOffset, frameCount, channels, bitsPerSample, audioFormat) {
  const decoded = new Int32Array(frameCount * channels);
  let inputOffset = dataOffset;

  if (bitsPerSample === 16) {
    for (let index = 0; index < decoded.length; index += 1) {
      decoded[index] = buffer.readInt16LE(inputOffset) << 8;
      inputOffset += 2;
    }
    return decoded;
  }

  if (bitsPerSample === 24) {
    for (let index = 0; index < decoded.length; index += 1) {
      decoded[index] = decodeInt24LE(buffer, inputOffset);
      inputOffset += 3;
    }
    return decoded;
  }

  if (audioFormat === 3 && bitsPerSample === 32) {
    const MAX_INT32 = 2147483647;
    for (let index = 0; index < decoded.length; index += 1) {
      const float32 = buffer.readFloatLE(inputOffset);
      if (!Number.isFinite(float32)) {
        throw new Error("Non-finite float sample detected in WAV input.");
      }
      decoded[index] = Math.max(-MAX_INT32 - 1, Math.min(MAX_INT32, Math.trunc(float32 * MAX_INT32)));
      inputOffset += 4;
    }
    return decoded;
  }

  throw new Error("Unsupported audio format/bit depth combination.");
}

function divRoundSignedBigInt(numerator, denominator) {
  if (numerator >= 0n) {
    return Number((numerator + denominator / 2n) / denominator);
  }

  return Number(-((-numerator + denominator / 2n) / denominator));
}

function resampleInterleavedLinearInt32(input, channels, inputSampleRate, outputSampleRate) {
  const inputFrameCount = input.length / channels;

  if (inputFrameCount === 0) {
    return new Int32Array(0);
  }

  const outputFrameCount = Number(
    (BigInt(inputFrameCount) * BigInt(outputSampleRate) + BigInt(inputSampleRate) / 2n) / BigInt(inputSampleRate)
  );

  const output = new Int32Array(outputFrameCount * channels);
  const inputRateBig = BigInt(inputSampleRate);
  const outputRateBig = BigInt(outputSampleRate);

  for (let outputFrameIndex = 0; outputFrameIndex < outputFrameCount; outputFrameIndex += 1) {
    const sourcePosition = BigInt(outputFrameIndex) * inputRateBig;
    const leftIndex = Number(sourcePosition / outputRateBig);
    const frac = sourcePosition % outputRateBig;
    const rightIndex = Math.min(leftIndex + 1, inputFrameCount - 1);

    for (let channelIndex = 0; channelIndex < channels; channelIndex += 1) {
      const leftSample = BigInt(input[leftIndex * channels + channelIndex]);
      const rightSample = BigInt(input[rightIndex * channels + channelIndex]);
      const interpolatedNumerator =
        leftSample * (outputRateBig - frac) +
        rightSample * frac;

      output[outputFrameIndex * channels + channelIndex] = divRoundSignedBigInt(interpolatedNumerator, outputRateBig);
    }
  }

  return output;
}

function writeInterleavedInt32To24BitLE(samples) {
  const output = Buffer.alloc(samples.length * 3);
  let outputOffset = 0;

  for (let sampleIndex = 0; sampleIndex < samples.length; sampleIndex += 1) {
    writeInt24LE(output, outputOffset, samples[sampleIndex]);
    outputOffset += 3;
  }

  return output;
}

export function canonicalizeWavTo24BitLE(buffer) {
  const TARGET_SAMPLE_RATE = 48000;
  const wav = parseWavFile(buffer);
  const { format, dataOffset, dataSize } = wav;
  validateCanonicalWavFormat(format);

  const bytesPerSample = format.bitsPerSample / 8;
  const frameSize = bytesPerSample * format.channels;

  if (dataSize % frameSize !== 0) {
    throw new Error("WAV data chunk is not aligned to complete sample frames.");
  }

  const frameCount = dataSize / frameSize;
  const decoded = decodePcmSamplesToInt32(buffer, dataOffset, frameCount, format.channels, format.bitsPerSample, format.audioFormat);

  if (format.sampleRate === TARGET_SAMPLE_RATE) {
    return writeInterleavedInt32To24BitLE(decoded);
  }

  const resampled = resampleInterleavedLinearInt32(decoded, format.channels, format.sampleRate, TARGET_SAMPLE_RATE);
  return writeInterleavedInt32To24BitLE(resampled);
}

export function readWavPcmData(buffer) {
  const wav = parseWavFile(buffer);
  return buffer.subarray(wav.dataOffset, wav.dataOffset + wav.dataSize);
}

export function getCanonicalAudioBytes(buffer) {
  return canonicalizeWavTo24BitLE(buffer);
}

export async function readCanonicalAudioInput(input) {
  const audio = await readAudioInput(input);
  return getCanonicalAudioBytes(audio);
}

/**
 * Async variant: offloads canonicalization to a Worker Thread via DspPool.
 * Use this in production HTTP handlers to keep the event loop responsive.
 *
 * @param {Buffer} buffer - Raw WAV buffer
 * @param {import("./dsp-pool.js").DspPool} [pool] - Optional DspPool instance.
 *   If omitted, creates a new single-worker pool and terminates it after use.
 * @returns {Promise<Buffer>} Canonical 24-bit LE PCM at 48 kHz
 */
export async function canonicalizeWavTo24BitLEAsync(buffer, pool = null) {
  const { createDspPool } = await import("./dsp-pool.js");
  const ownPool = !pool;
  const activePool = pool ?? createDspPool({ size: 1 });
  try {
    return await activePool.canonicalize(buffer);
  } finally {
    if (ownPool) await activePool.terminate();
  }
}

export async function readCanonicalAudioInputAsync(input, pool = null) {
  const audio = await readAudioInput(input);
  return canonicalizeWavTo24BitLEAsync(audio, pool);
}

export function deriveCreatorId(publicKeyBytes) {
  return crypto.createHash("sha256").update(publicKeyBytes).digest().subarray(0, 4);
}

export function createWatermarkPayload(publicKeyBytes, timestamp, nonce = crypto.randomInt(0, 256)) {
  const payload = Buffer.alloc(8);
  deriveCreatorId(publicKeyBytes).copy(payload, 0);

  const ts = Number(BigInt(timestamp) % 16777216n);
  payload.writeUIntBE(ts, 4, 3);
  payload.writeUInt8(nonce, 7);

  return payload;
}

export function buildSignatureMessageDigest({ watermarkPayload, audioHash, timestamp, canonicalMetadata }) {
  const canonicalMetadataBytes = Buffer.from(canonicalMetadata, "utf8");
  const messageInput = Buffer.concat([
    SIGNATURE_CONTEXT_PREFIX,
    watermarkPayload,
    audioHash,
    encodeUint64BigEndian(timestamp),
    encodeUint32BigEndian(canonicalMetadataBytes.length),
    canonicalMetadataBytes
  ]);

  return crypto.createHash("sha256").update(messageInput).digest();
}

export function buildLegacySignatureMessageDigest({ watermarkPayload, audioHash, timestamp, canonicalMetadata }) {
  const messageInput = Buffer.concat([
    watermarkPayload,
    audioHash,
    encodeUint64BigEndian(timestamp),
    Buffer.from(canonicalMetadata, "utf8")
  ]);

  return crypto.createHash("sha256").update(messageInput).digest();
}

export function getRawPublicKeyBytes(publicKey) {
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(SPKI_PREFIX_ED25519.length);
}

export function createSigningMaterial(privateKeyPem) {
  if (privateKeyPem) {
    const privateKey = crypto.createPrivateKey(privateKeyPem);
    const publicKey = crypto.createPublicKey(privateKey);
    return { privateKey, publicKey, generated: false };
  }

  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  return { privateKey, publicKey, generated: true };
}

export async function registerVoice(input, options = {}) {
  const audio = await readCanonicalAudioInput(input);
  const audioHash = sha256Hex(audio);
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  const metadata = options.metadata ?? {};
  const canonicalMetadata = getCanonicalMetadataString(metadata);
  let signer;

  if (options.keyManager) {
    signer = {
      publicKeyBytes: options.keyManager.getPublicKeyBytes(),
      sign: (digest) => options.keyManager.sign(digest),
      keyId: options.keyManager.getKeyId(),
      generated: false
    };
  } else {
    const signingMaterial = createSigningMaterial(options.privateKeyPem ?? process.env.VRI_PRIVATE_KEY_PEM);
    signer = {
      publicKeyBytes: getRawPublicKeyBytes(signingMaterial.publicKey),
      sign: (digest) => crypto.sign(null, digest, signingMaterial.privateKey),
      keyId: null,
      generated: signingMaterial.generated
    };
  }

  const publicKeyBytes = signer.publicKeyBytes;
  const watermarkPayload = createWatermarkPayload(publicKeyBytes, timestamp, options.nonce);
  const messageDigest = buildSignatureMessageDigest({
    watermarkPayload,
    audioHash: Buffer.from(audioHash, "hex"),
    timestamp,
    canonicalMetadata
  });
  const signature = signer.sign(messageDigest);
  const creatorId = deriveCreatorId(publicKeyBytes);
  const voiceId = createVoiceId(audioHash);
  const usageEventId = options.usageEventId ?? `evt_${crypto.randomUUID()}`;
  const ledgerAnchor = options.ledgerAnchor ?? null;

  return {
    voiceId,
    status: "registered",
    complianceLevel: ledgerAnchor ? 3 : 1,
    fingerprint: createVoiceFingerprint(audio),
    audioHash,
    registry: options.registry ?? DEFAULT_REGISTRY,
    createdAt: new Date(Number(timestamp) * 1000).toISOString(),
    proofPackage: {
      protocol_version: "1.0",
      compliance_level: ledgerAnchor ? 3 : 1,
      watermark_format_version: "1.0",
      watermark_payload: watermarkPayload.toString("base64"),
      watermark_hex: hex(watermarkPayload),
      audio_hash: hex(Buffer.from(audioHash, "hex")),
      signature: {
        algorithm: "Ed25519",
        value: hex(signature)
      },
      public_key: hex(publicKeyBytes),
      creator_id: hex(creatorId),
      timestamp,
      metadata,
      canonical_metadata: canonicalMetadata,
      usage_event_id: usageEventId,
      ledger_anchor: ledgerAnchor,
      key_id: signer.keyId,
      verification_endpoint: options.verificationEndpoint ?? null,
      extensions: {}
    },
    signingKeyGenerated: signer.generated
  };
}

export function validateVoiceId(voiceId) {
  return typeof voiceId === "string" && /^vri_[a-f0-9]{16,64}$/i.test(voiceId);
}

export async function verifyVoice(voiceId, options = {}) {
  const valid = validateVoiceId(voiceId);

  return {
    voiceId,
    status: valid ? "verified" : "invalid",
    authenticity: valid ? "confirmed" : "rejected",
    registry: options.registry ?? DEFAULT_REGISTRY,
    checkedAt: new Date().toISOString()
  };
}

export function verifyProofPackage(audioBuffer, proofPackage, options = {}) {
  const requireProtocolVersion = options.requireProtocolVersion ?? true;
  const enforceFreshness = options.enforceFreshness ?? false;
  const maxTimestampSkewSeconds = Number(options.maxTimestampSkewSeconds ?? 24 * 60 * 60);
  const nowTimestamp = Number(options.nowTimestamp ?? Math.floor(Date.now() / 1000));
  const nonceTracker = options.nonceTracker ?? null;
  const watermarkStatus = options.watermarkStatus ?? "not_applicable";
  const requireWatermarkCheck = options.requireWatermarkCheck ?? false;
  const watermarkExtractor = typeof options.extractWatermark === "function"
    ? options.extractWatermark
    : null;

  const fail = (reason, details = {}, checks = {}) => {
    const protocolValid = checks.protocol_valid ?? false;
    const metadataConsistent = checks.metadata_consistent ?? false;
    const identityValid = checks.identity_valid ?? false;
    const cryptographicValid = checks.cryptographic_valid ?? false;

    return {
      ok: false,
      reason,
      cryptographic_valid: cryptographicValid,
      watermark: watermarkStatus,
      identity_valid: identityValid,
      metadata_consistent: metadataConsistent,
      protocol_valid: protocolValid,
      trust_level: "LOW",
      details
    };
  };

  if (!proofPackage || typeof proofPackage !== "object" || Array.isArray(proofPackage)) {
    return fail("INVALID_PROOF_PACKAGE", { error: "proofPackage must be a JSON object." });
  }

  if (requireProtocolVersion) {
    if (proofPackage.protocol_version !== "1.0") {
      return fail("INVALID_PROTOCOL_VERSION", {
        expected: "1.0",
        received: proofPackage.protocol_version ?? null
      });
    }
  }

  try {
    const canonicalAudio = getCanonicalAudioBytes(audioBuffer);
    const computedAudioHash = crypto.createHash("sha256").update(canonicalAudio).digest();
    const expectedAudioHash = decodeHex(proofPackage.audio_hash, "audio_hash");

    const hasCanonicalMetadata = typeof proofPackage.canonical_metadata === "string";
    const hasMetadataObject = proofPackage.metadata && typeof proofPackage.metadata === "object" && !Array.isArray(proofPackage.metadata);

    let metadataConsistent = false;
    let canonicalMetadata;

    if (hasCanonicalMetadata && hasMetadataObject) {
      const recomputed = getCanonicalMetadataString(proofPackage.metadata);
      metadataConsistent = recomputed === proofPackage.canonical_metadata;
      canonicalMetadata = proofPackage.canonical_metadata;
    } else if (hasCanonicalMetadata) {
      metadataConsistent = true;
      canonicalMetadata = proofPackage.canonical_metadata;
    } else if (hasMetadataObject) {
      metadataConsistent = true;
      canonicalMetadata = getCanonicalMetadataString(proofPackage.metadata);
    } else {
      return fail("INVALID_METADATA", {
        error: "proof must include canonical_metadata and/or metadata object"
      }, {
        protocol_valid: true
      });
    }

    if (!metadataConsistent) {
      return fail("METADATA_MISMATCH", {
        error: "canonical_metadata does not match metadata"
      }, {
        protocol_valid: true,
        metadata_consistent: false
      });
    }

    const publicKeyBytes = decodeHex(proofPackage.public_key, "public_key");
    const publicKey = crypto.createPublicKey({
      key: Buffer.concat([SPKI_PREFIX_ED25519, publicKeyBytes]),
      format: "der",
      type: "spki"
    });

    const derivedCreatorIdHex = hex(deriveCreatorId(publicKeyBytes));
    const claimedCreatorId = proofPackage.creator_id;
    const identityValid = typeof claimedCreatorId === "string" && claimedCreatorId.toLowerCase() === derivedCreatorIdHex.toLowerCase();

    if (!identityValid) {
      return fail("CREATOR_ID_MISMATCH", {
        expected_creator_id: derivedCreatorIdHex,
        received_creator_id: claimedCreatorId ?? null
      }, {
        protocol_valid: true,
        metadata_consistent: true,
        identity_valid: false
      });
    }

    const signatureValue = typeof proofPackage.signature === "object"
      ? proofPackage.signature.value
      : proofPackage.signature;
    const signature = decodeProofBytes(signatureValue, "signature", 64);

    const watermarkHex = proofPackage.watermark_hex;
    const watermarkPayloadField = proofPackage.watermark_payload;
    let watermarkPayload;
    let effectiveWatermarkStatus = watermarkStatus;

    if (typeof watermarkHex === "string" && typeof watermarkPayloadField === "string") {
      const fromHex = decodeProofBytes(watermarkHex, "watermark_hex", 8);
      const fromPayload = decodeProofBytes(watermarkPayloadField, "watermark_payload", 8);

      if (!fromHex.equals(fromPayload)) {
        return fail("WATERMARK_FIELD_MISMATCH", {
          error: "watermark_hex and watermark_payload conflict"
        }, {
          protocol_valid: true,
          metadata_consistent: true,
          identity_valid: true
        });
      }

      watermarkPayload = fromHex;
    } else {
      watermarkPayload = decodeProofBytes(watermarkHex ?? watermarkPayloadField, "watermark_payload", 8);
    }

    if (watermarkExtractor) {
      try {
        const extraction = watermarkExtractor(audioBuffer, watermarkPayload);
        const extracted = extraction && typeof extraction.then === "function"
          ? null
          : extraction;

        if (extracted && typeof extracted === "object") {
          if (extracted.recovered === true) {
            effectiveWatermarkStatus = "present";
          } else if ((extracted.sync_quality ?? 0) >= 0.25 || (extracted.bit_match_ratio ?? 0) >= 0.5) {
            effectiveWatermarkStatus = "degraded";
          } else {
            effectiveWatermarkStatus = "missing";
          }
        }
      } catch {
        effectiveWatermarkStatus = "degraded";
      }
    } else if (requireWatermarkCheck) {
      return fail("WATERMARK_CHECK_REQUIRED", {
        error: "watermark extraction is required but no extractor was provided"
      }, {
        protocol_valid: true,
        metadata_consistent: true,
        identity_valid: true
      });
    }

    const timestamp = Number(proofPackage.timestamp);

    if (!Number.isInteger(timestamp) || timestamp < 0) {
      return fail("INVALID_TIMESTAMP", {
        error: "timestamp must be a non-negative integer"
      }, {
        protocol_valid: true,
        metadata_consistent: true,
        identity_valid: true
      });
    }

    if (enforceFreshness) {
      const skew = Math.abs(nowTimestamp - timestamp);
      if (!Number.isFinite(skew) || skew > maxTimestampSkewSeconds) {
        return fail("TIMESTAMP_OUT_OF_WINDOW", {
          now: nowTimestamp,
          timestamp,
          max_skew_seconds: maxTimestampSkewSeconds
        }, {
          protocol_valid: true,
          metadata_consistent: true,
          identity_valid: true
        });
      }
    }

    if (nonceTracker) {
      const nonce = watermarkPayload[7];
      if (nonceTracker.has(derivedCreatorIdHex, nonce)) {
        return fail("REPLAY_DETECTED", {
          creator_id: derivedCreatorIdHex,
          nonce
        }, {
          protocol_valid: true,
          metadata_consistent: true,
          identity_valid: true
        });
      }
      nonceTracker.add(derivedCreatorIdHex, nonce);
    }

    if (!computedAudioHash.equals(expectedAudioHash)) {
      return fail("HASH_MISMATCH", {
        mode: "v1.0",
        canonicalAudioHash: computedAudioHash.toString("hex"),
        expectedAudioHash: expectedAudioHash.toString("hex")
      }, {
        protocol_valid: true,
        metadata_consistent: true,
        identity_valid: true
      });
    }

    const messageDigest = buildSignatureMessageDigest({
      watermarkPayload,
      audioHash: expectedAudioHash,
      timestamp,
      canonicalMetadata
    });
    const valid = crypto.verify(null, messageDigest, publicKey, signature);
    const cryptographicValid = valid;
    const trustLevel = cryptographicValid
      ? (effectiveWatermarkStatus === "present" ? "HIGH" : "PARTIAL")
      : "LOW";

    return {
      ok: cryptographicValid,
      reason: cryptographicValid ? "VALID" : "INVALID_SIGNATURE",
      cryptographic_valid: cryptographicValid,
      watermark: effectiveWatermarkStatus,
      identity_valid: true,
      metadata_consistent: true,
      protocol_valid: true,
      trust_level: trustLevel,
      details: {
        mode: "v1.0",
        audioHash: computedAudioHash.toString("hex"),
        messageDigest: messageDigest.toString("hex"),
        creator_id: derivedCreatorIdHex
      }
    };
  } catch (error) {
    return fail("INVALID_PROOF_PACKAGE", { error: error.message });
  }
}
