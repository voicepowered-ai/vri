/**
 * VRI Wallet — Identity assertion builder
 *
 * Implements the QR challenge → unsigned assertion → digest → signed identity
 * flow defined in VRI Protocol v2.0 §8.4 and docs/identity-layer.md.
 */

import {
  canonicalizeJson,
  concatBytes,
  ensureKeyPair,
  fromHex,
  sha256,
  signDigest,
  toHex,
} from "./crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const VALID_SCOPES = ["recording", "generation", "export"] as const;
export type SessionScope = (typeof VALID_SCOPES)[number];

/** Parsed QR challenge payload from the verifier. */
export type QRChallenge = {
  auth_method: "QR_SECURE_ENCLAVE";
  verifier_origin: string;
  session_id: string;
  nonce: string; // base64-encoded, 16 bytes when decoded
  session_scope: SessionScope[];
  session_expires_at: number; // Unix seconds
  session_public_key: string; // 0x-prefixed hex
};

/** The signed identity object sent to POST /identity/redeem. */
export type IdentityAssertion = {
  auth_method: "QR_SECURE_ENCLAVE";
  verifier_origin: string;
  session_id: string;
  nonce: string;
  session_scope: SessionScope[];
  session_public_key: string;
  public_key: string;
  session_timestamp: number;
  session_expires_at: number;
  device_attested: boolean;
  attestation: Record<string, unknown>;
  signature: string;
};

export type RedeemResult =
  | { ok: true; sessionId: string; redeemedAt: number }
  | { ok: false; error: string; details?: unknown };

// ---------------------------------------------------------------------------
// Challenge validation
// ---------------------------------------------------------------------------

export type ValidationResult =
  | { ok: true; challenge: QRChallenge }
  | { ok: false; error: string };

/**
 * Parses and validates a raw QR payload string.
 * Returns a typed QRChallenge or an error message.
 */
export function parseQRChallenge(raw: string): ValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "QR inválido: no es JSON" };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: "QR inválido: formato inesperado" };
  }

  const obj = parsed as Record<string, unknown>;

  if (obj.auth_method !== "QR_SECURE_ENCLAVE") {
    return { ok: false, error: "QR inválido: auth_method no soportado" };
  }

  if (typeof obj.verifier_origin !== "string" || !obj.verifier_origin.startsWith("https://")) {
    return { ok: false, error: "Origen no seguro: el QR requiere HTTPS" };
  }

  if (typeof obj.session_id !== "string" || obj.session_id.length === 0) {
    return { ok: false, error: "QR inválido: session_id ausente" };
  }

  if (typeof obj.nonce !== "string" || Buffer.from(obj.nonce, "base64").length === 0) {
    return { ok: false, error: "QR inválido: nonce ausente o vacío" };
  }

  if (!Array.isArray(obj.session_scope) || obj.session_scope.length === 0) {
    return { ok: false, error: "QR inválido: session_scope ausente" };
  }

  for (const s of obj.session_scope) {
    if (!VALID_SCOPES.includes(s as SessionScope)) {
      return { ok: false, error: `QR inválido: scope desconocido "${s}"` };
    }
  }

  if (typeof obj.session_expires_at !== "number") {
    return { ok: false, error: "QR inválido: session_expires_at ausente" };
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (obj.session_expires_at <= nowSeconds) {
    return { ok: false, error: "Este QR ha expirado. Pide uno nuevo." };
  }

  if (typeof obj.session_public_key !== "string") {
    return { ok: false, error: "QR inválido: session_public_key ausente" };
  }

  return {
    ok: true,
    challenge: obj as unknown as QRChallenge,
  };
}

// ---------------------------------------------------------------------------
// Identity digest (VRI-ID-QR-V1 context prefix)
// ---------------------------------------------------------------------------

// UTF-8 bytes of "VRI-ID-QR-V1\0" (13 bytes including null terminator)
const IDENTITY_CONTEXT = new TextEncoder().encode("VRI-ID-QR-V1\0");

/**
 * Computes the digest the wallet must sign:
 *   SHA-256("VRI-ID-QR-V1\0" || uint32be(len) || canonical_unsigned_json)
 *
 * `attestation` field is excluded from the canonical form per the protocol.
 */
export async function buildIdentityDigest(
  unsigned: Omit<IdentityAssertion, "attestation" | "signature">
): Promise<Uint8Array> {
  const canonical = canonicalizeJson(unsigned);
  const canonicalBytes = new TextEncoder().encode(canonical);

  // 4-byte big-endian length prefix
  const lenBuf = new Uint8Array(4);
  new DataView(lenBuf.buffer).setUint32(0, canonicalBytes.length, false);

  return sha256(concatBytes(IDENTITY_CONTEXT, lenBuf, canonicalBytes));
}

// ---------------------------------------------------------------------------
// Watermark nonce derivation (§8.4.1)
// ---------------------------------------------------------------------------

const WATERMARK_NONCE_CONTEXT = new TextEncoder().encode("VRI-WM-NONCE-V1\0");

/**
 * Derives the session-bound watermark nonce byte from a QR session nonce.
 * Result is byte 7 of the watermark payload when identity is present.
 */
export async function deriveWatermarkNonce(sessionNonce: string): Promise<number> {
  const nonceBytes = new Uint8Array(Buffer.from(sessionNonce, "base64"));
  const digest = await sha256(concatBytes(WATERMARK_NONCE_CONTEXT, nonceBytes));
  return digest[0];
}

// ---------------------------------------------------------------------------
// Main redeem flow
// ---------------------------------------------------------------------------

/**
 * Signs the challenge with the device key and posts to POST /identity/redeem.
 * Returns the session ID on success or an error description.
 */
export async function redeemChallenge(
  challenge: QRChallenge,
  apiBaseUrl?: string
): Promise<RedeemResult> {
  const { publicKeyHex } = await ensureKeyPair();
  const nowSeconds = Math.floor(Date.now() / 1000);

  // Build unsigned assertion — field order does not matter for the object,
  // but canonicalizeJson will sort keys before signing.
  const unsigned: Omit<IdentityAssertion, "attestation" | "signature"> = {
    auth_method: "QR_SECURE_ENCLAVE",
    device_attested: false,
    nonce: challenge.nonce,
    public_key: publicKeyHex,
    session_expires_at: challenge.session_expires_at,
    session_id: challenge.session_id,
    session_public_key: challenge.session_public_key,
    session_scope: challenge.session_scope,
    session_timestamp: nowSeconds,
    verifier_origin: challenge.verifier_origin,
  };

  const digest = await buildIdentityDigest(unsigned);
  const signature = await signDigest(digest); // triggers biometric prompt

  const identity: IdentityAssertion = {
    ...unsigned,
    attestation: {},
    signature,
  };

  const endpoint = apiBaseUrl
    ? `${apiBaseUrl}/identity/redeem`
    : `${challenge.verifier_origin}/identity/redeem`;

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity }),
    });
  } catch (err) {
    return {
      ok: false,
      error: "Sin conexión. Verifica tu red e intenta de nuevo.",
    };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    return {
      ok: false,
      error: mapApiError(body.error),
      details: body.details,
    };
  }

  const data = await response.json();
  return {
    ok: true,
    sessionId: data.session_id,
    redeemedAt: data.redeemed_at,
  };
}

// ---------------------------------------------------------------------------
// Error mapping (API → human-readable Spanish)
// ---------------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  identity_session_not_found: "Sesión no encontrada. Escanea un QR nuevo.",
  identity_session_expired: "El QR expiró. Pide uno nuevo.",
  identity_session_replayed: "Esta sesión ya fue usada.",
  identity_nonce_replayed: "Nonce ya utilizado.",
  identity_session_not_pending: "Esta sesión ya fue autorizada.",
  IDENTITY_SIGNATURE_INVALID: "Firma inválida. Intenta de nuevo.",
  IDENTITY_UNTRUSTED_ORIGIN: "Origen no confiable.",
  IDENTITY_NONCE_MISMATCH: "El challenge no coincide con el servidor.",
};

function mapApiError(code?: string): string {
  if (!code) return "Error desconocido del servidor.";
  return ERROR_MESSAGES[code] ?? `Error: ${code}`;
}
