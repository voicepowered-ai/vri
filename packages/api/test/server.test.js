import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createServer } from "../src/server.js";
import { createKeyManager } from "../../core/src/key-manager.js";
import { createApiKeyManager, ROLES } from "../../core/src/api-key-manager.js";
import {
  createIdentityAssertion,
  registerVoice,
  getTimestampAttestationReceiptDigest,
  sha256Hex
} from "../../core/src/index.js";

async function startTestServer(overrides = {}) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-ledger-test-"));
  const server = createServer({
    verificationEndpoint: "http://127.0.0.1/test/verify-proof",
    ledgerFilePath: path.join(tempDir, "events.jsonl"),
    batchFilePath: path.join(tempDir, "batches.jsonl"),
    batchSize: 2,
    externalAnchorAllowLocalhost: true,
    externalAnchorAllowPrivateNetworks: true,
    externalAnchorAllowInsecureHttp: true,
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

test("OPTIONS preflight returns CORS headers for allowed recorder origins", async () => {
  const { server, baseUrl } = await startTestServer({
    corsAllowedOrigins: ["http://localhost:5173"]
  });

  try {
    const response = await fetch(`${baseUrl}/identity/challenges`, {
      method: "OPTIONS",
      headers: {
        origin: "http://localhost:5173",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type"
      }
    });

    assert.equal(response.status, 204);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:5173");
    assert.match(response.headers.get("access-control-allow-methods") ?? "", /POST/);
    assert.match(response.headers.get("access-control-allow-headers") ?? "", /Content-Type/i);
  } finally {
    server.close();
  }
});

test("POST /identity/challenges issues a pending QR challenge", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });

  try {
    const response = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["recording"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 201);
    assert.equal(payload.status, "PENDING");
    assert.equal(payload.challenge.auth_method, "QR_SECURE_ENCLAVE");
    assert.equal(payload.challenge.verifier_origin, "https://studio.vri.example");
    assert.equal(payload.challenge.session_public_key, "0xsessionpub");
  } finally {
    server.close();
  }
});

test("POST /identity/challenges rejects unsupported session scopes", async () => {
  const { server, baseUrl } = await startTestServer();

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["admin"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const payload = await challengeResponse.json();

    assert.equal(challengeResponse.status, 400);
    assert.match(payload.error, /sessionScope contains an unsupported value/);
  } finally {
    server.close();
  }
});

test("POST /identity/redeem authorizes a signed identity session and rejects replay", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["generation"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    const redeemed = await redeemResponse.json();

    assert.equal(redeemResponse.status, 200);
    assert.equal(redeemed.status, "AUTHORIZED");
    assert.equal(redeemed.session_id, challengePayload.challenge.session_id);

    const replayResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    const replay = await replayResponse.json();

    assert.equal(replayResponse.status, 400);
    assert.equal(replay.error, "identity_session_not_pending");
  } finally {
    server.close();
  }
});

test("GET /identity/sessions/:id returns session state", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["export"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();

    const sessionResponse = await fetch(
      `${baseUrl}/identity/sessions/${encodeURIComponent(challengePayload.challenge.session_id)}`
    );
    const session = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(session.status, "PENDING");
    assert.equal(session.session_id, challengePayload.challenge.session_id);
  } finally {
    server.close();
  }
});

test("POST /identity/sessions/:id/cancel cancels an authorized session", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"]
  });

  try {
    const devicePrivateKeyPem = crypto.generateKeyPairSync("ed25519").privateKey.export({
      type: "pkcs8",
      format: "pem"
    });

    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["recording"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();

    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: devicePrivateKeyPem,
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const cancelResponse = await fetch(
      `${baseUrl}/identity/sessions/${encodeURIComponent(challengePayload.challenge.session_id)}/cancel`,
      { method: "POST" }
    );
    const cancelPayload = await cancelResponse.json();

    assert.equal(cancelResponse.status, 200);
    assert.equal(cancelPayload.status, "CANCELED");
  } finally {
    server.close();
  }
});

test("identity sessions persist across server restarts when identitySessionStoreFilePath is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-identity-state-"));
  const identitySessionStoreFilePath = path.join(tempDir, "identity-sessions.json");
  const overrides = {
    trustedVerifierOrigins: ["https://studio.vri.example"],
    identitySessionStoreFilePath
  };

  const first = await startTestServer(overrides);
  let sessionId;

  try {
    const challengeResponse = await fetch(`${first.baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["generation"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    sessionId = challengePayload.challenge.session_id;
    assert.equal(challengeResponse.status, 201);
  } finally {
    first.server.close();
  }

  const second = await startTestServer(overrides);

  try {
    const sessionResponse = await fetch(`${second.baseUrl}/identity/sessions/${encodeURIComponent(sessionId)}`);
    const sessionPayload = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionPayload.session_id, sessionId);
    assert.equal(sessionPayload.status, "PENDING");
  } finally {
    second.server.close();
  }
});

test("POST /register can require a redeemed authorized identity session", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["generation"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await registerResponse.json();

    assert.equal(registerResponse.status, 200);
    assert.equal(payload.proof_package.identity.session_id, identity.session_id);

    const sessionResponse = await fetch(
      `${baseUrl}/identity/sessions/${encodeURIComponent(challengePayload.challenge.session_id)}`
    );
    const sessionPayload = await sessionResponse.json();

    assert.equal(sessionResponse.status, 200);
    assert.equal(sessionPayload.status, "CONSUMED");
  } finally {
    server.close();
  }
});

test("POST /register rejects replay of a consumed authorized identity session", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["generation"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const firstRegisterResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    assert.equal(firstRegisterResponse.status, 200);

    const secondRegisterResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const secondPayload = await secondRegisterResponse.json();

    assert.equal(secondRegisterResponse.status, 400);
    assert.equal(secondPayload.error, "identity_session_consumed");
  } finally {
    server.close();
  }
});

test("POST /register rejects non-authorized identity sessions in strict session mode", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["generation"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await registerResponse.json();

    assert.equal(registerResponse.status, 400);
    assert.equal(payload.error, "identity_session_not_authorized");
  } finally {
    server.close();
  }
});

test("POST /register rejects authorized identity sessions with the wrong scope", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["export"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await registerResponse.json();

    assert.equal(registerResponse.status, 400);
    assert.equal(payload.error, "identity_session_scope_invalid");
  } finally {
    server.close();
  }
});

test("POST /register-recorded emits a RECORDED proof and consumes a recording session", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["recording"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const registerResponse = await fetch(`${baseUrl}/register-recorded`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity,
        metadata: {
          source: "studio_capture",
          operation: "recording"
        }
      })
    });
    const payload = await registerResponse.json();

    assert.equal(registerResponse.status, 200);
    assert.equal(payload.proofType, "RECORDED");
    assert.equal(payload.complianceLevel, 1);
    assert.equal(payload.proof_package.proof_type, "RECORDED");
    assert.equal(payload.proof_package.watermark_payload, undefined);

    const sessionResponse = await fetch(
      `${baseUrl}/identity/sessions/${encodeURIComponent(challengePayload.challenge.session_id)}`
    );
    const sessionPayload = await sessionResponse.json();
    assert.equal(sessionPayload.status, "CONSUMED");
  } finally {
    server.close();
  }
});

test("POST /register-export requires export scope and explicit proof type", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const missingProofTypeResponse = await fetch(`${baseUrl}/register-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64")
      })
    });
    const missingProofTypePayload = await missingProofTypeResponse.json();
    assert.equal(missingProofTypeResponse.status, 400);
    assert.equal(missingProofTypePayload.error, "proofType is required");

    const parentChallengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["recording"],
        sessionPublicKey: "0xparentsessionpub"
      })
    });
    const parentChallengePayload = await parentChallengeResponse.json();
    const parentIdentity = createIdentityAssertion(parentChallengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const parentRedeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: parentIdentity })
    });
    assert.equal(parentRedeemResponse.status, 200);

    const parentRegisterResponse = await fetch(`${baseUrl}/register-recorded`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity: parentIdentity,
        metadata: {
          source: "studio_capture",
          operation: "recording"
        }
      })
    });
    const parentPayload = await parentRegisterResponse.json();
    assert.equal(parentRegisterResponse.status, 200);

    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["export"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const exportResponse = await fetch(`${baseUrl}/register-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofType: "RECORDED",
        identity,
        metadata: {
          operation: "export",
          lineage: {
            parent_audio_hash: parentPayload.proof_package.audio_hash,
            source_proof_type: parentPayload.proof_package.proof_type,
            source_event_id: parentPayload.ledger_event.event_id
          }
        }
      })
    });
    const payload = await exportResponse.json();

    assert.equal(exportResponse.status, 200);
    assert.equal(payload.proofType, "RECORDED");
    assert.equal(payload.proof_package.proof_type, "RECORDED");
  } finally {
    server.close();
  }
});

test("POST /register-export rejects lineage mismatches against the referenced ledger event", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const parentChallengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["recording"],
        sessionPublicKey: "0xparentsessionpub"
      })
    });
    const parentChallengePayload = await parentChallengeResponse.json();
    const parentIdentity = createIdentityAssertion(parentChallengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const parentRedeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: parentIdentity })
    });
    assert.equal(parentRedeemResponse.status, 200);

    const parentRegisterResponse = await fetch(`${baseUrl}/register-recorded`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        identity: parentIdentity,
        metadata: {
          source: "studio_capture",
          operation: "recording"
        }
      })
    });
    const parentPayload = await parentRegisterResponse.json();
    assert.equal(parentRegisterResponse.status, 200);

    const exportChallengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["export"],
        sessionPublicKey: "0xexportsessionpub"
      })
    });
    const exportChallengePayload = await exportChallengeResponse.json();
    const exportIdentity = createIdentityAssertion(exportChallengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const exportRedeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity: exportIdentity })
    });
    assert.equal(exportRedeemResponse.status, 200);

    const exportResponse = await fetch(`${baseUrl}/register-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofType: "RECORDED",
        identity: exportIdentity,
        metadata: {
          operation: "export",
          lineage: {
            parent_audio_hash: "0x1111111111111111111111111111111111111111111111111111111111111111",
            source_proof_type: parentPayload.proof_package.proof_type,
            source_event_id: parentPayload.ledger_event.event_id
          }
        }
      })
    });
    const payload = await exportResponse.json();

    assert.equal(exportResponse.status, 400);
    assert.equal(payload.error, "metadata.lineage.parent_audio_hash does not match the referenced ledger event");
  } finally {
    server.close();
  }
});

test("POST /register-export rejects missing export lineage metadata", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedVerifierOrigins: ["https://studio.vri.example"],
    registerRequireAuthorizedIdentitySession: true
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const challengeResponse = await fetch(`${baseUrl}/identity/challenges`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        verifierOrigin: "https://studio.vri.example",
        sessionScope: ["export"],
        sessionPublicKey: "0xsessionpub"
      })
    });
    const challengePayload = await challengeResponse.json();
    const identity = createIdentityAssertion(challengePayload.challenge, {
      privateKeyPem: crypto.generateKeyPairSync("ed25519").privateKey.export({
        format: "pem",
        type: "pkcs8"
      }),
      sessionTimestamp: Math.floor(Date.now() / 1000)
    });

    const redeemResponse = await fetch(`${baseUrl}/identity/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identity })
    });
    assert.equal(redeemResponse.status, 200);

    const exportResponse = await fetch(`${baseUrl}/register-export`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofType: "RECORDED",
        identity,
        metadata: {
          operation: "export"
        }
      })
    });
    const payload = await exportResponse.json();

    assert.equal(exportResponse.status, 400);
    assert.equal(payload.error, "metadata.lineage is required for export registration");
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
    assert.equal(payload.proofType, "GENERATED");
    assert.equal(payload.complianceLevel, 2);
    assert.equal(payload.proof_package.protocol_version, "2.0");
    assert.equal(payload.proof_package.proof_type, "GENERATED");
    assert.equal(payload.proof_package.compliance_level, 2);
    assert.equal(payload.proof_package.signature.algorithm, "Ed25519");
    assert.equal(typeof payload.proof_package.watermark_payload, "string");
    assert.equal(payload.proof_package.usage_event_id, undefined);
    assert.equal(payload.proof_package.ledger_anchor, undefined);
    assert.equal(typeof payload.ledger_event.event_id, "string");
    assert.equal(payload.proof_package.verification_endpoint, "http://127.0.0.1/test/verify-proof");
    assert.equal(typeof payload.batch_publication, "object");
    assert.equal(payload.batch_publication.published, false);
    assert.equal(payload.batch_publication.confirmed, false);
  } finally {
    server.close();
  }
});

test("POST /register can emit a Level 3 proof when timestamp attestation and ledger anchor are present", async () => {
  const keyManager = createKeyManager();
  const { server, baseUrl } = await startTestServer({
    keyManager,
    trustedTimestampAuthorities: ["tsa.vri.example"],
    verifyEnforceFreshness: false
  });
  const audio = await readFile("examples/test/audio.wav");
  const timestamp = Math.floor(Date.now() / 1000);
  const usageEventId = `evt_level3_${crypto.randomUUID()}`;

  try {
    const preflightProof = await registerVoice(audio, {
      keyManager,
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId,
      timestamp,
      timestampAttestation: {
        type: "RFC3161",
        tsa: "tsa.vri.example",
        policy_oid: "1.2.3.4.5",
        serial_number: "0x1234",
        message_imprint_alg: "sha256",
        attested_at: timestamp + 10,
        gen_time: timestamp + 10,
        token: "base64(tsr)",
        digest: "0xplaceholder"
      },
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    const normalizedAttestation = {
      ...preflightProof.proofPackage.timestamp_attestation,
      message_imprint: getTimestampAttestationReceiptDigest(preflightProof.proofPackage),
      digest: getTimestampAttestationReceiptDigest(preflightProof.proofPackage)
    };

    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        complianceLevel: 3,
        usageEventId,
        timestamp,
        anchorNow: true,
        timestampAttestation: normalizedAttestation,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.complianceLevel, 3);
    assert.equal(payload.proof_package.compliance_level, 3);
    assert.equal(payload.proof_package.usage_event_id, usageEventId);
    assert.equal(typeof payload.proof_package.ledger_anchor, "string");
    assert.equal(payload.proof_package.timestamp_attestation.tsa, "tsa.vri.example");
    assert.equal(payload.ledger_event.proof_type, "GENERATED");
    assert.equal(payload.ledger_event.compliance_level, 3);
    assert.equal(payload.ledger_event.timestamp_attestation_digest, payload.proof_package.timestamp_attestation.digest);
  } finally {
    server.close();
  }
});

test("POST /register rejects Level 3 emission without anchorNow", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedTimestampAuthorities: ["tsa.vri.example"],
    verifyEnforceFreshness: false
  });
  const audio = await readFile("examples/test/audio.wav");
  const timestamp = Math.floor(Date.now() / 1000);
  const usageEventId = `evt_level3_${crypto.randomUUID()}`;

  try {
    const preflightProof = await registerVoice(audio, {
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId,
      timestamp,
      timestampAttestation: {
        type: "RFC3161",
        tsa: "tsa.vri.example",
        policy_oid: "1.2.3.4.5",
        serial_number: "0x1234",
        message_imprint_alg: "sha256",
        attested_at: timestamp + 10,
        gen_time: timestamp + 10,
        token: "base64(tsr)",
        digest: "0xplaceholder"
      },
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    const normalizedAttestation = {
      ...preflightProof.proofPackage.timestamp_attestation,
      message_imprint: getTimestampAttestationReceiptDigest(preflightProof.proofPackage),
      digest: getTimestampAttestationReceiptDigest(preflightProof.proofPackage)
    };

    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        complianceLevel: 3,
        usageEventId,
        timestamp,
        timestampAttestation: normalizedAttestation,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "Level 3 registration requires anchorNow=true to obtain a deterministic ledger anchor");
  } finally {
    server.close();
  }
});

test("POST /register rejects Level 3 emission without timestamp attestation input", async () => {
  const { server, baseUrl } = await startTestServer({
    verifyEnforceFreshness: false
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        complianceLevel: 3,
        anchorNow: true,
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 400);
    assert.equal(payload.error, "timestampAttestation or timestampToken is required for Level 3 registration");
  } finally {
    server.close();
  }
});

test("POST /register can emit a Level 3 proof from a raw timestampToken via openssl adapter", async () => {
  let expectedDigest = null;
  const keyManager = createKeyManager();
  const { server, baseUrl } = await startTestServer({
    keyManager,
    verifyEnforceFreshness: false,
    trustedTimestampAuthorities: [
      {
        tsa: "tsa.vri.example",
        policy_oids: ["1.2.3.4.5"]
      }
    ],
    openSslTimestampOptions: {
      caFile: "/tmp/test-ca.pem",
      execFileSync: (_binary, args) => {
        if (args.includes("-reply")) {
          const hexPairs = expectedDigest
            .slice(2)
            .match(/.{1,2}/g)
            .join(" ");
          return `
Status info:
Status: Granted.
TST info:
Policy OID: 1.2.3.4.5
Hash Algorithm: sha256
Message data:
    0000 - ${hexPairs.slice(0, 47)}-${hexPairs.slice(48, 95)}
    0010 - ${hexPairs.slice(96, 143)}-${hexPairs.slice(144)}
Serial number: 0x1234
Time stamp: Apr  1 12:00:10 2026 GMT
TSA: DirName:/CN=tsa.vri.example
`;
        }

        return "";
      }
    }
  });
  const audio = await readFile("examples/test/audio.wav");
  const timestamp = 1775044800;
  const usageEventId = `evt_level3_raw_${crypto.randomUUID()}`;

  try {
    const preflightProof = await registerVoice(audio, {
      keyManager,
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId,
      timestamp,
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    expectedDigest = getTimestampAttestationReceiptDigest(preflightProof.proofPackage);

    const response = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        complianceLevel: 3,
        usageEventId,
        timestamp,
        anchorNow: true,
        timestampToken: {
          encoding: "base64",
          data: "YmFzZTY0LXRva2Vu"
        },
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.complianceLevel, 3);
    assert.equal(payload.proof_package.timestamp_attestation.tsa, "tsa.vri.example");
    assert.equal(payload.proof_package.timestamp_attestation.message_imprint, expectedDigest);
    assert.equal(payload.proof_package.usage_event_id, usageEventId);
    assert.equal(typeof payload.proof_package.ledger_anchor, "string");
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
    assert.equal(verification.details.mode, "v2.0");
    assert.equal(verification.ledger.ok, true);
    assert.equal(verification.ledger.reason, "LEDGER_NOT_REQUIRED");
  } finally {
    server.close();
  }
});

test("POST /verify-proof enforces timestamp attestation verification for Level 3", async () => {
  const verifyingServer = createServer({
    verificationEndpoint: "http://127.0.0.1/test/verify-proof",
    verifyEnforceFreshness: false,
    trustedTimestampAuthorities: ["tsa.vri.example"],
    timestampTrustProfileId: "tsa-inline-prod",
    timestampTrustProfileName: "Inline Production TSA Policy",
    openSslTimestampOptions: {
      attime: 1711892410,
      crlCheck: true,
      x509Strict: true
    }
  });
  await new Promise((resolve) => verifyingServer.listen(0, "127.0.0.1", resolve));
  const { port } = verifyingServer.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registration = await registerVoice(audio, {
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId: "evt_level3_api",
      ledgerAnchor: "0xlevel3ledgeranchor",
      timestamp: 1711892400,
      timestampAttestation: {
        type: "RFC3161",
        tsa: "tsa.vri.example",
        policy_oid: "1.2.3.4.5",
        serial_number: "0x1234",
        message_imprint_alg: "sha256",
        attested_at: 1711892410,
        gen_time: 1711892410,
        token: "base64(tsr)",
        digest: "0xplaceholder"
      },
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    const level3Proof = {
      ...registration.proofPackage,
      timestamp_attestation: {
        ...registration.proofPackage.timestamp_attestation,
        message_imprint: getTimestampAttestationReceiptDigest(registration.proofPackage),
        digest: getTimestampAttestationReceiptDigest(registration.proofPackage)
      }
    };

    const verifyResponse = await fetch(`${baseUrl}/verify-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofPackage: level3Proof
      })
    });
    const payload = await verifyResponse.json();

    assert.equal(verifyResponse.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.trust_level, "HIGH");
    assert.equal(payload.trust_policy.source, "inline");
    assert.equal(payload.trust_policy.profile_id, "tsa-inline-prod");
    assert.equal(payload.trust_policy.profile_name, "Inline Production TSA Policy");
    assert.equal(payload.trust_policy.validation_profile.attime, 1711892410);
    assert.equal(payload.trust_policy.validation_profile.crl_check, true);
    assert.equal(payload.trust_policy.validation_profile.x509_strict, true);
    assert.match(payload.trust_policy.policy_digest, /^0x[0-9a-f]{64}$/);
  } finally {
    verifyingServer.close();
  }
});

test("key revocations persist across server restarts when revocationRegistryFilePath is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-revocation-state-"));
  const revocationRegistryFilePath = path.join(tempDir, "revocations.json");
  const apiKeyManager = createApiKeyManager();
  const organization = apiKeyManager.createOrganization("Persistence Test Org");
  const adminKey = apiKeyManager.createApiKey(organization.id, ROLES.ADMIN);
  const overrides = {
    requireAuth: true,
    apiKeyManager,
    revocationRegistryFilePath
  };

  const first = await startTestServer(overrides);

  try {
    const revocationResponse = await fetch(`${first.baseUrl}/key-revocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminKey.apiKey}`
      },
      body: JSON.stringify({
        keyId: "key_persisted",
        creatorId: "creator_123",
        publicKey: "0xpub",
        effectiveAt: 1700000000,
        reason: "key_compromise"
      })
    });
    const payload = await revocationResponse.json();

    assert.equal(revocationResponse.status, 201);
    assert.equal(payload.key_id, "key_persisted");
  } finally {
    first.server.close();
  }

  const second = await startTestServer(overrides);

  try {
    const response = await fetch(`${second.baseUrl}/key-revocations/key_persisted`, {
      headers: {
        authorization: `Bearer ${adminKey.apiKey}`
      }
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.key_id, "key_persisted");
    assert.equal(payload.reason, "key_compromise");
  } finally {
    second.server.close();
  }
});

test("GET /trust/timestamp-authorities loads auditable trust policy from file", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-tsa-policy-"));
  const trustedTimestampAuthoritiesFilePath = path.join(tempDir, "trusted-tsa.json");
  await writeFile(trustedTimestampAuthoritiesFilePath, JSON.stringify({
    profile_id: "tsa-eu-prod-v1",
    profile_name: "EU Production TSA Policy",
    version: 7,
    effective_at: 1774995000,
    validation_profile: {
      adapter: "openssl-ts-verify",
      attime: 1774995000,
      crl_check: true,
      x509_strict: true
    },
    trusted_timestamp_authorities: [
      {
        name: "tsa.example",
        tsa: "tsa.example",
        policy_oids: ["1.2.3.4.5"]
      }
    ]
  }, null, 2), "utf8");

  const { server, baseUrl } = await startTestServer({
    trustedTimestampAuthoritiesFilePath
  });

  try {
    const response = await fetch(`${baseUrl}/trust/timestamp-authorities`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.count, 1);
    assert.equal(payload.trusted_timestamp_authorities[0].tsa, "tsa.example");
    assert.equal(payload.trust_policy.version, 7);
    assert.equal(payload.trust_policy.effective_at, 1774995000);
    assert.equal(payload.trust_policy.profile_id, "tsa-eu-prod-v1");
    assert.equal(payload.trust_policy.profile_name, "EU Production TSA Policy");
    assert.equal(payload.trust_policy.source, trustedTimestampAuthoritiesFilePath);
    assert.equal(payload.trust_policy.validation_profile.attime, 1774995000);
    assert.equal(payload.trust_policy.validation_profile.crl_check, true);
    assert.match(payload.trust_policy.policy_digest, /^0x[0-9a-f]{64}$/);
  } finally {
    server.close();
  }
});

test("GET /trust/timestamp-policy returns the active TSA trust profile metadata", async () => {
  const { server, baseUrl } = await startTestServer({
    trustedTimestampAuthorities: ["tsa.vri.example"],
    timestampTrustProfileId: "tsa-inline-staging",
    timestampTrustProfileName: "Inline Staging TSA Policy"
  });

  try {
    const response = await fetch(`${baseUrl}/trust/timestamp-policy`);
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.trust_policy.profile_id, "tsa-inline-staging");
    assert.equal(payload.trust_policy.profile_name, "Inline Staging TSA Policy");
    assert.equal(payload.trust_policy.source, "inline");
    assert.match(payload.trust_policy.policy_digest, /^0x[0-9a-f]{64}$/);
  } finally {
    server.close();
  }
});

test("timestamp trust catalog selects the requested profile and lists available profiles", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-tsa-catalog-"));
  const catalogPath = path.join(tempDir, "timestamp-trust-profiles.catalog.json");
  await writeFile(catalogPath, JSON.stringify({
    version: 1,
    profiles: [
      {
        profile_id: "tsa-staging",
        profile_name: "Staging TSA Policy",
        version: 1,
        effective_at: null,
        trusted_timestamp_authorities: [
          {
            tsa: "tsa.staging.vri.example",
            policy_oids: ["1.2.3.4.5"]
          }
        ]
      },
      {
        profile_id: "tsa-prod",
        profile_name: "Production TSA Policy",
        version: 2,
        effective_at: 1775000000,
        validation_profile: {
          adapter: "openssl-ts-verify",
          policy: "1.2.3.4.5",
          policy_check: true
        },
        trusted_timestamp_authorities: [
          {
            tsa: "tsa.prod.vri.example",
            policy_oids: ["1.2.3.4.5"]
          }
        ]
      }
    ]
  }, null, 2), "utf8");

  const { server, baseUrl } = await startTestServer({
    trustedTimestampAuthoritiesCatalogFilePath: catalogPath,
    timestampTrustProfileId: "tsa-prod"
  });

  try {
    const policyResponse = await fetch(`${baseUrl}/trust/timestamp-policy`);
    const policyPayload = await policyResponse.json();
    assert.equal(policyResponse.status, 200);
    assert.equal(policyPayload.trust_policy.profile_id, "tsa-prod");
    assert.equal(policyPayload.trust_policy.profile_name, "Production TSA Policy");
    assert.equal(policyPayload.trust_policy.validation_profile.policy, "1.2.3.4.5");
    assert.equal(policyPayload.trust_policy.validation_profile.policy_check, true);

    const profilesResponse = await fetch(`${baseUrl}/trust/timestamp-profiles`);
    const profilesPayload = await profilesResponse.json();
    assert.equal(profilesResponse.status, 200);
    assert.equal(profilesPayload.count, 2);
    assert.equal(profilesPayload.active_profile_id, "tsa-prod");
    assert.deepEqual(profilesPayload.profiles.map((entry) => entry.profile_id), ["tsa-staging", "tsa-prod"]);
  } finally {
    server.close();
  }
});

test("verify-proof replay detection persists across server restarts when nonceReplayStoreFilePath is configured", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "vri-replay-state-"));
  const nonceReplayStoreFilePath = path.join(tempDir, "nonce-replay.json");
  const keyManager = createKeyManager();
  const audio = await readFile("examples/test/audio.wav");
  const registration = await registerVoice(audio, {
    keyManager,
    proofType: "GENERATED",
    complianceLevel: 2,
    nonce: "nonce-replay-persisted",
    metadata: {
      model_id: "tts-v3",
      operation: "voice_synthesis"
    }
  });
  const requestBody = {
    audioBase64: audio.toString("base64"),
    proofPackage: registration.proofPackage
  };
  const overrides = {
    nonceReplayStoreFilePath
  };

  const first = await startTestServer(overrides);

  try {
    const firstResponse = await fetch(`${first.baseUrl}/verify-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const firstPayload = await firstResponse.json();

    assert.equal(firstResponse.status, 200);
    assert.equal(firstPayload.ok, true);
  } finally {
    first.server.close();
  }

  const second = await startTestServer(overrides);

  try {
    const secondResponse = await fetch(`${second.baseUrl}/verify-proof`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(requestBody)
    });
    const secondPayload = await secondResponse.json();

    assert.equal(secondResponse.status, 200);
    assert.equal(secondPayload.ok, false);
    assert.equal(secondPayload.reason, "REPLAY_DETECTED");
  } finally {
    second.server.close();
  }
});

test("POST /verify-timestamp-attestation validates normalized RFC3161 payloads", async () => {
  const server = createServer({
    trustedTimestampAuthorities: ["tsa.vri.example"]
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registration = await registerVoice(audio, {
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId: "evt_level3_attestation",
      ledgerAnchor: "0xlevel3ledgeranchor",
      timestamp: 1711892400,
      timestampAttestation: {
        type: "RFC3161",
        tsa: "tsa.vri.example",
        policy_oid: "1.2.3.4.5",
        serial_number: "0x1234",
        message_imprint_alg: "sha256",
        attested_at: 1711892410,
        gen_time: 1711892410,
        token: "base64(tsr)",
        digest: "0xplaceholder"
      },
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    const proofPackage = {
      ...registration.proofPackage,
      timestamp_attestation: {
        ...registration.proofPackage.timestamp_attestation,
        message_imprint: getTimestampAttestationReceiptDigest(registration.proofPackage),
        digest: getTimestampAttestationReceiptDigest(registration.proofPackage)
      }
    };

    const okResponse = await fetch(`${baseUrl}/verify-timestamp-attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofPackage,
        timestampAttestation: proofPackage.timestamp_attestation
      })
    });
    const okPayload = await okResponse.json();

    assert.equal(okResponse.status, 200);
    assert.equal(okPayload.ok, true);
    assert.equal(okPayload.reason, "VALID");
    assert.equal(okPayload.trust_policy.source, "inline");
    assert.match(okPayload.trust_policy.policy_digest, /^0x[0-9a-f]{64}$/);

    const badResponse = await fetch(`${baseUrl}/verify-timestamp-attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofPackage,
        timestampAttestation: {
          ...proofPackage.timestamp_attestation,
          tsa: "evil.example"
        }
      })
    });
    const badPayload = await badResponse.json();

    assert.equal(badResponse.status, 200);
    assert.equal(badPayload.ok, false);
    assert.match(badPayload.reason, /not trusted/);
  } finally {
    server.close();
  }
});

test("POST /normalize-timestamp-attestation normalizes raw RFC3161 tokens via parser hook", async () => {
  const server = createServer({
    trustedTimestampAuthorities: ["tsa.vri.example"],
    parseRfc3161Token: (token, { expectedDigest }) => ({
      type: "RFC3161",
      tsa: "tsa.vri.example",
      policy_oid: "1.2.3.4.5",
      serial_number: "0x1234",
      message_imprint_alg: "sha256",
      message_imprint: expectedDigest,
      attested_at: 1711892410,
      gen_time: 1711892410,
      token
    })
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registration = await registerVoice(audio, {
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId: "evt_level3_normalize",
      ledgerAnchor: "0xlevel3ledgeranchor",
      timestamp: 1711892400,
      timestampAttestation: {
        type: "RFC3161",
        tsa: "tsa.vri.example",
        policy_oid: "1.2.3.4.5",
        serial_number: "0x1234",
        message_imprint_alg: "sha256",
        attested_at: 1711892410,
        gen_time: 1711892410,
        token: "base64(tsr)",
        digest: "0xplaceholder"
      },
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    const proofPackage = registration.proofPackage;

    const response = await fetch(`${baseUrl}/normalize-timestamp-attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofPackage,
        timestampToken: {
          encoding: "base64",
          data: Buffer.from("raw-tsr").toString("base64")
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.timestamp_attestation.type, "RFC3161");
    assert.equal(payload.timestamp_attestation.tsa, "tsa.vri.example");
    assert.equal(payload.timestamp_attestation.message_imprint, payload.expected_digest);
  } finally {
    server.close();
  }
});

test("POST /normalize-timestamp-attestation can use the built-in openssl adapter", async () => {
  let expectedDigest = null;
  const server = createServer({
    trustedTimestampAuthorities: [
      {
        tsa: "tsa.vri.example",
        policy_oids: ["1.2.3.4.5"]
      }
    ],
    openSslTimestampOptions: {
      caFile: "/tmp/test-ca.pem",
      execFileSync: (_binary, args) => {
        if (args.includes("-reply")) {
          const hexPairs = (expectedDigest ?? `0x${"aa".repeat(32)}`)
            .slice(2)
            .match(/.{1,2}/g)
            .join(" ");
          return `
Status info:
Status: Granted.
TST info:
Policy OID: 1.2.3.4.5
Hash Algorithm: sha256
Message data:
    0000 - ${hexPairs.slice(0, 47)}-${hexPairs.slice(48, 95)}
    0010 - ${hexPairs.slice(96, 143)}-${hexPairs.slice(144)}
Serial number: 0x1234
Time stamp: Apr  1 12:00:10 2026 GMT
TSA: DirName:/CN=tsa.vri.example
`;
        }

        return "";
      }
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registration = await registerVoice(audio, {
      proofType: "GENERATED",
      complianceLevel: 3,
      usageEventId: "evt_level3_openssl",
      ledgerAnchor: "0xlevel3ledgeranchor",
      timestamp: 1775044800,
      metadata: {
        model_id: "tts-v3",
        operation: "voice_synthesis"
      }
    });
    expectedDigest = getTimestampAttestationReceiptDigest(registration.proofPackage);

    const response = await fetch(`${baseUrl}/normalize-timestamp-attestation`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proofPackage: registration.proofPackage,
        timestampToken: {
          encoding: "base64",
          data: "YmFzZTY0LXRva2Vu"
        }
      })
    });
    const payload = await response.json();

    assert.equal(response.status, 200);
    assert.equal(payload.ok, true);
    assert.equal(payload.timestamp_attestation.tsa, "tsa.vri.example");
    assert.equal(payload.timestamp_attestation.policy_oid, "1.2.3.4.5");
  } finally {
    server.close();
  }
});

test("key revocation endpoints feed current key status into verify-proof", async () => {
  const apiKeyManager = createApiKeyManager();
  const org = apiKeyManager.createOrganization("Revocation Test Org");
  const adminKey = apiKeyManager.createApiKey(org.id, ROLES.ADMIN);
  const { server, baseUrl } = await startTestServer({
    requireAuth: true,
    apiKeyManager
  });
  const audio = await readFile("examples/test/audio.wav");

  try {
    const registerResponse = await fetch(`${baseUrl}/register`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminKey.apiKey}`
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        metadata: {
          model_id: "tts-v3",
          operation: "voice_synthesis"
        }
      })
    });
    const registration = await registerResponse.json();
    assert.equal(registerResponse.status, 200);

    const revocationResponse = await fetch(`${baseUrl}/key-revocations`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminKey.apiKey}`
      },
      body: JSON.stringify({
        keyId: registration.proof_package.key_id,
        creatorId: registration.proof_package.creator_id,
        publicKey: registration.proof_package.public_key,
        effectiveAt: registration.proof_package.timestamp - 1,
        reason: "key_compromise"
      })
    });
    const revocation = await revocationResponse.json();
    assert.equal(revocationResponse.status, 201);
    assert.equal(revocation.key_id, registration.proof_package.key_id);

    const verifyResponse = await fetch(`${baseUrl}/verify-proof`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${adminKey.apiKey}`
      },
      body: JSON.stringify({
        audioBase64: audio.toString("base64"),
        proofPackage: registration.proof_package
      })
    });
    const verification = await verifyResponse.json();

    assert.equal(verifyResponse.status, 200);
    assert.equal(verification.revocation.current_key_status, "REVOKED");
    assert.equal(verification.revocation.historical_validity, "INDETERMINATE_UNATTESTED");
    assert.equal(verification.revocation.revocation_record.key_id, registration.proof_package.key_id);
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
    const eventId = registration.ledger_event.event_id;
    const eventResponse = await fetch(`${baseUrl}/events/${encodeURIComponent(eventId)}`);
    const event = await eventResponse.json();

    assert.equal(eventResponse.status, 200);
    assert.equal(event.event_id, eventId);
    assert.equal(event.proof_type, registration.proof_package.proof_type);
    assert.equal(event.audio_hash, registration.proof_package.audio_hash);
    assert.equal(event.ledger_anchor, registration.ledger_event.ledger_anchor);
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
    const eventId = registration.ledger_event.event_id;
    const proofResponse = await fetch(`${baseUrl}/proofs/${encodeURIComponent(eventId)}`);
    const proof = await proofResponse.json();

    assert.equal(proofResponse.status, 200);
    assert.equal(proof.event.event_id, eventId);
    assert.equal(proof.root_hash, registration.ledger_event.ledger_anchor);
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
    assert.equal(batch.root_hash, registration.ledger_event.ledger_anchor);
    assert.ok(Array.isArray(batch.event_ids));
    assert.ok(batch.event_ids.includes(registration.ledger_event.event_id));
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

    const eventResponse = await fetch(`${baseUrl}/events/${encodeURIComponent(registration.ledger_event.event_id)}`);
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

test("POST /verify-proof rejects invalid compliance_level domain", async () => {
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
          request_id: "req_api_invalid_compliance",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    registration.proof_package.compliance_level = "2";

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
    const payload = await verifyResponse.json();

    assert.equal(verifyResponse.status, 400);
    assert.equal(payload.error, "invalid_compliance_level");
  } finally {
    server.close();
  }
});

test("POST /verify-proof requires compliance_level in strict profile", async () => {
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
          request_id: "req_api_missing_compliance",
          tenant_id: "org_api"
        }
      })
    });
    const registration = await registerResponse.json();
    delete registration.proof_package.compliance_level;

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
    const payload = await verifyResponse.json();

    assert.equal(verifyResponse.status, 400);
    assert.equal(payload.error, "invalid_compliance_level");
  } finally {
    server.close();
  }
});

test("POST /verify-proof hard-fails when watermark is not present for compliance >= 2", async () => {
  const watermarkEngine = {
    async embed(audio) {
      return {
        audio,
        watermark: { embedded: true, mode: "vri-spread-spectrum-v1" }
      };
    },
    async extract() {
      return {
        recovered: false,
        sync_quality: 0,
        bit_match_ratio: 0
      };
    }
  };
  const { server, baseUrl } = await startTestServer({
    watermarkEngine,
    verifyRequiredComplianceLevel: 2
  });
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
          request_id: "req_api_watermark_policy",
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
    const payload = await verifyResponse.json();

    assert.equal(verifyResponse.status, 200);
    assert.equal(payload.ok, false);
    assert.equal(payload.reason, "WATERMARK_REQUIRED_NOT_PRESENT");
    assert.equal(payload.trust_level, "LOW");
  } finally {
    server.close();
  }
});
