/**
 * Tests for lib/identity.ts
 */

import {
  parseQRChallenge,
  buildIdentityDigest,
  deriveWatermarkNonce,
  type QRChallenge,
} from "../lib/identity";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FUTURE = Math.floor(Date.now() / 1000) + 300;
const PAST = Math.floor(Date.now() / 1000) - 10;

function validChallenge(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    auth_method: "QR_SECURE_ENCLAVE",
    verifier_origin: "https://studio.vri.example",
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    nonce: Buffer.from("0123456789abcdef").toString("base64"),
    session_scope: ["recording"],
    session_expires_at: FUTURE,
    session_public_key: "0xdeadbeef",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// parseQRChallenge — valid cases
// ---------------------------------------------------------------------------

describe("parseQRChallenge — valid", () => {
  it("accepts a well-formed challenge", () => {
    const result = parseQRChallenge(validChallenge());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.challenge.auth_method).toBe("QR_SECURE_ENCLAVE");
    expect(result.challenge.session_scope).toEqual(["recording"]);
  });

  it("accepts multiple scopes", () => {
    const result = parseQRChallenge(validChallenge({ session_scope: ["recording", "export"] }));
    expect(result.ok).toBe(true);
  });

  it("accepts all valid scope values", () => {
    for (const scope of ["recording", "generation", "export"]) {
      const result = parseQRChallenge(validChallenge({ session_scope: [scope] }));
      expect(result.ok).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// parseQRChallenge — invalid cases
// ---------------------------------------------------------------------------

describe("parseQRChallenge — invalid", () => {
  it("rejects non-JSON", () => {
    const result = parseQRChallenge("not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/JSON/i);
  });

  it("rejects a JSON array", () => {
    const result = parseQRChallenge("[]");
    expect(result.ok).toBe(false);
  });

  it("rejects wrong auth_method", () => {
    const result = parseQRChallenge(validChallenge({ auth_method: "PASSWORD" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/auth_method/i);
  });

  it("rejects http verifier_origin", () => {
    const result = parseQRChallenge(validChallenge({ verifier_origin: "http://studio.example" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/HTTPS/i);
  });

  it("rejects missing session_id", () => {
    const result = parseQRChallenge(validChallenge({ session_id: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects empty nonce", () => {
    const result = parseQRChallenge(validChallenge({ nonce: "" }));
    expect(result.ok).toBe(false);
  });

  it("rejects empty session_scope array", () => {
    const result = parseQRChallenge(validChallenge({ session_scope: [] }));
    expect(result.ok).toBe(false);
  });

  it("rejects unknown scope", () => {
    const result = parseQRChallenge(validChallenge({ session_scope: ["unknown"] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/scope/i);
  });

  it("rejects expired challenge", () => {
    const result = parseQRChallenge(validChallenge({ session_expires_at: PAST }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/expir/i);
  });

  it("rejects missing session_expires_at", () => {
    const obj = JSON.parse(validChallenge());
    delete obj.session_expires_at;
    const result = parseQRChallenge(JSON.stringify(obj));
    expect(result.ok).toBe(false);
  });

  it("rejects missing session_public_key", () => {
    const obj = JSON.parse(validChallenge());
    delete obj.session_public_key;
    const result = parseQRChallenge(JSON.stringify(obj));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildIdentityDigest
// ---------------------------------------------------------------------------

describe("buildIdentityDigest", () => {
  const unsigned = {
    auth_method: "QR_SECURE_ENCLAVE" as const,
    device_attested: false,
    nonce: Buffer.from("0123456789abcdef").toString("base64"),
    public_key: "0x" + "ab".repeat(32),
    session_expires_at: FUTURE,
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    session_public_key: "0xdeadbeef",
    session_scope: ["recording"] as ["recording"],
    session_timestamp: FUTURE - 60,
    verifier_origin: "https://studio.vri.example",
  };

  it("produces a 32-byte digest", async () => {
    const digest = await buildIdentityDigest(unsigned);
    expect(digest).toHaveLength(32);
  });

  it("is deterministic", async () => {
    const a = await buildIdentityDigest(unsigned);
    const b = await buildIdentityDigest(unsigned);
    expect(a).toEqual(b);
  });

  it("changes when any field changes", async () => {
    const base = await buildIdentityDigest(unsigned);
    const modified = await buildIdentityDigest({ ...unsigned, session_id: "different-id" });
    expect(base).not.toEqual(modified);
  });

  it("is sensitive to verifier_origin", async () => {
    const base = await buildIdentityDigest(unsigned);
    const modified = await buildIdentityDigest({
      ...unsigned,
      verifier_origin: "https://other.vri.example",
    });
    expect(base).not.toEqual(modified);
  });
});

// ---------------------------------------------------------------------------
// deriveWatermarkNonce
// ---------------------------------------------------------------------------

describe("deriveWatermarkNonce", () => {
  it("returns a number in [0, 255]", async () => {
    const nonce = Buffer.from("0123456789abcdef").toString("base64");
    const result = await deriveWatermarkNonce(nonce);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(255);
  });

  it("is deterministic for same nonce", async () => {
    const nonce = Buffer.from("test-nonce-bytes").toString("base64");
    const a = await deriveWatermarkNonce(nonce);
    const b = await deriveWatermarkNonce(nonce);
    expect(a).toBe(b);
  });

  it("differs for different nonces", async () => {
    const a = await deriveWatermarkNonce(Buffer.from("nonce-alpha-1234").toString("base64"));
    const b = await deriveWatermarkNonce(Buffer.from("nonce-beta-56789").toString("base64"));
    // Astronomically unlikely to collide on first byte
    expect(a).not.toBe(b);
  });

  it("matches the protocol formula: SHA-256('VRI-WM-NONCE-V1\\0' || nonce_bytes)[0]", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("crypto");
    const nonceStr = Buffer.from("0123456789abcdef").toString("base64");
    const nonceBytes = Buffer.from(nonceStr, "base64");
    const context = Buffer.from("VRI-WM-NONCE-V1\0", "utf8");
    const expected = createHash("sha256").update(Buffer.concat([context, nonceBytes])).digest()[0];
    const result = await deriveWatermarkNonce(nonceStr);
    expect(result).toBe(expected);
  });
});
