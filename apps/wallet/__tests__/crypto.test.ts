/**
 * Tests for lib/crypto.ts
 */

import {
  canonicalizeJson,
  concatBytes,
  fromHex,
  sha256,
  toHex,
  ensureKeyPair,
  signDigest,
  deleteKeyPair,
} from "../lib/crypto";
import * as Storage from "../lib/storage";

// ---------------------------------------------------------------------------
// toHex / fromHex
// ---------------------------------------------------------------------------

describe("toHex / fromHex", () => {
  it("round-trips arbitrary bytes", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 255]);
    expect(fromHex(toHex(bytes))).toEqual(bytes);
  });

  it("toHex produces 0x prefix", () => {
    expect(toHex(new Uint8Array([0xde, 0xad]))).toBe("0xdead");
  });

  it("fromHex accepts strings without 0x prefix", () => {
    expect(fromHex("dead")).toEqual(new Uint8Array([0xde, 0xad]));
  });
});

// ---------------------------------------------------------------------------
// concatBytes
// ---------------------------------------------------------------------------

describe("concatBytes", () => {
  it("concatenates multiple arrays", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    const c = new Uint8Array([5]);
    expect(concatBytes(a, b, c)).toEqual(new Uint8Array([1, 2, 3, 4, 5]));
  });

  it("handles empty arrays", () => {
    expect(concatBytes(new Uint8Array([]), new Uint8Array([1]))).toEqual(
      new Uint8Array([1])
    );
  });
});

// ---------------------------------------------------------------------------
// sha256
// ---------------------------------------------------------------------------

describe("sha256", () => {
  it("produces 32 bytes", async () => {
    const digest = await sha256(new TextEncoder().encode("hello"));
    expect(digest).toHaveLength(32);
  });

  it("is deterministic", async () => {
    const input = new TextEncoder().encode("vri");
    const a = await sha256(input);
    const b = await sha256(input);
    expect(a).toEqual(b);
  });

  it("matches known SHA-256 of empty input", async () => {
    const digest = await sha256(new Uint8Array(0));
    // SHA-256("") = e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855
    const expected = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(Buffer.from(digest).toString("hex")).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// canonicalizeJson
// ---------------------------------------------------------------------------

describe("canonicalizeJson", () => {
  it("sorts object keys lexicographically", () => {
    expect(canonicalizeJson({ z: 1, a: 2, m: 3 })).toBe('{"a":2,"m":3,"z":1}');
  });

  it("handles nested objects recursively", () => {
    const result = canonicalizeJson({ b: { d: 4, c: 3 }, a: 1 });
    expect(result).toBe('{"a":1,"b":{"c":3,"d":4}}');
  });

  it("handles arrays preserving order", () => {
    expect(canonicalizeJson([3, 1, 2])).toBe("[3,1,2]");
  });

  it("handles null, booleans, numbers, strings", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(false)).toBe("false");
    expect(canonicalizeJson(42)).toBe("42");
    expect(canonicalizeJson("hello")).toBe('"hello"');
  });

  it("escapes strings correctly", () => {
    expect(canonicalizeJson('say "hi"')).toBe('"say \\"hi\\""');
  });

  it("produces no whitespace", () => {
    const result = canonicalizeJson({ a: 1, b: [2, 3] });
    expect(result).not.toMatch(/\s/);
  });

  it("is byte-identical for same input regardless of key insertion order", () => {
    const obj1 = { z: 1, a: 2 };
    const obj2 = { a: 2, z: 1 };
    expect(canonicalizeJson(obj1)).toBe(canonicalizeJson(obj2));
  });
});

// ---------------------------------------------------------------------------
// Key management (uses mock keychain)
// ---------------------------------------------------------------------------

describe("ensureKeyPair / signDigest / deleteKeyPair", () => {
  beforeEach(async () => {
    await deleteKeyPair();
  });

  it("generates a key pair on first call", async () => {
    const { publicKeyHex } = await ensureKeyPair();
    expect(publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("returns same public key on subsequent calls", async () => {
    const first = await ensureKeyPair();
    const second = await ensureKeyPair();
    expect(first.publicKeyHex).toBe(second.publicKeyHex);
  });

  it("recovers automatically when only the public key was persisted", async () => {
    const first = await ensureKeyPair();
    await Storage.deleteItemAsync("vri_identity_secret_key_v1");

    const recovered = await ensureKeyPair();

    expect(recovered.publicKeyHex).toMatch(/^0x[0-9a-f]{64}$/);
    expect(recovered.publicKeyHex).not.toBe(first.publicKeyHex);
  });

  it("deleteKeyPair resets — next call generates a new key", async () => {
    const before = await ensureKeyPair();
    await deleteKeyPair();
    const after = await ensureKeyPair();
    // Not guaranteed to differ (birthday paradox), but astronomically unlikely
    expect(before.publicKeyHex).not.toBe(after.publicKeyHex);
  });

  it("signDigest produces a 64-byte Ed25519 signature", async () => {
    await ensureKeyPair();
    const digest = new Uint8Array(32).fill(0xab);
    const sig = await signDigest(digest);
    expect(sig).toMatch(/^0x[0-9a-f]{128}$/); // 64 bytes = 128 hex chars
  });

  it("signDigest is deterministic for same key and message", async () => {
    await ensureKeyPair();
    const digest = new Uint8Array(32).fill(1);
    const sig1 = await signDigest(digest);
    const sig2 = await signDigest(digest);
    expect(sig1).toBe(sig2);
  });
});
