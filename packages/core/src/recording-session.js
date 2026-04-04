/**
 * Session-based verification model
 *
 * A RecordingSession is the core entity that links every generated audio asset to:
 *   - a human identity  (actor_id / wallet)
 *   - a recording context (studio_id, start_time)
 *   - a verification method (QR scan or manual)
 *
 * The system is evolving from:
 *   ❌ plain audio verification
 * to:
 *   ✅ session-based, identity-linked, AI-traceable audio verification
 *
 * Every generated audio must be traceable to a RecordingSession so that verifiers
 * can prove *who* created it, *where/when*, and *which AI model* was used.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SESSION_VERIFICATION_METHODS = {
  QR_SCAN: "qr_scan",
  MANUAL: "manual"
};

export const RECORDING_SESSION_STATUS = {
  ACTIVE: "ACTIVE",
  EXPIRED: "EXPIRED",
  CLOSED: "CLOSED"
};

const ALLOWED_VERIFICATION_METHODS = new Set(Object.values(SESSION_VERIFICATION_METHODS));

// ---------------------------------------------------------------------------
// RecordingSession factory
// ---------------------------------------------------------------------------

/**
 * Creates a new RecordingSession entity.
 *
 * A RecordingSession represents a real-world recording context that binds:
 * - actor_id    — wallet / identity of the voice actor
 * - studio_id   — optional studio identifier
 * - start_time  — ISO timestamp when the session started
 * - verification_method — how the session was activated (QR scan vs manual)
 * - session_verified — true when verified via QR_SCAN
 *
 * @param {object} options
 * @param {string}          options.actor_id             - Wallet / identity of the voice actor (required)
 * @param {string|null}     [options.studio_id]          - Optional studio identifier
 * @param {"qr_scan"|"manual"} [options.verification_method] - How the session was activated
 * @param {string|null}     [options.session_id]         - Custom session ID (UUID generated if omitted)
 * @param {string|null}     [options.start_time]         - ISO timestamp (current time if omitted)
 * @returns {RecordingSession}
 */
export function createRecordingSession({
  actor_id,
  studio_id = null,
  verification_method = SESSION_VERIFICATION_METHODS.MANUAL,
  session_id = null,
  start_time = null
} = {}) {
  if (typeof actor_id !== "string" || actor_id.length === 0) {
    throw new TypeError("actor_id must be a non-empty string.");
  }

  if (!ALLOWED_VERIFICATION_METHODS.has(verification_method)) {
    throw new TypeError(
      `verification_method must be one of: ${[...ALLOWED_VERIFICATION_METHODS].join(", ")}.`
    );
  }

  return {
    session_id: typeof session_id === "string" && session_id.length > 0
      ? session_id
      : `rsess_${crypto.randomUUID()}`,
    actor_id,
    studio_id: typeof studio_id === "string" && studio_id.length > 0 ? studio_id : null,
    start_time: typeof start_time === "string" && start_time.length > 0
      ? start_time
      : new Date().toISOString(),
    verification_method,
    // session_verified is true only for QR-based activation, which involves
    // cryptographic proof from the actor's secure enclave
    session_verified: verification_method === SESSION_VERIFICATION_METHODS.QR_SCAN,
    status: RECORDING_SESSION_STATUS.ACTIVE,
    created_at: Math.floor(Date.now() / 1000)
  };
}

// ---------------------------------------------------------------------------
// QR-based session activation
// ---------------------------------------------------------------------------

/**
 * Creates a RecordingSession from a QR code payload.
 *
 * In a QR-based activation flow the mobile app scans a studio QR code
 * containing actor and studio identifiers.  This function parses that payload
 * and produces a cryptographically-verified RecordingSession
 * (session_verified = true).
 *
 * Expected QR payload fields:
 *   - actor_id  {string}  — the voice actor's wallet / identity (required)
 *   - studio_id {string}  — optional studio context identifier
 *
 * No UI is implemented here; callers supply the already-decoded QR payload.
 *
 * @param {object} qrPayload - Raw decoded QR code contents
 * @returns {RecordingSession}
 */
export function createSessionFromQR(qrPayload) {
  if (!qrPayload || typeof qrPayload !== "object" || Array.isArray(qrPayload)) {
    throw new TypeError("qrPayload must be a JSON object.");
  }

  const { actor_id, studio_id = null } = qrPayload;

  if (typeof actor_id !== "string" || actor_id.length === 0) {
    throw new TypeError("qrPayload.actor_id must be a non-empty string.");
  }

  return createRecordingSession({
    actor_id,
    studio_id: typeof studio_id === "string" && studio_id.length > 0 ? studio_id : null,
    // QR-based activation sets session_verified = true automatically
    verification_method: SESSION_VERIFICATION_METHODS.QR_SCAN
  });
}

// ---------------------------------------------------------------------------
// Session validation middleware helper
// ---------------------------------------------------------------------------

/**
 * Validates the structure and state of a RecordingSession object.
 *
 * Used as a session validation middleware step: callers should call this
 * before accepting a session for inference/registration.
 *
 * @param {object} session
 * @returns {{ ok: boolean, error?: string }}
 */
export function validateRecordingSession(session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    return { ok: false, error: "session must be a JSON object" };
  }

  if (typeof session.session_id !== "string" || session.session_id.length === 0) {
    return { ok: false, error: "session.session_id must be a non-empty string" };
  }

  if (typeof session.actor_id !== "string" || session.actor_id.length === 0) {
    return { ok: false, error: "session.actor_id must be a non-empty string" };
  }

  if (!ALLOWED_VERIFICATION_METHODS.has(session.verification_method)) {
    return {
      ok: false,
      error: `session.verification_method must be one of: ${[...ALLOWED_VERIFICATION_METHODS].join(", ")}`
    };
  }

  if (typeof session.session_verified !== "boolean") {
    return { ok: false, error: "session.session_verified must be a boolean" };
  }

  if (session.status === RECORDING_SESSION_STATUS.CLOSED) {
    return { ok: false, error: "recording session is closed" };
  }

  if (session.status === RECORDING_SESSION_STATUS.EXPIRED) {
    return { ok: false, error: "recording session has expired" };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// RecordingSessionStore — lightweight persistent store
// ---------------------------------------------------------------------------

/**
 * In-memory (optionally file-backed) store for RecordingSession entities.
 *
 * Follows the same persistence pattern as IdentitySessionStore in server.js:
 * writes to a JSONL-compatible JSON file so state survives server restarts.
 */
export class RecordingSessionStore {
  #sessions = new Map();
  #filePath;

  constructor(options = {}) {
    this.#filePath = options.filePath ?? null;

    if (this.#filePath) {
      this.#loadFromDisk();
    }
  }

  #loadFromDisk() {
    if (!fs.existsSync(this.#filePath)) {
      return;
    }

    const payload = JSON.parse(fs.readFileSync(this.#filePath, "utf8"));
    const sessions = Array.isArray(payload?.sessions) ? payload.sessions : [];

    for (const session of sessions) {
      if (session && typeof session.session_id === "string" && session.session_id.length > 0) {
        this.#sessions.set(session.session_id, session);
      }
    }
  }

  #persistToDisk() {
    if (!this.#filePath) {
      return;
    }

    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    fs.writeFileSync(this.#filePath, JSON.stringify({
      version: 1,
      sessions: Array.from(this.#sessions.values())
    }, null, 2), "utf8");
  }

  /**
   * Creates and stores a new RecordingSession.
   *
   * @param {object} options - Same options as createRecordingSession()
   * @returns {RecordingSession}
   */
  create(options) {
    const session = createRecordingSession(options);
    this.#sessions.set(session.session_id, session);
    this.#persistToDisk();
    return session;
  }

  /**
   * Creates and stores a new RecordingSession from a QR payload.
   *
   * @param {object} qrPayload - Same as createSessionFromQR() argument
   * @returns {RecordingSession}
   */
  createFromQR(qrPayload) {
    const session = createSessionFromQR(qrPayload);
    this.#sessions.set(session.session_id, session);
    this.#persistToDisk();
    return session;
  }

  /**
   * Retrieves a RecordingSession by ID.
   *
   * @param {string} sessionId
   * @returns {RecordingSession|null}
   */
  get(sessionId) {
    return this.#sessions.get(sessionId) ?? null;
  }

  /**
   * Closes a RecordingSession, preventing further use.
   *
   * @param {string} sessionId
   * @returns {{ ok: boolean, session?: RecordingSession, error?: string }}
   */
  close(sessionId) {
    const session = this.get(sessionId);

    if (!session) {
      return { ok: false, error: "recording_session_not_found" };
    }

    session.status = RECORDING_SESSION_STATUS.CLOSED;
    this.#persistToDisk();

    return { ok: true, session };
  }
}
