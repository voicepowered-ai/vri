import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { createKeyManager } from "../../core/src/key-manager.js";
import { sha256Hex } from "../../core/src/index.js";

async function startTestServer(overrides = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-ledger-test-"));
  const server = createServer({
    verificationEndpoint: "http://127.0.0.1/test/verify-proof",
    ledgerFilePath: path.join(tempDir, "events.jsonl"),
    batchFilePath: path.join(tempDir, "batches.jsonl"),
    batchSize: 2,
    ...overrides
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`
  };
}

async function startAnchorProviderServer() {
  const server = createHttpServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/publish") {
      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const chunks = [];

    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const seed = `${body.batchId}:${body.rootHash}:${body.batchAnchor}`;
      const anchorId = `anchor_${sha256Hex(Buffer.from(seed, "utf8")).slice(0, 20)}`;
      const tx = `0x${sha256Hex(Buffer.from(`tx:${seed}`, "utf8"))}`;

      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        provider: body.provider,
        network: body.network,
        anchorId,
        transactionHash: tx,
        confirmed: true,
        publishedAt: Math.floor(Date.now() / 1000)
      }));
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  return {
    server,
    endpoint: `http://127.0.0.1:${address.port}/publish`
  };
}

test("GET /health responds with ok", async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/health`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, "ok");
    assert.equal(payload.service, "vri-api");
  } finally {
    server.close();
  }
});

test("GET /profiling/metrics returns profiler snapshot", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_perf_metrics",
          tenant_id: "org_api"
        }
      })
    });

    const metricsResponse = await fetch(`${baseUrl}/profiling/metrics`);
    const metrics = await metricsResponse.json();

    assert.equal(metricsResponse.status, 200);
    assert.equal(typeof metrics.metricCount, "number");
    assert.equal(typeof metrics.metrics, "object");
    assert.ok(metrics.metrics["dsp.watermark.embed_ms"]);
    assert.ok(metrics.metrics["dsp.register_voice_ms"]);
    assert.ok(metrics.metrics["ledger.append_usage_event_ms"]);
  } finally {
    server.close();
  }
});

test("POST /register emits a proof package", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_test",
          tenant_id: "org_api"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.status, "registered");
    assert.equal(payload.complianceLevel, 3);
    assert.equal(payload.proof_package.protocol_version, "1.0");
    assert.equal(payload.proof_package.compliance_level, 3);
    assert.equal(payload.proof_package.signature.algorithm, "Ed25519");
    assert.equal(typeof payload.proof_package.usage_event_id, "string");
    assert.equal(typeof payload.proof_package.ledger_anchor, "string");
    assert.equal(payload.proof_package.verification_endpoint, "http://127.0.0.1/test/verify-proof");
    assert.equal(typeof payload.batch_publication, "object");
    assert.equal(payload.batch_publication.published, false);
    assert.equal(payload.batch_publication.confirmed, false);
  } finally {
    server.close();
  }
});

test("POST /verify-proof validates a freshly registered proof", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_verify",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();

    const verifyResponse = await fetch(`${baseUrl}/verify-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofPackage: registration.proof_package
      })
    });
    const verification = await verifyResponse.json();

    assert.equal(verifyResponse.status, 200);
    assert.equal(verification.ok, true);
    assert.equal(verification.reason, "VALID");
    assert.equal(verification.details.mode, "v1.0");
    assert.equal(verification.ledger.ok, true);
    assert.equal(verification.ledger.reason, "LEDGER_CONFIRMED");
  } finally {
    server.close();
  }
});

test("GET /events/:id returns the recorded usage event", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_event",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const eventId = registration.proof_package.usage_event_id;
    const eventResponse = await fetch(`${baseUrl}/events/${encodeURIComponent(eventId)}`);
    const event = await eventResponse.json();

    assert.equal(eventResponse.status, 200);
    assert.equal(event.event_id, eventId);
    assert.equal(event.audio_hash, registration.proof_package.audio_hash);
    assert.equal(event.ledger_anchor, registration.proof_package.ledger_anchor);
    assert.equal(typeof event.batch_publication, "object");
    assert.equal(event.batch_publication.published, false);
    assert.equal(event.batch_publication.confirmed, false);
  } finally {
    server.close();
  }
});

test("GET /proofs/:id returns a verified Merkle inclusion proof", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_proof",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const eventId = registration.proof_package.usage_event_id;
    const proofResponse = await fetch(`${baseUrl}/proofs/${encodeURIComponent(eventId)}`);
    const proof = await proofResponse.json();

    assert.equal(proofResponse.status, 200);
    assert.equal(proof.event.event_id, eventId);
    assert.equal(proof.root_hash, registration.proof_package.ledger_anchor);
    assert.equal(proof.verified, true);
    assert.ok(Array.isArray(proof.proof));
    assert.equal(typeof proof.batch_publication, "object");
    assert.equal(proof.batch_publication.published, false);
    assert.equal(proof.batch_publication.confirmed, false);
  } finally {
    server.close();
  }
});

test("GET /batches/:id returns the recorded batch", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_batch",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const batchId = registration.ledger_event.ledger_batch_id;
    const batchResponse = await fetch(`${baseUrl}/batches/${encodeURIComponent(batchId)}`);
    const batch = await batchResponse.json();

    assert.equal(batchResponse.status, 200);
    assert.equal(batch.batch_id, batchId);
    assert.equal(batch.root_hash, registration.proof_package.ledger_anchor);
    assert.ok(Array.isArray(batch.event_ids));
    assert.ok(batch.event_ids.includes(registration.proof_package.usage_event_id));
  } finally {
    server.close();
  }
});

test("POST /batches/:id/publish-anchor marks the batch as externally anchored", async () => {
  const { server, baseUrl } = await startTestServer();
  const external = await startAnchorProviderServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_publish_anchor",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const batchId = registration.ledger_event.ledger_batch_id;

    const publishResponse = await fetch(`${baseUrl}/batches/${encodeURIComponent(batchId)}/publish-anchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: "external-http",
        network: "sepolia",
        endpoint: external.endpoint
      })
    });
    const publishedBatch = await publishResponse.json();

    assert.equal(publishResponse.status, 200);
    assert.equal(publishedBatch.batch_id, batchId);
    assert.equal(publishedBatch.blockchain_chain, "sepolia");
    assert.equal(publishedBatch.blockchain_confirmed, true);
    assert.equal(typeof publishedBatch.external_anchor_id, "string");
    assert.equal(typeof publishedBatch.blockchain_tx, "string");

    const eventResponse = await fetch(`${baseUrl}/events/${encodeURIComponent(registration.proof_package.usage_event_id)}`);
    const eventPayload = await eventResponse.json();
    assert.equal(eventResponse.status, 200);
    assert.equal(eventPayload.batch_publication.published, true);
    assert.equal(eventPayload.batch_publication.confirmed, true);
    assert.equal(eventPayload.batch_publication.provider, "external-http");
    assert.equal(eventPayload.batch_publication.network, "sepolia");
  } finally {
    external.server.close();
    server.close();
  }
});

test("POST /batches/:id/publish-anchor rejects missing external endpoint", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_publish_anchor_missing_endpoint",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const batchId = registration.ledger_event.ledger_batch_id;

    const publishResponse = await fetch(`${baseUrl}/batches/${encodeURIComponent(batchId)}/publish-anchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        provider: "external-http",
        network: "sepolia"
      })
    });
    const errorBody = await publishResponse.json();

    assert.equal(publishResponse.status, 400);
    assert.equal(errorBody.error, "EXTERNAL_ANCHOR_ENDPOINT_REQUIRED");
  } finally {
    server.close();
  }
});

test("POST /batches/:id/publish-anchor supports async scheduling", async () => {
  const { server, baseUrl } = await startTestServer({
    schedulerConfig: {
      initialDelayMs: 10,
      maxDelayMs: 20,
      jitterFactor: 0,
      maxRetries: 2
    }
  });
  const external = await startAnchorProviderServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_publish_anchor_async",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    const batchId = registration.ledger_event.ledger_batch_id;

    const scheduleResponse = await fetch(`${baseUrl}/batches/${encodeURIComponent(batchId)}/publish-anchor`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        async: true,
        provider: "external-http",
        network: "sepolia",
        endpoint: external.endpoint
      })
    });
    const scheduled = await scheduleResponse.json();

    assert.equal(scheduleResponse.status, 202);
    assert.equal(scheduled.scheduled, true);
    assert.equal(scheduled.state, "pending");

    let publishedBatch = null;
    const deadline = Date.now() + 4000;

    while (Date.now() < deadline) {
      const batchResponse = await fetch(`${baseUrl}/batches/${encodeURIComponent(batchId)}`);
      const batch = await batchResponse.json();
      if (batch.external_anchor_id) {
        publishedBatch = batch;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.ok(publishedBatch);
    assert.equal(publishedBatch.external_anchor_provider, "external-http");
    assert.equal(publishedBatch.blockchain_chain, "sepolia");
  } finally {
    external.server.close();
    server.close();
  }
});

test("GET /scheduler/status returns queue metrics", async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/scheduler/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(typeof payload.status, "object");
    assert.equal(typeof payload.status.total, "number");
    assert.ok(Array.isArray(payload.queue));
  } finally {
    server.close();
  }
});

test("GET /ledger/status returns batch and pending counts", async () => {
  const { server, baseUrl } = await startTestServer();
  const audio = await readFile("examples/test/audio.wav");

  try {
    await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis",
          request_id: "req_api_status",
          tenant_id: "org_api"
        }
      })
    });

    const response = await fetch(`${baseUrl}/ledger/status`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.event_count, 1);
    assert.equal(payload.batch_count, 1);
    assert.equal(payload.pending_event_count, 0);
    assert.equal(typeof payload.latest_batch_root, "string");
  } finally {
    server.close();
  }
});

test("POST /verify rejects missing voiceId", async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const response = await fetch(`${baseUrl}/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({})
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "voiceId is required");
  } finally {
    server.close();
  }
});

test("persistent keyManager produces the same public_key across registrations", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-ledger-km-test-"));
  const keyManager = createKeyManager();
  const server = createServer({
    verificationEndpoint: "http://127.0.0.1/test/verify-proof",
    ledgerFilePath: path.join(tempDir, "events.jsonl"),
    batchFilePath: path.join(tempDir, "batches.jsonl"),
    batchSize: 10,
    keyManager
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audio = await readFile("examples/test/audio.wav");
  const body = JSON.stringify({
    audioBase64: audio.toString("base64"),
    metadata: { model_id: "tts-v3", operation: "voice_synthesis" }
  });

  try {
    const [res1, res2] = await Promise.all([
      fetch(`${baseUrl}/register`, { method: "POST", headers: { "content-type": "application/json" }, body }),
      fetch(`${baseUrl}/register`, { method: "POST", headers: { "content-type": "application/json" }, body })
    ]);

    const [reg1, reg2] = await Promise.all([res1.json(), res2.json()]);

    assert.equal(res1.status, 200);
    assert.equal(res2.status, 200);
    assert.equal(reg1.proof_package.public_key, reg2.proof_package.public_key);
    assert.equal(reg1.proof_package.key_id, reg2.proof_package.key_id);
    assert.equal(reg1.proof_package.key_id, keyManager.getKeyId());
  } finally {
    server.close();
  }
});
