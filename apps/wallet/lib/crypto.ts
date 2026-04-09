/**
 * VRI Wallet — Cryptographic primitives
 *
 * Handles Ed25519 key generation, secure storage, SHA-256 hashing, and
 * the canonical JSON serialization required by VRI Protocol v2.0.
 */

import * as Crypto from "expo-crypto";
import * as Keychain from "react-native-keychain";
import nacl from "tweetnacl";

const KEY_SERVICE = "vri_identity_key_v1";

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

/**
 * Returns the wallet's Ed25519 public key, generating and storing a new
 * key pair on first call. The private key is protected by biometry/passcode
 * via react-native-keychain and never exposed outside this module.
 */
export async function ensureKeyPair(): Promise<{ publicKeyHex: string }> {
  const existing = await Keychain.getGenericPassword({ service: KEY_SERVICE });

  if (existing && existing.password) {
    const stored: StoredKey = JSON.parse(existing.password);
    return { publicKeyHex: stored.publicKeyHex };
  }

  // Generate a fresh Ed25519 key pair (tweetnacl uses 64-byte seed+public layout)
  const kp = nacl.sign.keyPair();
  const stored: StoredKey = {
    publicKeyHex: toHex(kp.publicKey),
    secretKeyHex: toHex(kp.secretKey),
  };

  await Keychain.setGenericPassword("vri", JSON.stringify(stored), {
    service: KEY_SERVICE,
    accessControl:
      Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });

  return { publicKeyHex: stored.publicKeyHex };
}

/**
 * Signs a 32-byte digest with the wallet's Ed25519 private key.
 * Triggers a biometric/passcode prompt on Android.
 * Returns a 64-byte signature as a 0x-prefixed hex string.
 */
export async function signDigest(digest: Uint8Array): Promise<string> {
  const creds = await Keychain.getGenericPassword({
    service: KEY_SERVICE,
    authenticationPrompt: { title: "Autorizar sesión VRI" },
  });

  if (!creds) throw new Error("No VRI key found on device");

  const stored: StoredKey = JSON.parse(creds.password);
  const secretKey = fromHex(stored.secretKeyHex);

  // nacl.sign.detached signs the message directly; we pre-hashed so this is safe
  const sig = nacl.sign.detached(digest, secretKey);
  return toHex(sig);
}

/**
 * Deletes the stored key pair. Use only for account reset.
 */
export async function deleteKeyPair(): Promise<void> {
  await Keychain.resetGenericPassword({ service: KEY_SERVICE });
}

// ---------------------------------------------------------------------------
// SHA-256
// ---------------------------------------------------------------------------

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const digest = await Crypto.digest(
    Crypto.CryptoDigestAlgorithm.SHA256,
    data
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
