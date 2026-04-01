import http from "node:http";
import {
  registerVoice,
  verifyVoice,
  verifyProofPackage,
  createNonceReplayTracker
} from "../../core/src/index.js";
import { createKeyManager } from "../../core/src/key-manager.js";
import { createAuditLog, EVENT_TYPES } from "../../core/src/audit-log.js";
import { createLedger, ExternalAnchorError } from "../../ledger/src/index.js";
import { createWatermarkEngine } from "../../watermark/src/index.js";
import { createApiKeyManager, ROLES } from "../../core/src/api-key-manager.js";
import { createPerfProfiler } from "../../core/src/perf-profiler.js";
import { createBatchScheduler } from "../../ledger/src/scheduler.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
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
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Invalid JSON payload");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function isJsonObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function createServer(options = {}) {
  const maxRequestBytes = Math.max(1024, Number(options.maxRequestBytes ?? 8 * 1024 * 1024));
  const maxAudioBytes = Math.max(1024, Number(options.maxAudioBytes ?? 8 * 1024 * 1024));
  const verifySecurity = {
    enforceFreshness: options.verifyEnforceFreshness ?? true,
    maxTimestampSkewSeconds: Number(options.verifyMaxTimestampSkewSeconds ?? 24 * 60 * 60),
    trackNonce: options.verifyTrackNonce ?? false
  };
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
    ?? (verifySecurity.trackNonce ? createNonceReplayTracker() : null);
  const schedulerConcurrency = Math.max(1, Number(options.schedulerConcurrency ?? 1) || 1);
  const schedulerAutoStart = options.schedulerAutoStart ?? true;
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

      if (request.method === "GET" && request.url === "/organizations/me") {
        if (!keyData) {
          return sendJson(response, 401, { error: "Requires API key" });
        }
        const org = apiKeyManager.getOrganization(keyData.orgId);
        return sendJson(response, 200, org);
      }

      if (request.method === "POST" && request.url === "/register") {
        ensureSchedulerStarted();
        if (keyData && !apiKeyManager.canPerform(keyData.role, "register")) {
          return sendJson(response, 403, { error: "Insufficient permissions" });
        }
        if (keyData && !apiKeyManager.checkQuota(keyData.orgId).allowed) {
          return sendJson(response, 429, { error: "Quota exceeded", retryAfter: 3600 });
        }
        const body = await readJson(request, maxRequestBytes);
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

        if (keyData) {
          apiKeyManager.consumeQuota(keyData.orgId);
        }

        const stopWatermarkEmbed = perfProfiler.start("dsp.watermark.embed_ms");
        const watermarked = await watermarkEngine.embed(audio, { payload: body.watermarkPayload });
        stopWatermarkEmbed();

        const stopRegisterVoice = perfProfiler.start("dsp.register_voice_ms");
        const registration = await registerVoice(watermarked.audio, {
          registry: body.registry,
          metadata: body.metadata ?? {},
          verificationEndpoint: body.verificationEndpoint ?? defaultVerificationEndpoint,
          keyManager
        });
        stopRegisterVoice();

        const stopLedgerAppend = perfProfiler.start("ledger.append_usage_event_ms");
        const ledgerEvent = await ledger.appendUsageEvent(registration.proofPackage, {
          provider: body.provider ?? body.metadata?.provider ?? "local",
          model: body.model ?? body.metadata?.model_id ?? "unknown",
          anchorNow: body.anchorNow ?? false
        });
        stopLedgerAppend();
        const ledgerBatch = ledgerEvent.ledger_batch_id
          ? await ledger.getBatch(ledgerEvent.ledger_batch_id)
          : null;
        registration.complianceLevel = ledgerEvent.ledger_anchor ? 3 : 2;
        registration.proofPackage.compliance_level = ledgerEvent.ledger_anchor ? 3 : 2;
        registration.proofPackage.usage_event_id = ledgerEvent.event_id;
        registration.proofPackage.ledger_anchor = ledgerEvent.ledger_anchor;

        auditLog.info(EVENT_TYPES.VOICE_REGISTERED, "Voice registered", {
          voiceId: registration.voiceId,
          audioHash: registration.audioHash,
          complianceLevel: registration.complianceLevel,
          metadata: body.metadata
        });

        return sendJson(response, 200, {
          ...registration,
          proof_package: registration.proofPackage,
          ledger_event: ledgerEvent,
          batch_publication: mapBatchPublication(ledgerBatch),
          watermark: watermarked.watermark
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
          watermarkStatus
        });
        const ledgerVerification = await ledger.verifyProofPackage(body.proofPackage);

        const trustLevel = cryptographicVerification.cryptographic_valid
          ? (watermarkStatus === "present" ? "HIGH" : "PARTIAL")
          : "LOW";

        return sendJson(response, 200, {
          ...cryptographicVerification,
          cryptographic_valid: cryptographicVerification.cryptographic_valid,
          watermark: watermarkStatus,
          identity_valid: cryptographicVerification.identity_valid,
          metadata_consistent: cryptographicVerification.metadata_consistent,
          protocol_valid: cryptographicVerification.protocol_valid,
          trust_level: trustLevel,
          ledger: ledgerVerification
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
