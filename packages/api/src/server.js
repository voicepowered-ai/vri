import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  createSessionChallenge,
  getTimestampAttestationReceiptDigest,
  getCanonicalIdentityString,
  registerVoice,
  verifyVoice,
  verifyProofPackage,
  createNonceReplayTracker,
  PROOF_TYPES,
  SESSION_SCOPES,
  verifyIdentityAssertion
} from "../../core/src/index.js";
import { createKeyManager } from "../../core/src/key-manager.js";
import { createAuditLog, EVENT_TYPES } from "../../core/src/audit-log.js";
import { createLedger, ExternalAnchorError } from "../../ledger/src/index.js";
import { createWatermarkEngine } from "../../watermark/src/index.js";
import { createApiKeyManager, ROLES } from "../../core/src/api-key-manager.js";
import { createPerfProfiler } from "../../core/src/perf-profiler.js";
import { createBatchScheduler } from "../../ledger/src/scheduler.js";
import { createRevocationRegistry } from "../../core/src/revocation-registry.js";
import {
  normalizeRfc3161TimestampAttestation,
  verifyRfc3161TimestampAttestation
} from "../../core/src/timestamp-attestation.js";
import {
  buildOpenSslTimestampVerifyArgs,
  parseRfc3161TokenWithOpenSsl
} from "../../core/src/openssl-rfc3161.js";
// Session-based verification model: RecordingSession store and helpers
import {
  RecordingSessionStore,
  SESSION_VERIFICATION_METHODS,
  validateRecordingSession
} from "../../core/src/recording-session.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

function assertNoDuplicateJsonObjectKeys(source) {
  let index = 0;

  function skipWhitespace() {
    while (index < source.length && /\s/.test(source[index])) {
      index += 1;
    }
  }

  function parseString() {
    if (source[index] !== '"') {
      throw new Error("Invalid JSON string.");
    }

    index += 1;
    let result = "";

    while (index < source.length) {
      const ch = source[index];
      index += 1;

      if (ch === '"') {
        return result;
      }

      if (ch === "\\") {
        if (index >= source.length) {
          throw new Error("Invalid JSON escape sequence.");
        }

        const esc = source[index];
        index += 1;

        if (esc === "u") {
          const hex = source.slice(index, index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            throw new Error("Invalid Unicode escape sequence.");
          }
          result += String.fromCharCode(Number.parseInt(hex, 16));
          index += 4;
        } else {
          const map = {
            '"': '"',
            "\\": "\\",
            "/": "/",
            b: "\b",
            f: "\f",
            n: "\n",
            r: "\r",
            t: "\t"
          };
          if (!(esc in map)) {
            throw new Error("Invalid JSON escape sequence.");
          }
          result += map[esc];
        }
      } else {
        result += ch;
      }
    }

    throw new Error("Unterminated JSON string.");
  }

  function parseLiteral(literal) {
    if (source.slice(index, index + literal.length) !== literal) {
      throw new Error("Invalid JSON literal.");
    }
    index += literal.length;
  }

  function parseNumber() {
    const numberPattern = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(source);
    if (!match) {
      throw new Error("Invalid JSON number.");
    }
    index = numberPattern.lastIndex;
  }

  function parseArray() {
    index += 1; // [
    skipWhitespace();
    if (source[index] === "]") {
      index += 1;
      return;
    }

    while (index < source.length) {
      parseValue();
      skipWhitespace();
      if (source[index] === ",") {
        index += 1;
        skipWhitespace();
        continue;
      }
      if (source[index] === "]") {
        index += 1;
        return;
      }
      throw new Error("Invalid JSON array.");
    }

    throw new Error("Unterminated JSON array.");
  }

  function parseObject() {
    index += 1; // {
    skipWhitespace();
    const keys = new Set();

    if (source[index] === "}") {
      index += 1;
      return;
    }

    while (index < source.length) {
      const key = parseString();
      if (keys.has(key)) {
        const error = new Error(`Duplicate JSON key: ${key}`);
        error.code = "DUPLICATE_JSON_KEY";
        throw error;
      }
      keys.add(key);

      skipWhitespace();
      if (source[index] !== ":") {
        throw new Error("Invalid JSON object.");
      }
      index += 1;
      skipWhitespace();
      parseValue();
      skipWhitespace();

      if (source[index] === ",") {
        index += 1;
        skipWhitespace();
        continue;
      }

      if (source[index] === "}") {
        index += 1;
        return;
      }

      throw new Error("Invalid JSON object.");
    }

    throw new Error("Unterminated JSON object.");
  }

  function parseValue() {
    skipWhitespace();
    const ch = source[index];
    if (ch === "{") return parseObject();
    if (ch === "[") return parseArray();
    if (ch === '"') return parseString();
    if (ch === "t") return parseLiteral("true");
    if (ch === "f") return parseLiteral("false");
    if (ch === "n") return parseLiteral("null");
    return parseNumber();
  }

  skipWhitespace();
  parseValue();
  skipWhitespace();

  if (index !== source.length) {
    throw new Error("Unexpected trailing JSON content.");
  }
}

async function readJson(request, maxBytes = 8 * 1024 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) {
      const error = new Error("Request body too large");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  try {
    const jsonText = Buffer.concat(chunks).toString("utf8");
    assertNoDuplicateJsonObjectKeys(jsonText);
    return JSON.parse(jsonText);
  } catch {
    const error = new Error("Invalid JSON payload");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseComplianceLevel(value, { required = false } = {}) {
  if (value == null) {
    if (required) {
      return { ok: false, error: "compliance_level is required" };
    }
    return { ok: true, level: null };
  }

  if (!Number.isInteger(value) || value < 1 || value > 3) {
    return { ok: false, error: "compliance_level must be an integer in range [1,3]" };
  }

  return { ok: true, level: value };
}

function parseProofType(value, { required = false } = {}) {
  if (value == null) {
    if (required) {
      return { ok: false, error: "proofType is required" };
    }
    return { ok: true, proofType: null };
  }

  if (value !== PROOF_TYPES.RECORDED && value !== PROOF_TYPES.GENERATED) {
    return { ok: false, error: `proofType must be ${PROOF_TYPES.RECORDED} or ${PROOF_TYPES.GENERATED}` };
  }

  return { ok: true, proofType: value };
}

function parseSessionScopeList(value) {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: "sessionScope must be a non-empty array" };
  }

  const allowedScopes = new Set(Object.values(SESSION_SCOPES));

  for (const entry of value) {
    if (typeof entry !== "string" || !allowedScopes.has(entry)) {
      return {
        ok: false,
        error: `sessionScope contains an unsupported value; allowed values are: ${[...allowedScopes].join(", ")}`
      };
    }
  }

  return {
    ok: true,
    scopes: [...new Set(value)].sort()
  };
}

function isHexSha256(value) {
  return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
}

function validateExportLineageMetadata(metadata) {
  if (!isJsonObject(metadata)) {
    return { ok: false, error: "metadata must be a JSON object" };
  }

  if (!isJsonObject(metadata.lineage)) {
    return { ok: false, error: "metadata.lineage is required for export registration" };
  }

  const lineage = metadata.lineage;

  if (!isHexSha256(lineage.parent_audio_hash)) {
    return { ok: false, error: "metadata.lineage.parent_audio_hash must be a 0x-prefixed 32-byte SHA-256 hex string" };
  }

  if (lineage.source_proof_type !== PROOF_TYPES.RECORDED && lineage.source_proof_type !== PROOF_TYPES.GENERATED) {
    return { ok: false, error: `metadata.lineage.source_proof_type must be ${PROOF_TYPES.RECORDED} or ${PROOF_TYPES.GENERATED}` };
  }

  if (typeof lineage.source_event_id !== "string" || lineage.source_event_id.length === 0) {
    return { ok: false, error: "metadata.lineage.source_event_id is required for export registration" };
  }

  return { ok: true };
}

async function validateExportLineageAgainstLedger(metadata, ledger) {
  const lineageValidation = validateExportLineageMetadata(metadata);

  if (!lineageValidation.ok) {
    return lineageValidation;
  }

  const parentEvent = await ledger.getEvent(metadata.lineage.source_event_id);

  if (!parentEvent) {
    return { ok: false, error: "metadata.lineage.source_event_id does not reference an existing ledger event" };
  }

  if (parentEvent.audio_hash !== metadata.lineage.parent_audio_hash) {
    return { ok: false, error: "metadata.lineage.parent_audio_hash does not match the referenced ledger event" };
  }

  if (parentEvent.proof_type !== metadata.lineage.source_proof_type) {
    return { ok: false, error: "metadata.lineage.source_proof_type does not match the referenced ledger event" };
  }

  return {
    ok: true,
    parentEvent
  };
}

function mapBatchPublication(batch) {
  if (!batch) {
    return null;
  }

  return {
    published: Boolean(batch.external_anchor_id),
    confirmed: batch.blockchain_confirmed === true,
    provider: batch.external_anchor_provider ?? null,
    network: batch.blockchain_chain ?? null,
    transaction_hash: batch.blockchain_tx ?? null,
    external_anchor_id: batch.external_anchor_id ?? null,
    published_at: batch.external_anchor_published_at ?? null
  };
}

class IdentitySessionStore {
  #challenges = new Map();
  #usedNonces = new Set();
  #usedSessionIds = new Set();
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
    const usedNonces = Array.isArray(payload?.used_nonces) ? payload.used_nonces : [];
    const usedSessionIds = Array.isArray(payload?.used_session_ids) ? payload.used_session_ids : [];

    this.#challenges = new Map(
      sessions
        .filter((session) => session && typeof session.session_id === "string" && session.session_id.length > 0)
        .map((session) => [session.session_id, session])
    );
    this.#usedNonces = new Set(
      usedNonces.filter((nonce) => typeof nonce === "string" && nonce.length > 0)
    );
    this.#usedSessionIds = new Set(
      usedSessionIds.filter((sessionId) => typeof sessionId === "string" && sessionId.length > 0)
    );
  }

  #persistToDisk() {
    if (!this.#filePath) {
      return;
    }

    fs.mkdirSync(path.dirname(this.#filePath), { recursive: true });
    fs.writeFileSync(this.#filePath, JSON.stringify({
      version: 1,
      sessions: Array.from(this.#challenges.values()),
      used_nonces: Array.from(this.#usedNonces.values()),
      used_session_ids: Array.from(this.#usedSessionIds.values())
    }, null, 2), "utf8");
  }

  issue({ verifierOrigin, sessionScope, ttlSeconds, sessionPublicKey, nowTimestamp }) {
    const expiresAt = nowTimestamp + ttlSeconds;
    const challenge = createSessionChallenge({
      verifierOrigin,
      expiresAt,
      sessionScope,
      sessionPublicKey
    });

    this.#challenges.set(challenge.session_id, {
      ...challenge,
      status: "PENDING",
      created_at: nowTimestamp,
      redeemed_at: null,
      consumed_at: null,
      identity: null
    });
    this.#persistToDisk();

    return challenge;
  }

  get(sessionId) {
    return this.#challenges.get(sessionId) ?? null;
  }

  redeem(identity, { nowTimestamp, trustedVerifierOrigins, verifyDeviceAttestation }) {
    const sessionId = identity?.session_id;
    const challenge = this.get(sessionId);

    if (!challenge) {
      return { ok: false, error: "identity_session_not_found" };
    }

    if (challenge.status !== "PENDING") {
      return { ok: false, error: "identity_session_not_pending" };
    }

    if (nowTimestamp > challenge.session_expires_at) {
      challenge.status = "EXPIRED";
      this.#persistToDisk();
      return { ok: false, error: "identity_session_expired" };
    }

    if (this.#usedSessionIds.has(sessionId)) {
      return { ok: false, error: "identity_session_replayed" };
    }

    if (this.#usedNonces.has(challenge.nonce)) {
      return { ok: false, error: "identity_nonce_replayed" };
    }

    const verification = verifyIdentityAssertion(identity, {
      nowTimestamp,
      trustedVerifierOrigins,
      expectedSessionId: challenge.session_id,
      expectedNonce: challenge.nonce,
      expectedSessionPublicKey: challenge.session_public_key,
      verifyDeviceAttestation
    });

    if (!verification.ok) {
      return { ok: false, error: verification.reason, details: verification.details };
    }

    this.#usedSessionIds.add(sessionId);
    this.#usedNonces.add(challenge.nonce);
    challenge.status = "AUTHORIZED";
    challenge.redeemed_at = nowTimestamp;
    challenge.identity = identity;
    this.#persistToDisk();

    return {
      ok: true,
      session: challenge
    };
  }

  consume(sessionId, { nowTimestamp }) {
    const challenge = this.get(sessionId);

    if (!challenge) {
      return { ok: false, error: "identity_session_not_found" };
    }

    if (challenge.status !== "AUTHORIZED") {
      return { ok: false, error: "identity_session_not_consumable" };
    }

    if (nowTimestamp > challenge.session_expires_at) {
      challenge.status = "EXPIRED";
      this.#persistToDisk();
      return { ok: false, error: "identity_session_expired" };
    }

    challenge.status = "CONSUMED";
    challenge.consumed_at = nowTimestamp;
    this.#persistToDisk();

    return {
      ok: true,
      session: challenge
    };
  }

  authorize(identity, { requiredScope, nowTimestamp }) {
    const sessionId = identity?.session_id;
    const challenge = this.get(sessionId);

    if (!challenge) {
      return { ok: false, error: "identity_session_not_found" };
    }

    if (challenge.status === "CONSUMED") {
      return { ok: false, error: "identity_session_consumed" };
    }

    if (challenge.status !== "AUTHORIZED") {
      return { ok: false, error: "identity_session_not_authorized" };
    }

    if (nowTimestamp > challenge.session_expires_at) {
      challenge.status = "EXPIRED";
      this.#persistToDisk();
      return { ok: false, error: "identity_session_expired" };
    }

    if (!Array.isArray(challenge.session_scope) || !challenge.session_scope.includes(requiredScope)) {
      return { ok: false, error: "identity_session_scope_invalid" };
    }

    if (getCanonicalIdentityString(challenge.identity) !== getCanonicalIdentityString(identity)) {
      return { ok: false, error: "identity_session_mismatch" };
    }

    return this.consume(sessionId, { nowTimestamp });
  }
}

function loadTrustedTimestampAuthoritiesFromFile(filePath) {
  if (!filePath) {
    return {
      trustedTimestampAuthorities: [],
      trustPolicy: null
    };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`trustedTimestampAuthoritiesFilePath does not exist: ${filePath}`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const authorities = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.trusted_timestamp_authorities)
      ? payload.trusted_timestamp_authorities
      : Array.isArray(payload?.authorities)
        ? payload.authorities
      : null;

  if (!authorities) {
    throw new TypeError("trustedTimestampAuthoritiesFilePath must contain an array or trusted_timestamp_authorities array.");
  }

  const normalizedAuthorities = normalizeTrustedTimestampAuthorities(authorities);
  const trustPolicy = buildTimestampTrustPolicy({
    version: payload?.version ?? 1,
    effectiveAt: payload?.effective_at ?? null,
    profileId: payload?.profile_id ?? null,
    profileName: payload?.profile_name ?? null,
    source: filePath,
    authorities: normalizedAuthorities,
    validationProfile: sortObject(payload?.validation_profile ?? null)
  });

  return {
    trustedTimestampAuthorities: normalizedAuthorities,
    trustPolicy
  };
}

function loadTrustedTimestampAuthoritiesFromCatalog(filePath, profileId) {
  if (!filePath) {
    return {
      trustedTimestampAuthorities: [],
      trustPolicy: null,
      availableProfiles: []
    };
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`trustedTimestampAuthoritiesCatalogFilePath does not exist: ${filePath}`);
  }

  const payload = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const profiles = Array.isArray(payload?.profiles) ? payload.profiles : null;

  if (!profiles || profiles.length === 0) {
    throw new TypeError("trustedTimestampAuthoritiesCatalogFilePath must contain a non-empty profiles array.");
  }

  const availableProfiles = profiles.map((profile) => ({
    profile_id: profile?.profile_id ?? null,
    profile_name: profile?.profile_name ?? null,
    version: profile?.version ?? 1,
    effective_at: profile?.effective_at ?? null
  }));

  if (typeof profileId !== "string" || profileId.length === 0) {
    throw new TypeError("timestampTrustProfileId is required when using trustedTimestampAuthoritiesCatalogFilePath.");
  }

  const profile = profiles.find((entry) => entry?.profile_id === profileId);

  if (!profile) {
    throw new Error(`timestamp trust profile not found in catalog: ${profileId}`);
  }

  const authorities = Array.isArray(profile?.trusted_timestamp_authorities)
    ? profile.trusted_timestamp_authorities
    : Array.isArray(profile?.authorities)
      ? profile.authorities
      : null;

  if (!authorities) {
    throw new TypeError("selected timestamp trust profile must contain trusted_timestamp_authorities or authorities.");
  }

  const normalizedAuthorities = normalizeTrustedTimestampAuthorities(authorities);
  const trustPolicy = buildTimestampTrustPolicy({
    version: profile?.version ?? 1,
    effectiveAt: profile?.effective_at ?? null,
    profileId: profile.profile_id ?? null,
    profileName: profile.profile_name ?? null,
    source: `${filePath}#${profile.profile_id}`,
    authorities: normalizedAuthorities,
    validationProfile: sortObject(profile?.validation_profile ?? null)
  });

  return {
    trustedTimestampAuthorities: normalizedAuthorities,
    trustPolicy,
    availableProfiles
  };
}

function normalizeTrustedTimestampAuthorities(authorities) {
  if (!Array.isArray(authorities)) {
    return [];
  }

  return authorities.map((authority) => {
    if (typeof authority === "string") {
      return { tsa: authority };
    }

    if (!authority || typeof authority !== "object" || Array.isArray(authority)) {
      throw new TypeError("trusted timestamp authority entries must be strings or JSON objects.");
    }

    return { ...authority };
  });
}

function buildTimestampValidationProfile(options = {}) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    return null;
  }

  const profile = sortObject({
    adapter: "openssl-ts-verify",
    token_in: options.tokenIn === true,
    attime: Number.isInteger(options.attime) ? options.attime : null,
    purpose: typeof options.purpose === "string" && options.purpose.length > 0 ? options.purpose : null,
    verify_name: typeof options.verifyName === "string" && options.verifyName.length > 0 ? options.verifyName : null,
    verify_depth: Number.isInteger(options.verifyDepth) ? options.verifyDepth : null,
    auth_level: Number.isInteger(options.authLevel) ? options.authLevel : null,
    policy: typeof options.policy === "string" && options.policy.length > 0 ? options.policy : null,
    crl_check: options.crlCheck === true,
    crl_check_all: options.crlCheckAll === true,
    use_deltas: options.useDeltas === true,
    extended_crl: options.extendedCrl === true,
    policy_check: options.policyCheck === true,
    explicit_policy: options.explicitPolicy === true,
    inhibit_any: options.inhibitAny === true,
    inhibit_map: options.inhibitMap === true,
    x509_strict: options.x509Strict === true,
    partial_chain: options.partialChain === true,
    check_ss_sig: options.checkSsSig === true,
    no_check_time: options.noCheckTime === true,
    verify_args: buildOpenSslTimestampVerifyArgs(options)
  });

  const hasMeaningfulFields = Object.values(profile).some((value) => {
    if (value === null || value === false) {
      return false;
    }

    if (Array.isArray(value)) {
      return value.length > 0;
    }

    return true;
  });

  return hasMeaningfulFields ? profile : null;
}

function buildTimestampTrustPolicy({
  version = 1,
  effectiveAt = null,
  profileId = null,
  profileName = null,
  source = null,
  authorities = [],
  validationProfile = null
}) {
  const normalizedAuthorities = normalizeTrustedTimestampAuthorities(authorities)
    .map((authority) => sortObject(authority))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const canonicalPolicy = sortObject({
    profile_id: profileId,
    profile_name: profileName,
    version,
    effective_at: effectiveAt,
    authorities: normalizedAuthorities,
    validation_profile: validationProfile
  });
  const policyDigest = `0x${crypto.createHash("sha256").update(JSON.stringify(canonicalPolicy)).digest("hex")}`;

  return {
    profile_id: profileId,
    profile_name: profileName,
    version,
    effective_at: effectiveAt,
    source,
    policy_digest: policyDigest,
    authority_count: normalizedAuthorities.length,
    validation_profile: validationProfile
  };
}

function sortObject(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => sortObject(entry));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortObject(value[key])])
    );
  }

  return value;
}

export function createServer(options = {}) {
  const maxRequestBytes = Math.max(1024, Number(options.maxRequestBytes ?? 8 * 1024 * 1024));
  const maxAudioBytes = Math.max(1024, Number(options.maxAudioBytes ?? 8 * 1024 * 1024));
  const verifySecurity = {
    enforceFreshness: options.verifyEnforceFreshness ?? true,
    maxTimestampSkewSeconds: Number(options.verifyMaxTimestampSkewSeconds ?? 24 * 60 * 60),
    trackNonce: options.verifyTrackNonce ?? true
  };
  const verifyRequireIdentity = options.verifyRequireIdentity ?? false;
  const registerRequireAuthorizedIdentitySession = options.registerRequireAuthorizedIdentitySession ?? false;
  const verifyProfile = options.verifyProfile ?? "strict";
  const parsedRequiredComplianceLevel = parseComplianceLevel(options.verifyRequiredComplianceLevel ?? 1, { required: true });

  if (!parsedRequiredComplianceLevel.ok) {
    throw new TypeError(`Invalid verifyRequiredComplianceLevel: ${parsedRequiredComplianceLevel.error}`);
  }

  const requiredComplianceLevel = parsedRequiredComplianceLevel.level;
  const watermarkEngine = options.watermarkEngine ?? createWatermarkEngine();
  const ledger = options.ledger ?? createLedger({
    filePath: options.ledgerFilePath,
    batchFilePath: options.batchFilePath,
    batchSize: options.batchSize,
    storageBackend: options.storageBackend,
    batchStorageBackend: options.batchStorageBackend,
    postgresPool: options.postgresPool,
    mongoClient: options.mongoClient,
    mongoDb: options.mongoDb,
    eventCollectionName: options.eventCollectionName,
    batchCollectionName: options.batchCollectionName,
    eventTableName: options.eventTableName,
    batchTableName: options.batchTableName,
    anchorPolicy: {
      allowlist: options.externalAnchorAllowlist ?? [],
      allowPrivateNetworks: options.externalAnchorAllowPrivateNetworks ?? false,
      allowLocalhost: options.externalAnchorAllowLocalhost ?? false,
      allowInsecureHttp: options.externalAnchorAllowInsecureHttp ?? false,
      timeoutMs: options.externalAnchorTimeoutMs,
      maxResponseBytes: options.externalAnchorMaxResponseBytes
    }
  });
  const keyManager = options.keyManager ?? createKeyManager();
  const auditLog = options.auditLog ?? createAuditLog({ backend: options.auditLogBackend || "memory" });
  const apiKeyManager = options.apiKeyManager ?? createApiKeyManager();
  const perfProfiler = options.perfProfiler ?? createPerfProfiler();
  const scheduler = options.scheduler ?? createBatchScheduler(ledger, options.schedulerConfig);
  const nonceTracker = options.nonceTracker
    ?? (verifySecurity.trackNonce ? createNonceReplayTracker({
      filePath: options.nonceReplayStoreFilePath ?? null
    }) : null);
  const schedulerConcurrency = Math.max(1, Number(options.schedulerConcurrency ?? 1) || 1);
  const schedulerAutoStart = options.schedulerAutoStart ?? true;
  const identitySessionStore = options.identitySessionStore ?? new IdentitySessionStore({
    filePath: options.identitySessionStoreFilePath ?? null
  });
  const revocationRegistry = options.revocationRegistry ?? createRevocationRegistry({
    filePath: options.revocationRegistryFilePath ?? null
  });
  // Session-based verification model: store for RecordingSession entities.
  // Each RecordingSession links audio registrations to a human actor identity
  // and an optional studio context.
  const recordingSessionStore = options.recordingSessionStore ?? new RecordingSessionStore({
    filePath: options.recordingSessionStoreFilePath ?? null
  });
  const trustedTimestampAuthorityConfig = options.trustedTimestampAuthoritiesCatalogFilePath
    ? loadTrustedTimestampAuthoritiesFromCatalog(
      options.trustedTimestampAuthoritiesCatalogFilePath,
      options.timestampTrustProfileId ?? null
    )
    : Array.isArray(options.trustedTimestampAuthorities)
    ? {
      trustedTimestampAuthorities: normalizeTrustedTimestampAuthorities(options.trustedTimestampAuthorities),
      trustPolicy: buildTimestampTrustPolicy({
        version: 1,
        effectiveAt: null,
        profileId: options.timestampTrustProfileId ?? "inline-default",
        profileName: options.timestampTrustProfileName ?? "Inline TSA Trust Policy",
        source: "inline",
        authorities: options.trustedTimestampAuthorities,
        validationProfile: buildTimestampValidationProfile(options.openSslTimestampOptions ?? null)
      }),
      availableProfiles: []
    }
    : {
      ...loadTrustedTimestampAuthoritiesFromFile(options.trustedTimestampAuthoritiesFilePath ?? null),
      availableProfiles: []
    };
  const trustedTimestampAuthorities = trustedTimestampAuthorityConfig.trustedTimestampAuthorities;
  const timestampTrustPolicy = trustedTimestampAuthorityConfig.trustPolicy;
  const availableTimestampTrustProfiles = trustedTimestampAuthorityConfig.availableProfiles ?? [];
  const timestampAttestationVerifier = options.verifyTimestampAttestation
    ?? ((attestation, context) => {
      if (attestation?.type !== "RFC3161") {
        return { ok: false, reason: "unsupported timestamp attestation type" };
      }

      return verifyRfc3161TimestampAttestation(attestation, {
        ...context,
        trustedAuthorities: trustedTimestampAuthorities
      });
    });
  const rfc3161TokenParser = typeof options.parseRfc3161Token === "function"
    ? options.parseRfc3161Token
    : options.openSslTimestampOptions
      ? ((token, context) => parseRfc3161TokenWithOpenSsl(token, {
        ...context,
        openSslOptions: options.openSslTimestampOptions
      }))
    : null;
  const identityChallengeTtlSeconds = Math.max(30, Number(options.identityChallengeTtlSeconds ?? 300) || 300);
  const trustedVerifierOrigins = options.trustedVerifierOrigins ?? [];
  // Session-based verification model: enforcement options.
  //
  // requireVerifiedSession — when true, every GENERATED registration MUST supply a
  //   session_id that resolves to a RecordingSession with session_verified === true
  //   (i.e. activated via QR scan).  Registrations without a verified session are
  //   rejected.  Defaults to false for backward compatibility.
  //
  // requireInputVerification — when true, every GENERATED registration MUST supply
  //   inferenceMetadata.input_reference pointing to a RECORDED event already in the
  //   ledger.  This ensures the source audio was recorded WITH THIS SYSTEM before it
  //   was fed to the AI model.  Registrations whose source audio is unknown or comes
  //   from outside the system are rejected.  Defaults to false for backward compat.
  const requireVerifiedSession = options.requireVerifiedSession ?? false;
  const requireInputVerification = options.requireInputVerification ?? false;
  let schedulerStarted = false;

  function ensureSchedulerStarted() {
    if (schedulerStarted || !schedulerAutoStart) {
      return;
    }

    schedulerStarted = true;
    scheduler.start(schedulerConcurrency).catch(() => {
      schedulerStarted = false;
    });
  }
  const defaultVerificationEndpoint = options.verificationEndpoint ?? "http://localhost:8787/verify-proof";
  const requireAuth = options.requireAuth ?? false;

  async function handleRegistration(body, response, keyData, {
    proofType,
    requiredScope = null,
    defaultComplianceLevel = null,
    requireExportLineage = false,
    // Allows per-route override of the server-level enforcement flags.
    // GENERATED routes pass enforceVerifiedSession/enforceInputVerification = true
    // when the server option is active; RECORDED routes always bypass input check.
    enforceVerifiedSession = false,
    enforceInputVerification = false
  }) {
    ensureSchedulerStarted();
    if (keyData && !apiKeyManager.canPerform(keyData.role, "register")) {
      return sendJson(response, 403, { error: "Insufficient permissions" });
    }
    if (keyData && !apiKeyManager.checkQuota(keyData.orgId).allowed) {
      return sendJson(response, 429, { error: "Quota exceeded", retryAfter: 3600 });
    }

    const audio = Buffer.from(body.audioBase64 ?? "", "base64");

    if (audio.length === 0) {
      return sendJson(response, 400, { error: "audioBase64 is required" });
    }

    if (audio.length > maxAudioBytes) {
      return sendJson(response, 413, { error: "audio_too_large", max_bytes: maxAudioBytes });
    }

    if (body.metadata != null && !isJsonObject(body.metadata)) {
      return sendJson(response, 400, { error: "metadata must be a JSON object" });
    }

    if (requireExportLineage) {
      const lineageValidation = await validateExportLineageAgainstLedger(body.metadata ?? null, ledger);

      if (!lineageValidation.ok) {
        return sendJson(response, 400, { error: lineageValidation.error });
      }
    }

    const parsedComplianceLevel = parseComplianceLevel(body.complianceLevel ?? defaultComplianceLevel, { required: true });

    if (!parsedComplianceLevel.ok) {
      return sendJson(response, 400, { error: parsedComplianceLevel.error });
    }

    const complianceLevel = parsedComplianceLevel.level;
    const includeWatermark = body.includeWatermark
      ?? (proofType === PROOF_TYPES.GENERATED && complianceLevel >= 2);
    const registrationTimestamp = Number.isInteger(body.timestamp)
      ? body.timestamp
      : Math.floor(Date.now() / 1000);
    const usageEventId = complianceLevel >= 3
      ? (typeof body.usageEventId === "string" && body.usageEventId.length > 0 ? body.usageEventId : `evt_${crypto.randomUUID()}`)
      : null;

    // Session-based verification model: resolve session and inference context.
    // session_id is optional (recommended); when provided the server looks up
    // the RecordingSession to enrich the proof with actor identity.
    let resolvedSessionId = typeof body.session_id === "string" && body.session_id.length > 0
      ? body.session_id
      : null;
    let resolvedActorId = typeof body.actor_id === "string" && body.actor_id.length > 0
      ? body.actor_id
      : null;
    // InferenceMetadata captures which AI model generated the audio.
    let resolvedInferenceMetadata = null;

    if (body.inferenceMetadata != null && typeof body.inferenceMetadata === "object" && !Array.isArray(body.inferenceMetadata)) {
      resolvedInferenceMetadata = body.inferenceMetadata;
    }

    // -----------------------------------------------------------------------
    // Session-based verification model: pre-inference session gate.
    //
    // Step 1 — If requireVerifiedSession is active for GENERATED registrations,
    //   a session_id MUST be present and MUST resolve to a session that was
    //   activated via QR scan (session_verified === true).  A manually-created
    //   session is not sufficient because it carries no cryptographic proof of
    //   the actor's presence at the recording context.
    // -----------------------------------------------------------------------
    if (enforceVerifiedSession) {
      if (resolvedSessionId === null) {
        return sendJson(response, 400, {
          error: "session_required",
          message: "A verified recording session (session_id) is required before inference registration."
        });
      }
    }

    if (resolvedSessionId !== null) {
      const recordingSession = recordingSessionStore.get(resolvedSessionId);

      if (!recordingSession) {
        return sendJson(response, 400, {
          error: "recording_session_not_found",
          session_id: resolvedSessionId
        });
      }

      const sessionValidation = validateRecordingSession(recordingSession);

      if (!sessionValidation.ok) {
        return sendJson(response, 400, {
          error: "recording_session_invalid",
          reason: sessionValidation.error
        });
      }

      // Enforce verified session: the session must have been activated via QR
      // (session_verified === true), providing cryptographic binding to
      // the actor's secure enclave.  Manually-created sessions are rejected.
      if (enforceVerifiedSession && !recordingSession.session_verified) {
        return sendJson(response, 400, {
          error: "session_not_verified",
          message: "The recording session was not activated via QR scan. Only QR-verified sessions are accepted for inference registration.",
          session_id: resolvedSessionId
        });
      }

      // Use the session's actor_id if the caller didn't supply one explicitly
      if (resolvedActorId === null && recordingSession.actor_id) {
        resolvedActorId = recordingSession.actor_id;
      }
    }

    // -----------------------------------------------------------------------
    // Session-based verification model: pre-inference input gate.
    //
    // Step 2 — If requireInputVerification is active for GENERATED registrations,
    //   the source audio that was fed to the AI model MUST have been previously
    //   registered in this system as a RECORDED event.  The caller must supply
    //   inferenceMetadata.input_reference with that event's ID.
    //
    //   The server resolves the event from the ledger and:
    //     - rejects if the event does not exist
    //     - rejects if the event is not of proof_type RECORDED
    //     - sets input_verified = true on the proof when all checks pass
    //
    //   This prevents inference proofs from being created for audio that was
    //   recorded outside this system.
    // -----------------------------------------------------------------------
    if (enforceInputVerification) {
      if (!resolvedInferenceMetadata || typeof resolvedInferenceMetadata.model_id !== "string" || resolvedInferenceMetadata.model_id.length === 0) {
        return sendJson(response, 400, {
          error: "inference_metadata_required",
          message: "inferenceMetadata with model_id is required when input verification is enforced."
        });
      }

      const inputRef = resolvedInferenceMetadata.input_reference;

      if (typeof inputRef !== "string" || inputRef.length === 0) {
        return sendJson(response, 400, {
          error: "input_reference_required",
          message: "inferenceMetadata.input_reference must point to a RECORDED event in this system. Audio recorded outside this system cannot be used for inference registration."
        });
      }

      const sourceEvent = await ledger.getEvent(inputRef);

      if (!sourceEvent) {
        return sendJson(response, 400, {
          error: "input_reference_not_found",
          message: "inferenceMetadata.input_reference does not reference a known ledger event. The source audio must be registered in this system before inference.",
          input_reference: inputRef
        });
      }

      if (sourceEvent.proof_type !== PROOF_TYPES.RECORDED) {
        return sendJson(response, 400, {
          error: "input_reference_not_recorded",
          message: `The referenced source event is of type '${sourceEvent.proof_type}', but only RECORDED source audio is accepted. The input audio must have been captured and registered with this system.`,
          input_reference: inputRef,
          source_proof_type: sourceEvent.proof_type
        });
      }

      // All checks passed: mark the input as verified and carry the audio hash
      // of the source into the proof for full traceability.
      resolvedInferenceMetadata = {
        ...resolvedInferenceMetadata,
        input_verified: true,
        input_audio_hash: sourceEvent.audio_hash ?? null
      };
    }

    if (includeWatermark && complianceLevel === 1) {
      return sendJson(response, 400, { error: "Level 1 proofs MUST NOT include watermark fields." });
    }

    if (complianceLevel >= 3 && body.anchorNow !== true) {
      return sendJson(response, 400, {
        error: "Level 3 registration requires anchorNow=true to obtain a deterministic ledger anchor"
      });
    }

    if (complianceLevel >= 3 && body.timestampAttestation == null && body.timestampToken == null) {
      return sendJson(response, 400, {
        error: "timestampAttestation or timestampToken is required for Level 3 registration"
      });
    }

    if (registerRequireAuthorizedIdentitySession && requiredScope) {
      if (!isJsonObject(body.identity)) {
        return sendJson(response, 400, { error: "identity is required for authorized-session registration" });
      }

      const nowTimestamp = Math.floor(Date.now() / 1000);
      const authorizationResult = identitySessionStore.authorize(body.identity, {
        requiredScope,
        nowTimestamp
      });

      if (!authorizationResult.ok) {
        return sendJson(response, 400, { error: authorizationResult.error });
      }
    }

    if (keyData) {
      apiKeyManager.consumeQuota(keyData.orgId);
    }

    let preparedAudio = audio;
    let watermark = null;

    if (includeWatermark) {
      const stopWatermarkEmbed = perfProfiler.start("dsp.watermark.embed_ms");
      const watermarked = await watermarkEngine.embed(audio, { payload: body.watermarkPayload });
      stopWatermarkEmbed();
      preparedAudio = watermarked.audio;
      watermark = watermarked.watermark;
    }

    const stopRegisterVoice = perfProfiler.start("dsp.register_voice_ms");
    const registration = await registerVoice(preparedAudio, {
      proofType,
      complianceLevel,
      includeWatermark,
      requireIdentity: body.requireIdentity ?? false,
      identity: body.identity ?? null,
      registry: body.registry,
      metadata: body.metadata ?? {},
      timestamp: registrationTimestamp,
      nonce: body.nonce,
      usageEventId,
      timestampAttestation: null,
      verificationEndpoint: body.verificationEndpoint ?? defaultVerificationEndpoint,
      keyManager,
      // Session-based verification model: propagate resolved session context
      session_id: resolvedSessionId,
      actor_id: resolvedActorId,
      inferenceMetadata: resolvedInferenceMetadata
    });
    stopRegisterVoice();

    if (complianceLevel >= 3) {
      const attestationSource = body.timestampToken ?? body.timestampAttestation;
      const expectedDigest = getTimestampAttestationReceiptDigest(registration.proofPackage);
      const normalizedAttestation = normalizeRfc3161TimestampAttestation(attestationSource, {
        expectedDigest,
        trustedAuthorities: trustedTimestampAuthorities,
        parseRfc3161Token: rfc3161TokenParser
      });

      if (!normalizedAttestation.ok) {
        return sendJson(response, 400, {
          error: normalizedAttestation.reason
        });
      }

      const attestationVerification = timestampAttestationVerifier(normalizedAttestation.attestation, {
        proofPackage: registration.proofPackage,
        expectedDigest
      });

      if (!attestationVerification || attestationVerification.ok !== true) {
        return sendJson(response, 400, {
          error: attestationVerification?.reason ?? "timestamp attestation verification failed"
        });
      }

      registration.proofPackage.timestamp_attestation = normalizedAttestation.attestation;
    }

    const stopLedgerAppend = perfProfiler.start("ledger.append_usage_event_ms");
    const ledgerEvent = await ledger.appendUsageEvent(registration.proofPackage, {
      provider: body.provider ?? body.metadata?.provider ?? "local",
      // Session-based verification model: prefer explicit inferenceMetadata.model_id
      // for AI traceability in the ledger event, falling back to legacy fields
      model: resolvedInferenceMetadata?.model_id ?? body.model ?? body.metadata?.model_id ?? "unknown",
      anchorNow: body.anchorNow ?? false
    });
    stopLedgerAppend();
    const ledgerBatch = ledgerEvent.ledger_batch_id
      ? await ledger.getBatch(ledgerEvent.ledger_batch_id)
      : null;

    if (complianceLevel >= 3) {
      if (!ledgerEvent.event_id || !ledgerEvent.ledger_anchor) {
        return sendJson(response, 500, {
          error: "level3_ledger_anchor_missing"
        });
      }

      registration.proofPackage.usage_event_id = ledgerEvent.event_id;
      registration.proofPackage.ledger_anchor = ledgerEvent.ledger_anchor;
    }

    auditLog.info(EVENT_TYPES.VOICE_REGISTERED, "Voice registered", {
      voiceId: registration.voiceId,
      audioHash: registration.audioHash,
      proofType: registration.proofType,
      complianceLevel: registration.complianceLevel,
      metadata: body.metadata
    });

    return sendJson(response, 200, {
      ...registration,
      proof_package: registration.proofPackage,
      ledger_event: ledgerEvent,
      batch_publication: mapBatchPublication(ledgerBatch),
      watermark
    });
  }

  // Extract and validate API key from Authorization header
  function validateRequest(request) {
    const authHeader = request.headers.authorization ?? "";
    const match = authHeader.match(/^Bearer\s+(.+)$/);
    const apiKey = match ? match[1] : null;

    if (requireAuth && !apiKey) {
      return { valid: false, error: "Missing Authorization header", keyData: null, orgId: null };
    }

    if (apiKey) {
      const keyData = apiKeyManager.validateApiKey(apiKey);
      if (!keyData) {
        return { valid: false, error: "Invalid API key", keyData: null, orgId: null };
      }
      return { valid: true, keyData, orgId: keyData.orgId, error: null };
    }

    return { valid: true, keyData: null, orgId: null, error: null };
  }

  const server = http.createServer(async (request, response) => {
    try {
      const authResult = validateRequest(request);
      if (!authResult.valid) {
        return sendJson(response, 401, { error: authResult.error });
      }

      const keyData = authResult.keyData;

      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { status: "ok", service: "vri-api" });
      }

      if (request.method === "GET" && request.url === "/trust/timestamp-authorities") {
        return sendJson(response, 200, {
          trusted_timestamp_authorities: trustedTimestampAuthorities,
          count: trustedTimestampAuthorities.length,
          trust_policy: timestampTrustPolicy
        });
      }

      if (request.method === "GET" && request.url === "/trust/timestamp-policy") {
        return sendJson(response, 200, {
          trust_policy: timestampTrustPolicy
        });
      }

      if (request.method === "GET" && request.url === "/trust/timestamp-profiles") {
        return sendJson(response, 200, {
          profiles: availableTimestampTrustProfiles,
          count: availableTimestampTrustProfiles.length,
          active_profile_id: timestampTrustPolicy?.profile_id ?? null
        });
      }

      if (request.method === "POST" && request.url === "/identity/challenges") {
        const body = await readJson(request, maxRequestBytes);
        const nowTimestamp = Math.floor(Date.now() / 1000);

        if (typeof body.verifierOrigin !== "string" || body.verifierOrigin.length === 0) {
          return sendJson(response, 400, { error: "verifierOrigin is required" });
        }

        const parsedSessionScope = parseSessionScopeList(body.sessionScope);

        if (!parsedSessionScope.ok) {
          return sendJson(response, 400, { error: parsedSessionScope.error });
        }

        if (typeof body.sessionPublicKey !== "string" || body.sessionPublicKey.length === 0) {
          return sendJson(response, 400, { error: "sessionPublicKey is required" });
        }

        const challenge = identitySessionStore.issue({
          verifierOrigin: body.verifierOrigin,
          sessionScope: parsedSessionScope.scopes,
          ttlSeconds: Math.max(30, Number(body.ttlSeconds ?? identityChallengeTtlSeconds) || identityChallengeTtlSeconds),
          sessionPublicKey: body.sessionPublicKey,
          nowTimestamp
        });

        return sendJson(response, 201, {
          challenge,
          qr_payload: challenge,
          status: "PENDING"
        });
      }

      if (request.method === "POST" && request.url === "/identity/redeem") {
        const body = await readJson(request, maxRequestBytes);
        const nowTimestamp = Math.floor(Date.now() / 1000);

        if (!isJsonObject(body.identity)) {
          return sendJson(response, 400, { error: "identity is required" });
        }

        const redeemed = identitySessionStore.redeem(body.identity, {
          nowTimestamp,
          trustedVerifierOrigins,
          verifyDeviceAttestation: options.verifyDeviceAttestation
        });

        if (!redeemed.ok) {
          return sendJson(response, 400, {
            error: redeemed.error,
            details: redeemed.details ?? null
          });
        }

        return sendJson(response, 200, {
          status: redeemed.session.status,
          session_id: redeemed.session.session_id,
          redeemed_at: redeemed.session.redeemed_at,
          identity: redeemed.session.identity
        });
      }

      if (request.method === "GET" && request.url.startsWith("/identity/sessions/")) {
        const sessionId = decodeURIComponent(request.url.slice("/identity/sessions/".length));
        const session = identitySessionStore.get(sessionId);

        if (!session) {
          return sendJson(response, 404, { error: "identity_session_not_found" });
        }

        return sendJson(response, 200, session);
      }

      if (request.method === "GET" && request.url === "/ledger/status") {
        ensureSchedulerStarted();
        return sendJson(response, 200, await ledger.getStatus());
      }

      if (request.method === "GET" && request.url === "/scheduler/status") {
        ensureSchedulerStarted();
        return sendJson(response, 200, {
          status: scheduler.getStatus(),
          queue: scheduler.getQueue()
        });
      }

      if (request.method === "GET" && request.url === "/profiling/metrics") {
        if (keyData && !apiKeyManager.canPerform(keyData.role, "admin")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        return sendJson(response, 200, perfProfiler.snapshot());
      }

      if (request.method === "GET" && request.url === "/audit-log") {
        if (keyData && !apiKeyManager.canPerform(keyData.role, "admin")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        const entries = auditLog.getEntries();
        return sendJson(response, 200, {
          entries,
          count: entries.length,
          summary: auditLog.countByEventType()
        });
      }

      if (request.method === "POST" && request.url === "/api-keys/create") {
        if (!keyData || !apiKeyManager.canPerform(keyData.role, "admin")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        const body = await readJson(request, maxRequestBytes);
        const newKey = apiKeyManager.createApiKey(keyData.orgId, body.role ?? ROLES.USER);
        return sendJson(response, 201, newKey);
      }

      if (request.method === "GET" && request.url === "/api-keys") {
        if (!keyData || !apiKeyManager.canPerform(keyData.role, "admin")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        const keys = apiKeyManager.getAllKeys().filter(k => k.orgId === keyData.orgId);
        return sendJson(response, 200, { keys, count: keys.length });
      }

      if (request.method === "POST" && request.url === "/key-revocations") {
        if (!keyData || !apiKeyManager.canPerform(keyData.role, "admin")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }

        const body = await readJson(request, maxRequestBytes);

        if (typeof body.keyId !== "string" || body.keyId.length === 0) {
          return sendJson(response, 400, { error: "keyId is required" });
        }

        if (!Number.isInteger(body.effectiveAt) || body.effectiveAt < 0) {
          return sendJson(response, 400, { error: "effectiveAt must be a non-negative integer" });
        }

        const record = revocationRegistry.revoke({
          keyId: body.keyId,
          creatorId: body.creatorId ?? null,
          publicKey: body.publicKey ?? null,
          effectiveAt: body.effectiveAt,
          reason: body.reason ?? null,
          recordedAt: body.recordedAt ?? null
        });

        return sendJson(response, 201, record);
      }

      if (request.method === "GET" && request.url.startsWith("/key-revocations/")) {
        const keyId = decodeURIComponent(request.url.slice("/key-revocations/".length));
        const record = revocationRegistry.get(keyId);

        if (!record) {
          return sendJson(response, 404, { error: "key_revocation_not_found" });
        }

        return sendJson(response, 200, record);
      }

      if (request.method === "GET" && request.url === "/organizations/me") {
        if (!keyData) {
          return sendJson(response, 401, { error: "Requires API key" });
        }
        const org = apiKeyManager.getOrganization(keyData.orgId);
        return sendJson(response, 200, org);
      }

      // Session-based verification model: create and look up RecordingSession entities.
      // A RecordingSession binds audio registrations to a human actor (actor_id / wallet)
      // and an optional studio context, making every proof traceable to a real identity.

      if (request.method === "POST" && request.url === "/recording-sessions") {
        const body = await readJson(request, maxRequestBytes);

        if (typeof body.actor_id !== "string" || body.actor_id.length === 0) {
          return sendJson(response, 400, { error: "actor_id is required" });
        }

        let session;

        try {
          if (body.from_qr === true) {
            // QR-based activation: actor scanned a studio QR code.
            // session_verified will be true on the resulting session.
            session = recordingSessionStore.createFromQR(body);
          } else {
            session = recordingSessionStore.create({
              actor_id: body.actor_id,
              studio_id: body.studio_id ?? null,
              verification_method: body.verification_method ?? SESSION_VERIFICATION_METHODS.MANUAL
            });
          }
        } catch (error) {
          return sendJson(response, 400, { error: error.message });
        }

        return sendJson(response, 201, session);
      }

      if (request.method === "GET" && request.url.startsWith("/recording-sessions/")) {
        const sessionId = decodeURIComponent(request.url.slice("/recording-sessions/".length));

        if (!sessionId) {
          return sendJson(response, 400, { error: "session_id is required" });
        }

        const session = recordingSessionStore.get(sessionId);

        if (!session) {
          return sendJson(response, 404, { error: "recording_session_not_found" });
        }

        return sendJson(response, 200, session);
      }

      if (request.method === "POST" && request.url === "/register") {
        const body = await readJson(request, maxRequestBytes);
        return handleRegistration(body, response, keyData, {
          proofType: PROOF_TYPES.GENERATED,
          requiredScope: registerRequireAuthorizedIdentitySession ? SESSION_SCOPES.GENERATION : null,
          defaultComplianceLevel: 2,
          // Propagate server-level enforcement flags to GENERATED registrations
          enforceVerifiedSession: requireVerifiedSession,
          enforceInputVerification: requireInputVerification
        });
      }

      if (request.method === "POST" && request.url === "/register-recorded") {
        const body = await readJson(request, maxRequestBytes);
        return handleRegistration(body, response, keyData, {
          proofType: PROOF_TYPES.RECORDED,
          requiredScope: registerRequireAuthorizedIdentitySession ? SESSION_SCOPES.RECORDING : null,
          defaultComplianceLevel: 1
        });
      }

      if (request.method === "POST" && request.url === "/register-export") {
        const body = await readJson(request, maxRequestBytes);
        const parsedProofType = parseProofType(body.proofType, { required: true });

        if (!parsedProofType.ok) {
          return sendJson(response, 400, { error: parsedProofType.error });
        }

        const isGeneratedExport = parsedProofType.proofType === PROOF_TYPES.GENERATED;
        return handleRegistration(body, response, keyData, {
          proofType: parsedProofType.proofType,
          requiredScope: registerRequireAuthorizedIdentitySession ? SESSION_SCOPES.EXPORT : null,
          defaultComplianceLevel: isGeneratedExport ? 2 : 1,
          requireExportLineage: true,
          // GENERATED exports are subject to the same session/input enforcement as
          // direct registrations: the source audio must be system-recorded and the
          // session must be QR-verified when those server options are active.
          enforceVerifiedSession: isGeneratedExport ? requireVerifiedSession : false,
          enforceInputVerification: isGeneratedExport ? requireInputVerification : false
        });
      }

      if (request.method === "POST" && request.url === "/verify") {
        ensureSchedulerStarted();
        if (keyData && !apiKeyManager.canPerform(keyData.role, "verify")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        const body = await readJson(request, maxRequestBytes);

        if (typeof body.voiceId !== "string" || body.voiceId.length === 0) {
          return sendJson(response, 400, { error: "voiceId is required" });
        }

        return sendJson(response, 200, await verifyVoice(body.voiceId, { registry: body.registry }));
      }

      if (request.method === "POST" && request.url === "/verify-proof") {
        ensureSchedulerStarted();
        const body = await readJson(request, maxRequestBytes);
        const audio = Buffer.from(body.audioBase64 ?? "", "base64");

        if (audio.length === 0 || !body.proofPackage) {
          return sendJson(response, 400, { error: "audioBase64 and proofPackage are required" });
        }

        const parsedComplianceLevel = parseComplianceLevel(body.proofPackage?.compliance_level, {
          required: verifyProfile === "strict"
        });

        if (!parsedComplianceLevel.ok) {
          return sendJson(response, 400, {
            error: "invalid_compliance_level",
            message: parsedComplianceLevel.error
          });
        }

        const policyComplianceLevel = requiredComplianceLevel;

        if (audio.length > maxAudioBytes) {
          return sendJson(response, 413, { error: "audio_too_large", max_bytes: maxAudioBytes });
        }

        let watermarkStatus = "not_applicable";
        const proofWatermarkPayload = body.proofPackage?.watermark_hex ?? body.proofPackage?.watermark_payload;

        if (typeof proofWatermarkPayload === "string") {
          try {
            const watermarkVerification = await watermarkEngine.extract(audio, {
              payload: proofWatermarkPayload
            });

            if (watermarkVerification.recovered === true) {
              watermarkStatus = "present";
            } else if ((watermarkVerification.sync_quality ?? 0) >= 0.25) {
              watermarkStatus = "degraded";
            } else {
              watermarkStatus = "missing";
            }
          } catch {
            watermarkStatus = "degraded";
          }
        }

        const cryptographicVerification = verifyProofPackage(audio, body.proofPackage, {
          requireProtocolVersion: true,
          enforceFreshness: verifySecurity.enforceFreshness,
          maxTimestampSkewSeconds: verifySecurity.maxTimestampSkewSeconds,
          nonceTracker,
          requireIdentity: verifyRequireIdentity,
          trustedVerifierOrigins: options.trustedVerifierOrigins ?? null,
          expectedSessionPublicKey: body.expectedSessionPublicKey ?? null,
          expectedSessionId: body.expectedSessionId ?? null,
          expectedIdentityNonce: body.expectedIdentityNonce ?? null,
          verifyDeviceAttestation: options.verifyDeviceAttestation,
          getKeyRevocationStatus: ({ keyId }) => keyId ? revocationRegistry.get(keyId) : null,
          verifyTimestampAttestation: timestampAttestationVerifier,
          claimedComplianceLevel: parsedComplianceLevel.level,
          requiredComplianceLevel,
          watermarkRequiredAtOrAbove: 2,
          requireWatermarkCheck: policyComplianceLevel >= 2,
          watermarkStatus
        });
        const ledgerVerification = body.proofPackage?.compliance_level >= 3
          ? await ledger.verifyProofPackage(body.proofPackage)
          : {
            ok: true,
            reason: "LEDGER_NOT_REQUIRED"
          };

        return sendJson(response, 200, {
          ...cryptographicVerification,
          cryptographic_valid: cryptographicVerification.cryptographic_valid,
          watermark: cryptographicVerification.watermark,
          identity_valid: cryptographicVerification.identity_valid,
          metadata_consistent: cryptographicVerification.metadata_consistent,
          protocol_valid: cryptographicVerification.protocol_valid,
          trust_level: cryptographicVerification.trust_level,
          ledger: ledgerVerification,
          trust_policy: body.proofPackage?.compliance_level >= 3 ? timestampTrustPolicy : null
        });
      }

      if (request.method === "POST" && request.url === "/verify-timestamp-attestation") {
        const body = await readJson(request, maxRequestBytes);

        if (!isJsonObject(body.proofPackage)) {
          return sendJson(response, 400, { error: "proofPackage is required" });
        }

        if (!isJsonObject(body.timestampAttestation)) {
          return sendJson(response, 400, { error: "timestampAttestation is required" });
        }

        const expectedDigest = getTimestampAttestationReceiptDigest(body.proofPackage);
        const verification = timestampAttestationVerifier(body.timestampAttestation, {
          proofPackage: body.proofPackage,
          expectedDigest,
          receipt: body.proofPackage
        });

        return sendJson(response, 200, {
          ok: verification?.ok === true,
          reason: verification?.ok === true ? "VALID" : (verification?.reason ?? "timestamp attestation verification failed"),
          expected_digest: expectedDigest,
          details: verification?.details ?? null,
          trust_policy: timestampTrustPolicy
        });
      }

      if (request.method === "POST" && request.url === "/normalize-timestamp-attestation") {
        const body = await readJson(request, maxRequestBytes);

        if (!isJsonObject(body.proofPackage)) {
          return sendJson(response, 400, { error: "proofPackage is required" });
        }

        const source = body.timestampToken ?? body.timestampAttestation ?? null;

        if (source == null) {
          return sendJson(response, 400, { error: "timestampToken or timestampAttestation is required" });
        }

        const expectedDigest = getTimestampAttestationReceiptDigest(body.proofPackage);
        const normalized = normalizeRfc3161TimestampAttestation(source, {
          expectedDigest,
          trustedAuthorities: trustedTimestampAuthorities,
          parseRfc3161Token: rfc3161TokenParser
        });

        return sendJson(response, 200, {
          ok: normalized.ok === true,
          reason: normalized.ok === true ? "VALID" : normalized.reason,
          expected_digest: expectedDigest,
          timestamp_attestation: normalized.attestation ?? null,
          details: normalized.details ?? null,
          trust_policy: timestampTrustPolicy
        });
      }

      if (request.method === "GET" && request.url.startsWith("/events/")) {
        ensureSchedulerStarted();
        const eventId = decodeURIComponent(request.url.slice("/events/".length));

        if (!eventId) {
          return sendJson(response, 400, { error: "event_id is required" });
        }

        const event = await ledger.getEvent(eventId);

        if (!event) {
          return sendJson(response, 404, { error: "event_not_found" });
        }

        const eventBatch = event.ledger_batch_id
          ? await ledger.getBatch(event.ledger_batch_id)
          : null;

        return sendJson(response, 200, {
          ...event,
          batch_publication: mapBatchPublication(eventBatch)
        });
      }

      if (request.method === "GET" && request.url.startsWith("/batches/")) {
        ensureSchedulerStarted();
        const batchId = decodeURIComponent(request.url.slice("/batches/".length));

        if (!batchId) {
          return sendJson(response, 400, { error: "batch_id is required" });
        }

        const batch = await ledger.getBatch(batchId);

        if (!batch) {
          return sendJson(response, 404, { error: "batch_not_found" });
        }

        return sendJson(response, 200, batch);
      }

      if (request.method === "POST" && request.url.startsWith("/batches/") && request.url.endsWith("/publish-anchor")) {
        ensureSchedulerStarted();
        if (keyData && !apiKeyManager.canPerform(keyData.role, "publish")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        const suffix = "/publish-anchor";
        const batchId = decodeURIComponent(request.url.slice("/batches/".length, -suffix.length));

        if (!batchId) {
          return sendJson(response, 400, { error: "batch_id is required" });
        }

        const body = await readJson(request, maxRequestBytes);

        if (body.async === true) {
          const scheduled = scheduler.schedule(batchId, {
            provider: body.provider,
            network: body.network,
            endpoint: body.endpoint
          });

          return sendJson(response, 202, {
            scheduled: true,
            ...scheduled
          });
        }

        let batch;

        try {
          batch = await ledger.publishBatchAnchor(batchId, {
            provider: body.provider,
            network: body.network,
            endpoint: body.endpoint
          });
        } catch (error) {
          if (error instanceof ExternalAnchorError) {
            return sendJson(response, 400, {
              error: error.code,
              message: error.message
            });
          }

          throw error;
        }

        if (!batch) {
          return sendJson(response, 404, { error: "batch_not_found" });
        }

        return sendJson(response, 200, batch);
      }

      if (request.method === "GET" && request.url.startsWith("/proofs/")) {
        ensureSchedulerStarted();
        const eventId = decodeURIComponent(request.url.slice("/proofs/".length));

        if (!eventId) {
          return sendJson(response, 400, { error: "event_id is required" });
        }

        const proof = await ledger.getMerkleProof(eventId);

        if (!proof) {
          return sendJson(response, 404, { error: "proof_not_found" });
        }

        const proofBatch = proof.batch ?? null;

        return sendJson(response, 200, {
          ...proof,
          batch_publication: mapBatchPublication(proofBatch)
        });
      }

      return sendJson(response, 404, { error: "not_found" });
    } catch (error) {
      if (error?.code === "REQUEST_TOO_LARGE") {
        return sendJson(response, 413, { error: "request_too_large", max_bytes: maxRequestBytes });
      }

      if (error?.code === "INVALID_JSON") {
        return sendJson(response, 400, { error: "invalid_json" });
      }

      return sendJson(response, 500, {
        error: "internal_error",
        message: error.message
      });
    }
  });

  const baseClose = server.close.bind(server);
  server.close = function closeServer(...args) {
    scheduler.stop();
    return baseClose(...args);
  };

  return server;
}

export function startServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8787);
  const server = createServer(options);

  server.listen(port, () => {
    console.log(`VRI API listening on http://localhost:${port}`);
  });

  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
