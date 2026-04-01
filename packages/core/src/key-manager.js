import crypto from "node:crypto";
import { readFile } from "node:fs/promises";

const SPKI_PREFIX_ED25519 = Buffer.from("302a300506032b6570032100", "hex");

function extractRawPublicKey(privateKey) {
  const publicKey = crypto.createPublicKey(privateKey);
  const der = publicKey.export({ format: "der", type: "spki" });
  return der.subarray(SPKI_PREFIX_ED25519.length);
}

function deriveKeyId(publicKeyBytes) {
  return crypto.createHash("sha256").update(publicKeyBytes).digest().toString("hex").slice(0, 16);
}

export class KeyManager {
  #privateKey;
  #publicKeyBytes;
  #keyId;
  #archivedKeys;

  constructor(privateKey) {
    if (!privateKey || typeof privateKey !== "object") {
      throw new TypeError("KeyManager requires a crypto.KeyObject private key.");
    }

    this.#privateKey = privateKey;
    this.#publicKeyBytes = extractRawPublicKey(privateKey);
    this.#keyId = deriveKeyId(this.#publicKeyBytes);
    this.#archivedKeys = [];
  }

  getKeyId() {
    return this.#keyId;
  }

  getPublicKeyBytes() {
    return this.#publicKeyBytes;
  }

  sign(digest) {
    return crypto.sign(null, digest, this.#privateKey);
  }

  rotate() {
    this.#archivedKeys.push({
      keyId: this.#keyId,
      publicKeyBytes: this.#publicKeyBytes
    });

    const { privateKey } = crypto.generateKeyPairSync("ed25519");
    this.#privateKey = privateKey;
    this.#publicKeyBytes = extractRawPublicKey(privateKey);
    this.#keyId = deriveKeyId(this.#publicKeyBytes);

    return this.#keyId;
  }

  getArchivedKeys() {
    return [...this.#archivedKeys];
  }
}

export function createKeyManager(options = {}) {
  const pem = options.privateKeyPem ?? process.env.VRI_PRIVATE_KEY_PEM ?? null;

  if (pem) {
    return new KeyManager(crypto.createPrivateKey(pem));
  }

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  return new KeyManager(privateKey);
}

export async function createKeyManagerFromFile(filePath) {
  const pem = await readFile(filePath, "utf8");
  return createKeyManager({ privateKeyPem: pem.trim() });
}

/**
 * KMS/HSM provider adapter.
 *
 * Pass an object that satisfies the provider interface to obtain a key manager
 * backed by an external signing service (AWS KMS, GCP KMS, Azure Key Vault, etc.)
 * without exposing raw private key material.
 *
 * Required provider methods:
 *   sign(digest: Buffer): Promise<Buffer> | Buffer
 *   getPublicKeyBytes(): Buffer   — raw 32-byte Ed25519 public key
 *   getKeyId(): string
 *
 * Optional provider methods:
 *   rotate(): Promise<string> | string   — returns new key ID
 *   getArchivedKeys(): Array<{ keyId, publicKeyBytes }>
 */
export function createKmsKeyManager(provider) {
  if (
    typeof provider?.sign !== "function" ||
    typeof provider?.getPublicKeyBytes !== "function" ||
    typeof provider?.getKeyId !== "function"
  ) {
    throw new TypeError(
      "KMS provider must implement sign(digest), getPublicKeyBytes(), and getKeyId()."
    );
  }

  return {
    sign: (digest) => provider.sign(digest),
    getPublicKeyBytes: () => provider.getPublicKeyBytes(),
    getKeyId: () => provider.getKeyId(),
    rotate: () => {
      if (typeof provider.rotate !== "function") {
        throw new Error("KMS provider does not support key rotation via this interface.");
      }

      return provider.rotate();
    },
    getArchivedKeys: () => {
      return typeof provider.getArchivedKeys === "function" ? provider.getArchivedKeys() : [];
    }
  };
}
