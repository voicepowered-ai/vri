import http from "node:http";
import { registerVoice, verifyVoice, verifyProofPackage } from "../../core/src/index.js";
import { createKeyManager } from "../../core/src/key-manager.js";
import { createLedger, ExternalAnchorError } from "../../ledger/src/index.js";
import { createWatermarkEngine } from "../../watermark/src/index.js";

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(payload, null, 2));
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  const watermarkEngine = options.watermarkEngine ?? createWatermarkEngine();
  const ledger = options.ledger ?? createLedger({
    filePath: options.ledgerFilePath,
    batchFilePath: options.batchFilePath,
    batchSize: options.batchSize
  });
  const keyManager = options.keyManager ?? createKeyManager();
  const defaultVerificationEndpoint = options.verificationEndpoint ?? "http://localhost:8787/verify-proof";

  return http.createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        return sendJson(response, 200, { status: "ok", service: "vri-api" });
      }

      if (request.method === "GET" && request.url === "/ledger/status") {
        return sendJson(response, 200, await ledger.getStatus());
      }

      if (request.method === "POST" && request.url === "/register") {
        const body = await readJson(request);
        const audio = Buffer.from(body.audioBase64 ?? "", "base64");

        if (audio.length === 0) {
          return sendJson(response, 400, { error: "audioBase64 is required" });
        }

        if (body.metadata != null && !isJsonObject(body.metadata)) {
          return sendJson(response, 400, { error: "metadata must be a JSON object" });
        }

        const watermarked = await watermarkEngine.embed(audio, { payload: body.watermarkPayload });
        const registration = await registerVoice(watermarked.audio, {
          registry: body.registry,
          metadata: body.metadata ?? {},
          verificationEndpoint: body.verificationEndpoint ?? defaultVerificationEndpoint,
          keyManager
        });
        const ledgerEvent = await ledger.appendUsageEvent(registration.proofPackage, {
          provider: body.provider ?? body.metadata?.provider ?? "local",
          model: body.model ?? body.metadata?.model_id ?? "unknown",
          anchorNow: body.anchorNow ?? false
        });
        const ledgerBatch = ledgerEvent.ledger_batch_id
          ? await ledger.getBatch(ledgerEvent.ledger_batch_id)
          : null;
        registration.complianceLevel = ledgerEvent.ledger_anchor ? 3 : 2;
        registration.proofPackage.compliance_level = ledgerEvent.ledger_anchor ? 3 : 2;
        registration.proofPackage.usage_event_id = ledgerEvent.event_id;
        registration.proofPackage.ledger_anchor = ledgerEvent.ledger_anchor;

        return sendJson(response, 200, {
          ...registration,
          proof_package: registration.proofPackage,
          ledger_event: ledgerEvent,
          batch_publication: mapBatchPublication(ledgerBatch),
          watermark: watermarked.watermark
        });
      }

      if (request.method === "POST" && request.url === "/verify") {
        const body = await readJson(request);

        if (typeof body.voiceId !== "string" || body.voiceId.length === 0) {
          return sendJson(response, 400, { error: "voiceId is required" });
        }

        return sendJson(response, 200, await verifyVoice(body.voiceId, { registry: body.registry }));
      }

      if (request.method === "POST" && request.url === "/verify-proof") {
        const body = await readJson(request);
        const audio = Buffer.from(body.audioBase64 ?? "", "base64");

        if (audio.length === 0 || !body.proofPackage) {
          return sendJson(response, 400, { error: "audioBase64 and proofPackage are required" });
        }

        const cryptographicVerification = verifyProofPackage(audio, body.proofPackage);
        const ledgerVerification = await ledger.verifyProofPackage(body.proofPackage);

        return sendJson(response, 200, {
          ...cryptographicVerification,
          ledger: ledgerVerification
        });
      }

      if (request.method === "GET" && request.url.startsWith("/events/")) {
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
        const suffix = "/publish-anchor";
        const batchId = decodeURIComponent(request.url.slice("/batches/".length, -suffix.length));

        if (!batchId) {
          return sendJson(response, 400, { error: "batch_id is required" });
        }

        const body = await readJson(request);
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
      return sendJson(response, 500, {
        error: "internal_error",
        message: error.message
      });
    }
  });
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
