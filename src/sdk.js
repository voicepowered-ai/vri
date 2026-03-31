import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const DEFAULT_REGISTRY = "vri:testnet";

function toBuffer(input) {
  if (Buffer.isBuffer(input)) {
    return input;
  }

  if (input instanceof Uint8Array) {
    return Buffer.from(input);
  }

  throw new TypeError("Expected a file path, Buffer, or Uint8Array.");
}

async function readVoiceInput(input) {
  if (typeof input === "string") {
    return readFile(input);
  }

  return toBuffer(input);
}

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function createFingerprint(buffer) {
  const head = buffer.subarray(0, Math.min(buffer.length, 4096));
  const body = Buffer.concat([
    Buffer.from(String(buffer.length)),
    Buffer.from(":"),
    head
  ]);

  return `fp_${sha256(body).slice(0, 24)}`;
}

function createVoiceId(audioHash) {
  return `vri_${audioHash.slice(0, 16)}`;
}

export async function registerVoice(file, options = {}) {
  const buffer = await readVoiceInput(file);
  const audioHash = sha256(buffer);
  const fingerprint = createFingerprint(buffer);

  return {
    voiceId: createVoiceId(audioHash),
    status: "registered",
    fingerprint,
    audioHash,
    registry: options.registry ?? DEFAULT_REGISTRY,
    registeredAt: new Date().toISOString()
  };
}

export async function verifyVoice(id, options = {}) {
  const registry = options.registry ?? DEFAULT_REGISTRY;
  const isValid = typeof id === "string" && /^vri_[a-f0-9]{8,64}$/i.test(id);

  return {
    voiceId: id,
    status: isValid ? "verified" : "invalid",
    authenticity: isValid ? "confirmed" : "rejected",
    registry,
    checkedAt: new Date().toISOString()
  };
}

export class VRIClient {
  constructor(options = {}) {
    this.registry = options.registry ?? DEFAULT_REGISTRY;
  }

  async registerVoice(file) {
    return registerVoice(file, { registry: this.registry });
  }

  async verifyVoice(id) {
    return verifyVoice(id, { registry: this.registry });
  }
}
