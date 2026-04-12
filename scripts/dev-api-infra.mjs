import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../packages/api/src/server.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

function readListEnv(name, fallback) {
  const value = process.env[name];

  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function getLocalVerifierOrigins() {
  const origins = new Set([
    "https://localhost",
    "https://127.0.0.1"
  ]);

  const networkInterfaces = os.networkInterfaces();

  for (const entries of Object.values(networkInterfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || entry.family !== "IPv4") {
        continue;
      }

      origins.add(`https://${entry.address}`);
    }
  }

  return [...origins];
}

function ensurePrivateKeyPem(filePath) {
  if (fs.existsSync(filePath)) {
    return fs.readFileSync(filePath, "utf8").trim();
  }

  const { privateKey } = crypto.generateKeyPairSync("ed25519");
  const pem = privateKey.export({ format: "pem", type: "pkcs8" }).trim();

  ensureDirectory(path.dirname(filePath));
  fs.writeFileSync(filePath, `${pem}\n`, { encoding: "utf8", mode: 0o600 });

  return pem;
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = path.resolve(repoRoot, process.env.VRI_DEV_DATA_DIR ?? "tmp/vri-dev");
const trustedVerifierOrigins = readListEnv("VRI_DEV_TRUSTED_VERIFIER_ORIGINS", getLocalVerifierOrigins());
const corsAllowedOrigins = readListEnv("VRI_DEV_CORS_ALLOWED_ORIGINS", ["*"]);

ensureDirectory(dataDir);

const privateKeyPem = ensurePrivateKeyPem(path.join(dataDir, "private_key.pem"));

startServer({
  port,
  privateKeyPem,
  trustedVerifierOrigins,
  corsAllowedOrigins,
  ledgerFilePath: path.join(dataDir, "events.jsonl"),
  batchFilePath: path.join(dataDir, "batches.jsonl"),
  nonceReplayStoreFilePath: path.join(dataDir, "nonce-replay.json"),
  identitySessionStoreFilePath: path.join(dataDir, "identity-sessions.json"),
  recordingSessionStoreFilePath: path.join(dataDir, "recording-sessions.json"),
  revocationRegistryFilePath: path.join(dataDir, "revocations.json"),
  auditLogBackend: "file",
  auditLogFilePath: path.join(dataDir, "audit-log.jsonl")
});

console.log("[dev-api-infra] VRI development API started");
console.log(`[dev-api-infra] Data dir: ${dataDir}`);
console.log(`[dev-api-infra] Trusted verifier origins: ${trustedVerifierOrigins.join(", ")}`);
console.log(`[dev-api-infra] CORS allowed origins: ${corsAllowedOrigins.join(", ")}`);
