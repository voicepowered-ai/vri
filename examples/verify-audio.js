#!/usr/bin/env node

/**
 * Minimal VRI Protocol v1.0 reference verifier.
 *
 * Usage:
 *   node examples/verify-audio.js <audio.wav> <proof.json> [--verbose]
 *
 * This verifier intentionally implements a narrow, reproducible path:
 * - load a WAV file from disk,
 * - extract the raw PCM payload from the WAV container,
 * - compute SHA-256 over the PCM bytes,
 * - reconstruct the signed message digest,
 * - verify the Ed25519 signature.
 *
 * It does not implement watermark extraction or ledger validation.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VALID = 'VALID';
const INVALID_SIGNATURE = 'INVALID_SIGNATURE';
const HASH_MISMATCH = 'HASH_MISMATCH';
const INVALID_FORMAT = 'INVALID_FORMAT';

function fail(reason, message) {
  if (message) {
    console.error(message);
  }
  console.log(reason);
  process.exit(1);
}

function isHexString(value) {
  return typeof value === 'string' && /^(?:0x)?[0-9a-fA-F]+$/.test(value);
}

function decodeFlexibleBytes(value, label) {
  if (Buffer.isBuffer(value)) {
    return value;
  }

  if (typeof value !== 'string') {
    throw new Error(`${label} must be a string`);
  }

  if (value.startsWith('0x') || isHexString(value)) {
    const normalized = value.startsWith('0x') ? value.slice(2) : value;
    if (normalized.length % 2 !== 0) {
      throw new Error(`${label} hex length must be even`);
    }
    return Buffer.from(normalized, 'hex');
  }

  return Buffer.from(value, 'base64');
}

function expectExactLength(buffer, label, expectedLength) {
  if (buffer.length !== expectedLength) {
    throw new Error(`${label} must be exactly ${expectedLength} bytes`);
  }
  return buffer;
}

function decodePublicKey(value) {
  if (typeof value !== 'string') {
    throw new Error('public_key must be a string');
  }

  if (value.includes('BEGIN PUBLIC KEY')) {
    return crypto.createPublicKey(value);
  }

  const keyBytes = decodeFlexibleBytes(value, 'public_key');

  if (keyBytes.length !== 32) {
    throw new Error('public_key must be a PEM key or 32 raw Ed25519 bytes');
  }

  // SPKI prefix for a raw Ed25519 public key.
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex');
  return crypto.createPublicKey({
    key: Buffer.concat([spkiPrefix, keyBytes]),
    format: 'der',
    type: 'spki',
  });
}

function normalizeSignature(proof) {
  if (proof.signature && typeof proof.signature === 'object') {
    return expectExactLength(
      decodeFlexibleBytes(proof.signature.value, 'signature.value'),
      'signature',
      64
    );
  }

  return expectExactLength(
    decodeFlexibleBytes(proof.signature, 'signature'),
    'signature',
    64
  );
}

function normalizeAudioHash(proof) {
  return expectExactLength(
    decodeFlexibleBytes(proof.audio_hash, 'audio_hash'),
    'audio_hash',
    32
  );
}

function normalizeWatermarkPayload(proof) {
  return expectExactLength(
    decodeFlexibleBytes(proof.watermark_payload, 'watermark_payload'),
    'watermark_payload',
    8
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`failed to parse JSON: ${error.message}`);
  }
}

function readWavPcmData(filePath) {
  // This implementation assumes the WAV file already matches
  // VRI Canonical Audio (v1.0). It does not perform resampling
  // or normalization.
  const wav = fs.readFileSync(filePath);

  if (wav.length < 12) {
    throw new Error('WAV file is too small');
  }

  if (wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('WAV file missing RIFF header');
  }

  if (wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV file missing WAVE header');
  }

  let offset = 12;

  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkSize;

    if (chunkEnd > wav.length) {
      throw new Error(`WAV chunk ${chunkId} extends beyond file length`);
    }

    if (chunkId === 'data') {
      return wav.subarray(chunkStart, chunkEnd);
    }

    offset = chunkEnd + (chunkSize % 2);
  }

  throw new Error('WAV file missing data chunk');
}

function encodeUint64BigEndian(value) {
  let normalizedValue;

  if (typeof value === 'bigint') {
    normalizedValue = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new Error('timestamp must be an integer');
    }
    normalizedValue = BigInt(value);
  } else if (typeof value === 'string') {
    if (!/^[0-9]+$/.test(value)) {
      throw new Error('timestamp string must contain only decimal digits');
    }
    normalizedValue = BigInt(value);
  } else {
    throw new Error('timestamp must be a number, string, or bigint');
  }

  if (normalizedValue < 0n) {
    throw new Error('timestamp must be a non-negative integer');
  }

  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(normalizedValue);
  return buffer;
}

function canonicalizeJsonValue(value) {
  if (value === null) {
    return 'null';
  }

  if (typeof value === 'string') {
    return JSON.stringify(value);
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      throw new Error('metadata numbers must be finite integers');
    }
    return String(value);
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJsonValue(item)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    const members = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJsonValue(value[key])}`);
    return `{${members.join(',')}}`;
  }

  throw new Error('metadata contains unsupported value type');
}

function getCanonicalMetadataString(proof) {
  if (typeof proof.canonical_metadata === 'string') {
    return proof.canonical_metadata;
  }

  if (proof.metadata && typeof proof.metadata === 'object' && !Array.isArray(proof.metadata)) {
    return canonicalizeJsonValue(proof.metadata);
  }

  throw new Error('proof must include canonical_metadata as a string or metadata as an object');
}

function validateProofShape(proof) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) {
    throw new Error('proof must be a JSON object');
  }

  if (!('watermark_payload' in proof)) {
    throw new Error('proof.watermark_payload is required');
  }

  if (!('audio_hash' in proof)) {
    throw new Error('proof.audio_hash is required');
  }

  if (!('timestamp' in proof)) {
    throw new Error('proof.timestamp is required');
  }

  if (!('public_key' in proof)) {
    throw new Error('proof.public_key is required');
  }

  if (!('signature' in proof)) {
    throw new Error('proof.signature is required');
  }
}

function verifyAudioFile(audioPath, proofPath, options = {}) {
  const verbose = Boolean(options.verbose);
  const absoluteAudioPath = path.resolve(audioPath);
  const absoluteProofPath = path.resolve(proofPath);

  if (!fs.existsSync(absoluteAudioPath)) {
    throw new Error(`audio file not found: ${absoluteAudioPath}`);
  }

  if (!fs.existsSync(absoluteProofPath)) {
    throw new Error(`proof file not found: ${absoluteProofPath}`);
  }

  const proof = readJson(absoluteProofPath);
  validateProofShape(proof);

  const pcmBuffer = readWavPcmData(absoluteAudioPath);
  const computedAudioHash = crypto.createHash('sha256').update(pcmBuffer).digest();
  const expectedAudioHash = normalizeAudioHash(proof);

  if (!computedAudioHash.equals(expectedAudioHash)) {
    return {
      ok: false,
      reason: HASH_MISMATCH,
      debug: verbose
        ? {
            computed_audio_hash: computedAudioHash.toString('hex'),
            expected_audio_hash: expectedAudioHash.toString('hex'),
          }
        : undefined,
    };
  }

  const watermarkPayload = normalizeWatermarkPayload(proof);
  const timestamp = encodeUint64BigEndian(proof.timestamp);
  // Reconstruct the protocol-defined metadata string deterministically.
  const canonicalMetadata = Buffer.from(getCanonicalMetadataString(proof), 'utf8');

  // Reconstruct the protocol-defined message input exactly:
  // watermark_payload || audio_hash || timestamp || canonical_metadata
  const messageInput = Buffer.concat([
    watermarkPayload,
    computedAudioHash,
    timestamp,
    canonicalMetadata,
  ]);

  const messageDigest = crypto.createHash('sha256').update(messageInput).digest();
  const signature = normalizeSignature(proof);
  const publicKey = decodePublicKey(proof.public_key);

  const isValid = crypto.verify(null, messageDigest, publicKey, signature);

  if (!isValid) {
    return {
      ok: false,
      reason: INVALID_SIGNATURE,
      debug: verbose
        ? {
            message_digest: messageDigest.toString('hex'),
          }
        : undefined,
    };
  }

  return {
    ok: true,
    reason: VALID,
    debug: verbose
      ? {
          pcm_bytes: pcmBuffer.length,
          audio_hash: computedAudioHash.toString('hex'),
          message_digest: messageDigest.toString('hex'),
        }
      : undefined,
  };
}

function parseArgs(argv) {
  const verbose = argv.includes('--verbose');
  const positional = argv.filter((arg) => arg !== '--verbose');

  if (positional.length !== 2) {
    throw new Error('usage: node examples/verify-audio.js <audio.wav> <proof.json> [--verbose]');
  }

  return {
    audioPath: positional[0],
    proofPath: positional[1],
    verbose,
  };
}

if (require.main === module) {
  try {
    const { audioPath, proofPath, verbose } = parseArgs(process.argv.slice(2));
    const result = verifyAudioFile(audioPath, proofPath, { verbose });

    if (verbose && result.debug) {
      console.error(JSON.stringify(result.debug, null, 2));
    }

    if (result.ok) {
      console.log(VALID);
      process.exit(0);
    }

    console.log(result.reason);
    process.exit(1);
  } catch (error) {
    fail(INVALID_FORMAT, error.message);
  }
}

module.exports = {
  verifyAudioFile,
  readWavPcmData,
};
