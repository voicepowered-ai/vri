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
  sha256,
  signDigest,
} from "./crypto";
import { Buffer } from "buffer";

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
  attestation?: Record<string, unknown>;
  signature: string;
};

export type RedeemResult =
  | { ok: true; sessionId: string; redeemedAt: number }
  | { ok: false; error: string; details?: unknown };

function debugIdentity(message: string, extra?: Record<string, unknown>): void {
  if (!__DEV__) {
    return;
  }

  if (extra) {
    console.log("[vri-wallet][identity]", message, extra);
    return;
  }

  console.log("[vri-wallet][identity]", message);
}

function isPrivateIpv4Host(hostname: string): boolean {
  const parts = hostname.split(".").map((value) => Number(value));

  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return a === 10
    || a === 127
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

function resolveRedeemEndpoint(challenge: QRChallenge, apiBaseUrl?: string): string {
  if (apiBaseUrl) {
    return `${apiBaseUrl}/identity/redeem`;
  }

  try {
    const origin = new URL(challenge.verifier_origin);
    const hostname = origin.hostname;

    // Local test mode: if the QR origin is a LAN/private host over HTTPS but no
    // explicit override was configured, fall back to the dev API running on :8787.
    if (hostname === "localhost" || hostname === "127.0.0.1" || isPrivateIpv4Host(hostname)) {
      return `http://${hostname}:8787/identity/redeem`;
    }
  } catch {
    // Fall back to the declared verifier origin below.
  }

  return `${challenge.verifier_origin}/identity/redeem`;
}

function mapSigningError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "");
  debugIdentity("Signing error", { message });

  if (/user canceled|cancelled|could not authenticate/i.test(message)) {
    return "Autenticación cancelada. Vuelve a intentar y confirma en el teléfono.";
  }

  if (/incomplete on device|no vri key found/i.test(message)) {
    return "La identidad local del wallet no estaba lista. Reabre la app e inténtalo de nuevo.";
  }

  if (/no secure random source|no prng/i.test(message)) {
    return "No se pudo inicializar la identidad criptográfica del wallet. Reinicia la app.";
  }

  return "No se pudo firmar la autorización en el dispositivo.";
}

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
  let identity: IdentityAssertion;
  debugIdentity("redeemChallenge start", {
    sessionId: challenge.session_id,
    verifierOrigin: challenge.verifier_origin,
    apiOverrideUrl: apiBaseUrl ?? null
  });

  try {
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
    debugIdentity("Identity digest built", { sessionId: challenge.session_id, publicKeyHex });
    const signature = await signDigest(digest); // triggers biometric prompt

    identity = {
      ...unsigned,
      signature,
    };
    debugIdentity("Identity signed", {
      sessionId: challenge.session_id,
      publicKeyHex,
      signatureBytes: Buffer.from(signature.slice(2), "hex").length
    });
  } catch (error) {
    debugIdentity("redeemChallenge failed before network", {
      sessionId: challenge.session_id,
      message: error instanceof Error ? error.message : String(error ?? "")
    });
    return {
      ok: false,
      error: mapSigningError(error),
    };
  }

  const endpoint = resolveRedeemEndpoint(challenge, apiBaseUrl);
  debugIdentity("Posting identity redeem request", {
    sessionId: challenge.session_id,
    endpoint
  });

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ identity }),
    });
  } catch (err) {
    debugIdentity("Redeem network error", {
      sessionId: challenge.session_id,
      message: err instanceof Error ? err.message : String(err ?? "")
    });
    return {
      ok: false,
      error: "Sin conexión. Verifica tu red e intenta de nuevo.",
    };
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    debugIdentity("Redeem rejected by API", {
      sessionId: challenge.session_id,
      status: response.status,
      error: typeof body.error === "string" ? body.error : null,
      details: "details" in body ? body.details : null
    });
    return {
      ok: false,
      error: mapApiError(body.error),
      details: body.details,
    };
  }

  const data = await response.json();
  debugIdentity("Redeem accepted by API", {
    sessionId: data.session_id,
    redeemedAt: data.redeemed_at
  });
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
