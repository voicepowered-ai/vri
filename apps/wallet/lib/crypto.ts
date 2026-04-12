/**
 * VRI Wallet — Cryptographic primitives
 *
 * Handles Ed25519 key generation, secure storage, SHA-256 hashing, and
 * the canonical JSON serialization required by VRI Protocol v2.0.
 */

import * as Crypto from "expo-crypto";
import nacl from "tweetnacl";
import { Buffer } from "buffer";
import * as Storage from "./storage";

const PUBLIC_KEY_STORE_KEY = "vri_identity_public_key_v1";
const SECRET_KEY_STORE_KEY = "vri_identity_secret_key_v1";

let prngInstalled = false;

function debugCrypto(message: string, extra?: Record<string, unknown>): void {
  if (!__DEV__) {
    return;
  }

  if (extra) {
    console.log("[vri-wallet][crypto]", message, extra);
    return;
  }

  console.log("[vri-wallet][crypto]", message);
}

function fillRandomBytes(target: Uint8Array): void {
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    debugCrypto("Using globalThis.crypto.getRandomValues", { length: target.length });
    globalThis.crypto.getRandomValues(target);
    return;
  }

  if (typeof Crypto.getRandomBytes === "function") {
    debugCrypto("Using ExpoCrypto.getRandomBytes", { length: target.length });
    target.set(Crypto.getRandomBytes(target.length));
    return;
  }

  debugCrypto("No secure random source available");
  throw new Error("No secure random source available");
}

function ensureNaClPrng(): void {
  if (prngInstalled) {
    return;
  }

  nacl.setPRNG((target, length) => {
    const random = new Uint8Array(length);
    fillRandomBytes(random);
    target.set(random);
  });

  prngInstalled = true;
  debugCrypto("tweetnacl PRNG installed");
}

ensureNaClPrng();

// ---------------------------------------------------------------------------
// Hex helpers
// ---------------------------------------------------------------------------

export function toHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function fromHex(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return new Uint8Array(Buffer.from(clean, "hex"));
}

// ---------------------------------------------------------------------------
// Key management
// ---------------------------------------------------------------------------

type StoredKey = {
  publicKeyHex: string;
  secretKeyHex: string;
};

function getSecretKeyReadOptions(prompt?: string): Storage.StorageOptions {
  return {
    requireAuthentication: true,
    authenticationPrompt: prompt,
  };
}

async function storeSecretKey(secretKeyHex: string): Promise<void> {
  try {
    debugCrypto("Storing secret key with authenticated storage");
    await Storage.setItemAsync(
      SECRET_KEY_STORE_KEY,
      secretKeyHex,
      getSecretKeyReadOptions("Desbloquea tu clave VRI")
    );
  } catch {
    // Fallback for environments where authenticated storage entries are unavailable.
    debugCrypto("Authenticated secret-key storage unavailable, falling back");
    await Storage.setItemAsync(SECRET_KEY_STORE_KEY, secretKeyHex);
  }
}

async function loadSecretKey(prompt?: string): Promise<string | null> {
  try {
    debugCrypto("Loading secret key with protected read", { prompt: prompt ?? null });
    const protectedSecret = await Storage.getItemAsync(
      SECRET_KEY_STORE_KEY,
      getSecretKeyReadOptions(prompt)
    );
    if (protectedSecret) {
      debugCrypto("Protected secret-key read succeeded");
      return protectedSecret;
    }
  } catch {
    // Fall through to the non-authenticated read path.
    debugCrypto("Protected secret-key read failed, trying fallback read");
  }

  const fallbackSecret = await Storage.getItemAsync(SECRET_KEY_STORE_KEY);
  debugCrypto("Fallback secret-key read completed", { found: Boolean(fallbackSecret) });
  return fallbackSecret;
}

/**
 * Returns the wallet's Ed25519 public key, generating and storing a new
 * key pair on first call. The private key is protected with SecureStore
 * authentication when the platform supports it and never exposed outside
 * this module.
 */
export async function ensureKeyPair(): Promise<{ publicKeyHex: string }> {
  debugCrypto("ensureKeyPair start");
  const publicKeyHex = await Storage.getItemAsync(PUBLIC_KEY_STORE_KEY);

  if (publicKeyHex) {
    debugCrypto("Public key already present", { publicKeyHex });
    const secretKeyHex = await loadSecretKey();

    if (secretKeyHex) {
      debugCrypto("Key pair already complete");
      return { publicKeyHex };
    }

    // Recover from a partially-written identity where the public key exists
    // but the protected secret key was never stored successfully.
    debugCrypto("Public key exists but secret key is missing, regenerating identity");
    await Storage.deleteItemAsync(PUBLIC_KEY_STORE_KEY);
  }

  // Generate a fresh Ed25519 key pair (tweetnacl uses 64-byte seed+public layout)
  debugCrypto("Generating fresh Ed25519 key pair");
  const kp = nacl.sign.keyPair();
  const stored: StoredKey = {
    publicKeyHex: toHex(kp.publicKey),
    secretKeyHex: toHex(kp.secretKey),
  };

  await storeSecretKey(stored.secretKeyHex);
  await Storage.setItemAsync(PUBLIC_KEY_STORE_KEY, stored.publicKeyHex);
  debugCrypto("Stored fresh key pair", { publicKeyHex: stored.publicKeyHex });

  return { publicKeyHex: stored.publicKeyHex };
}

/**
 * Signs a 32-byte digest with the wallet's Ed25519 private key.
 * Triggers a biometric/passcode prompt when the secret key is stored in
 * an authenticated SecureStore entry.
 * Returns a 64-byte signature as a 0x-prefixed hex string.
 */
export async function signDigest(digest: Uint8Array): Promise<string> {
  debugCrypto("signDigest start", { digestBytes: digest.length });
  const { publicKeyHex } = await ensureKeyPair();
  const secretKeyHex = await loadSecretKey("Autorizar sesión VRI");

  if (!secretKeyHex) {
    debugCrypto("signDigest aborted: secret key missing", { publicKeyHex });
    throw new Error(`VRI key is incomplete on device for public key ${publicKeyHex}`);
  }

  const secretKey = fromHex(secretKeyHex);

  // nacl.sign.detached signs the message directly; we pre-hashed so this is safe
  const sig = nacl.sign.detached(digest, secretKey);
  debugCrypto("signDigest success", { publicKeyHex });
  return toHex(sig);
}

/**
 * Deletes the stored key pair. Use only for account reset.
 */
export async function deleteKeyPair(): Promise<void> {
  await Storage.deleteItemAsync(PUBLIC_KEY_STORE_KEY);
  await Storage.deleteItemAsync(SECRET_KEY_STORE_KEY);
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const bytes = Uint8Array.from(data);
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    bytes
  );
  return new Uint8Array(digest);
}

// ---------------------------------------------------------------------------
// Canonical JSON serialization (VRI Protocol v2.0 §5)
//
// Rules: keys sorted lexicographically, no whitespace, no floats,
// no duplicate keys. Must produce byte-identical output to the Node
// reference implementation's canonicalizeJsonValue().
// ---------------------------------------------------------------------------

export function canonicalizeJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    return "[" + value.map(canonicalizeJson).join(",") + "]";
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalizeJson(obj[k])).join(",") +
      "}"
    );
  }

  throw new TypeError(`canonicalizeJson: unsupported type ${typeof value}`);
}

// ---------------------------------------------------------------------------
// Buffer concat helper
// ---------------------------------------------------------------------------

export function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.length;
  }
  return out;
}
