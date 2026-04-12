/**
 * Mock for expo-crypto — uses Node's built-in crypto so tests run without native modules.
 */

import { createHash, randomBytes } from "crypto";

export enum CryptoDigestAlgorithm {
  SHA256 = "SHA-256",
}

export async function digest(
  _algorithm: CryptoDigestAlgorithm,
  data: Uint8Array
): Promise<ArrayBuffer> {
  const hash = createHash("sha256").update(Buffer.from(data)).digest();
  return hash.buffer.slice(hash.byteOffset, hash.byteOffset + hash.byteLength) as ArrayBuffer;
}

export function getRandomBytes(length: number): Uint8Array {
  return new Uint8Array(randomBytes(length));
}
