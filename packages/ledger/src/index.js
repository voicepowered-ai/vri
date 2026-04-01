import path from "node:path";
import crypto from "node:crypto";
import net from "node:net";
import dns from "node:dns/promises";
import { getCanonicalMetadataString, sha256Hex } from "../../core/src/index.js";
import { createStorage } from "./storage.js";

const DEFAULT_LEDGER_FILE = path.resolve(process.cwd(), "tmp/vri-ledger/events.jsonl");
const DEFAULT_BATCH_FILE = path.resolve(process.cwd(), "tmp/vri-ledger/batches.jsonl");
const ZERO_HASH = "0x0000000000000000000000000000000000000000000000000000000000000000";

class ExternalAnchorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "ExternalAnchorError";
    this.code = options.code ?? "EXTERNAL_ANCHOR_ERROR";
  }
}

function canonicalizeValue(value) {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    return String(value);
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeValue(item)).join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalizeValue(value[key])}`).join(",")}}`;
  }

  throw new TypeError("Unsupported ledger value type.");
}

function canonicalizeRecord(record) {
  return canonicalizeValue(record);
}

function buildAnchorHash(previousAnchor, record) {
  const payload = `${previousAnchor}:${canonicalizeRecord(record)}`;
  return `0x${sha256Hex(Buffer.from(payload, "utf8"))}`;
}

function hashPair(left, right) {
  return `0x${sha256Hex(Buffer.from(`${left}:${right}`, "utf8"))}`;
}

function buildMerkleRoot(hashes) {
  if (hashes.length === 0) {
    return ZERO_HASH;
  }

  let level = [...hashes];

  while (level.length > 1) {
    const next = [];

    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1] ?? level[index];
      next.push(hashPair(left, right));
    }

    level = next;
  }

  return level[0];
}

function buildMerkleProof(hashes, targetIndex) {
  if (targetIndex < 0 || targetIndex >= hashes.length) {
    throw new RangeError("targetIndex out of range.");
  }

  const proof = [];
  let index = targetIndex;
  let level = [...hashes];

  while (level.length > 1) {
    const isRightNode = index % 2 === 1;
    const siblingIndex = isRightNode ? index - 1 : index + 1;
    const siblingHash = level[siblingIndex] ?? level[index];

    proof.push({
      position: isRightNode ? "left" : "right",
      hash: siblingHash
    });

    const next = [];

    for (let levelIndex = 0; levelIndex < level.length; levelIndex += 2) {
      const left = level[levelIndex];
      const right = level[levelIndex + 1] ?? level[levelIndex];
      next.push(hashPair(left, right));
    }

    level = next;
    index = Math.floor(index / 2);
  }

  return proof;
}

function normalizeExternalAnchorResponse(payload, fallback = {}) {
  if (!payload || typeof payload !== "object") {
    throw new ExternalAnchorError("External anchor response must be a JSON object.", {
      code: "EXTERNAL_ANCHOR_INVALID_RESPONSE"
    });
  }

  const anchorId = typeof payload.anchorId === "string" && payload.anchorId.length > 0
    ? payload.anchorId
    : typeof payload.external_anchor_id === "string" && payload.external_anchor_id.length > 0
      ? payload.external_anchor_id
      : null;
  const transactionHash = typeof payload.transactionHash === "string" && payload.transactionHash.length > 0
    ? payload.transactionHash
    : typeof payload.blockchain_tx === "string" && payload.blockchain_tx.length > 0
      ? payload.blockchain_tx
      : null;

  if (!anchorId || !transactionHash) {
    throw new ExternalAnchorError("External anchor response is missing anchorId or transactionHash.", {
      code: "EXTERNAL_ANCHOR_INVALID_RESPONSE"
    });
  }

  const provider = typeof payload.provider === "string" && payload.provider.length > 0
    ? payload.provider
    : fallback.provider;
  const network = typeof payload.network === "string" && payload.network.length > 0
    ? payload.network
    : fallback.network;
  const confirmed = payload.confirmed !== false;
  const publishedAt = Number.isInteger(payload.publishedAt)
    ? payload.publishedAt
    : Number.isInteger(payload.external_anchor_published_at)
      ? payload.external_anchor_published_at
      : Math.floor(Date.now() / 1000);

  return {
    anchorId,
    transactionHash,
    provider,
    network,
    confirmed,
    publishedAt
  };
}

function isPrivateIPv4(ip) {
  const parts = ip.split(".").map((value) => Number(value));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }

  const [a, b] = parts;
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || a === 127
    || (a === 169 && b === 254);
}

function isPrivateIPv6(ip) {
  const normalized = ip.toLowerCase();
  return normalized === "::1"
    || normalized.startsWith("fc")
    || normalized.startsWith("fd")
    || normalized.startsWith("fe80:");
}

function isPrivateIp(ip) {
  const family = net.isIP(ip);
  if (family === 4) {
    return isPrivateIPv4(ip);
  }

  if (family === 6) {
    return isPrivateIPv6(ip);
  }

  return false;
}

async function resolveHostAddresses(hostname) {
  const literal = net.isIP(hostname);
  if (literal) {
    return [hostname];
  }

  const records = await dns.lookup(hostname, { all: true });
  return records.map((record) => record.address);
}

async function validateAnchorEndpoint(endpoint, policy) {
  let parsed;

  try {
    parsed = new URL(endpoint);
  } catch {
    throw new ExternalAnchorError("External anchor endpoint must be a valid URL.", {
      code: "EXTERNAL_ANCHOR_INVALID_ENDPOINT"
    });
  }

  if (parsed.username || parsed.password) {
    throw new ExternalAnchorError("External anchor endpoint must not include credentials.", {
      code: "EXTERNAL_ANCHOR_INVALID_ENDPOINT"
    });
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && !(policy.allowInsecureHttp && protocol === "http:")) {
    throw new ExternalAnchorError("External anchor endpoint must use HTTPS.", {
      code: "EXTERNAL_ANCHOR_INVALID_ENDPOINT"
    });
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowlist = Array.isArray(policy.allowlist)
    ? policy.allowlist.map((entry) => String(entry).toLowerCase()).filter(Boolean)
    : [];

  if (allowlist.length > 0 && !allowlist.includes(hostname)) {
    throw new ExternalAnchorError("External anchor host is not in the allowlist.", {
      code: "EXTERNAL_ANCHOR_HOST_NOT_ALLOWED"
    });
  }

  if (!policy.allowLocalhost && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1")) {
    throw new ExternalAnchorError("External anchor localhost targets are not allowed.", {
      code: "EXTERNAL_ANCHOR_PRIVATE_NETWORK_BLOCKED"
    });
  }

  if (!policy.allowPrivateNetworks) {
    const addresses = await resolveHostAddresses(parsed.hostname);
    if (addresses.some((address) => isPrivateIp(address))) {
      throw new ExternalAnchorError("External anchor private network targets are not allowed.", {
        code: "EXTERNAL_ANCHOR_PRIVATE_NETWORK_BLOCKED"
      });
    }
  }

  return parsed.toString();
}

async function readJsonWithLimit(response, maxResponseBytes) {
  const body = response.body;

  if (!body || typeof body.getReader !== "function") {
    return response.json();
  }

  const reader = body.getReader();
  const chunks = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    const chunk = Buffer.from(value);
    total += chunk.length;

    if (total > maxResponseBytes) {
      throw new ExternalAnchorError("External anchor response exceeded maximum allowed size.", {
        code: "EXTERNAL_ANCHOR_RESPONSE_TOO_LARGE"
      });
    }

    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    throw new ExternalAnchorError("External anchor response must be valid JSON.", {
      code: "EXTERNAL_ANCHOR_INVALID_RESPONSE"
    });
  }
}

export function createHttpAnchorPublisher(options = {}) {
  const retries = Math.max(1, Number(options.retries ?? 2));
  const policy = {
    allowlist: options.allowlist ?? [],
    allowPrivateNetworks: options.allowPrivateNetworks ?? false,
    allowLocalhost: options.allowLocalhost ?? false,
    allowInsecureHttp: options.allowInsecureHttp ?? false,
    timeoutMs: Math.max(100, Number(options.timeoutMs ?? 5000)),
    maxResponseBytes: Math.max(1024, Number(options.maxResponseBytes ?? 64 * 1024))
  };

  return {
    async publish(request) {
      const endpoint = request.endpoint ?? options.endpoint ?? process.env.VRI_EXTERNAL_ANCHOR_URL;

      if (typeof endpoint !== "string" || endpoint.length === 0) {
        throw new ExternalAnchorError("An external anchor endpoint is required.", {
          code: "EXTERNAL_ANCHOR_ENDPOINT_REQUIRED"
        });
      }

      const validatedEndpoint = await validateAnchorEndpoint(endpoint, policy);
      let lastError;

      for (let attempt = 1; attempt <= retries; attempt += 1) {
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), policy.timeoutMs);
          let response;

          try {
            response = await fetch(validatedEndpoint, {
              method: "POST",
              headers: {
                "content-type": "application/json"
              },
              signal: controller.signal,
              body: JSON.stringify({
                provider: request.provider,
                network: request.network,
                batchId: request.batch.batch_id,
                rootHash: request.batch.root_hash,
                batchAnchor: request.batch.batch_anchor,
                previousBatchAnchor: request.batch.previous_batch_anchor,
                eventCount: request.batch.event_count,
                eventIds: request.batch.event_ids
              })
            });
          } finally {
            clearTimeout(timeout);
          }

          const payload = await readJsonWithLimit(response, policy.maxResponseBytes);

          if (!response.ok) {
            throw new ExternalAnchorError(
              typeof payload?.error === "string" ? payload.error : `External anchor provider responded with HTTP ${response.status}.`,
              { code: "EXTERNAL_ANCHOR_HTTP_ERROR" }
            );
          }

          return normalizeExternalAnchorResponse(payload, {
            provider: request.provider,
            network: request.network
          });
        } catch (error) {
          if (error?.name === "AbortError") {
            lastError = new ExternalAnchorError("External anchor request timed out.", {
              code: "EXTERNAL_ANCHOR_TIMEOUT"
            });
          } else {
            lastError = error;
          }

          if (attempt >= retries) {
            break;
          }
        }
      }

      if (lastError instanceof ExternalAnchorError) {
        throw lastError;
      }

      throw new ExternalAnchorError(lastError?.message ?? "External anchor publication failed.", {
        code: "EXTERNAL_ANCHOR_REQUEST_FAILED"
      });
    }
  };
}

export function verifyMerkleProof({ leafHash, proof, rootHash }) {
  let current = leafHash;

  for (const step of proof) {
    current = step.position === "left"
      ? hashPair(step.hash, current)
      : hashPair(current, step.hash);
  }

  return current === rootHash;
}

export function createUsageEvent(proofPackage, context = {}) {
  const metadata = proofPackage.metadata ?? {};
  const model = context.model ?? metadata.model_id ?? "unknown";
  const provider = context.provider ?? metadata.provider ?? "unknown";

  return {
    event_id: context.eventId ?? proofPackage.usage_event_id ?? `evt_${crypto.randomUUID()}`,
    creator_id: proofPackage.creator_id,
    public_key: proofPackage.public_key,
    audio_hash: proofPackage.audio_hash,
    watermark_payload: proofPackage.watermark_payload,
    timestamp: proofPackage.timestamp,
    status: context.status ?? "RECORDED",
    model,
    provider,
    metadata,
    canonical_metadata: typeof proofPackage.canonical_metadata === "string"
      ? proofPackage.canonical_metadata
      : getCanonicalMetadataString(metadata),
    verification_endpoint: proofPackage.verification_endpoint ?? null,
    ledger_batch_id: context.ledgerBatchId ?? null
  };
}

export class FileLedger {
  constructor(options = {}) {
    this.batchSize = options.batchSize ?? 10;
    this.anchorPublisher = options.anchorPublisher ?? createHttpAnchorPublisher(options.anchorPolicy);
    
    // Initialize event storage
    this.eventStorage = options.eventStorage || createStorage({
      backend: options.storageBackend || "jsonl",
      filePath: options.filePath ?? DEFAULT_LEDGER_FILE,
      idField: options.eventIdField ?? "event_id",
      tableName: options.eventTableName ?? "vri_events",
      collectionName: options.eventCollectionName ?? "vri_events",
      pool: options.postgresPool,
      client: options.mongoClient,
      db: options.mongoDb
    });
    
    // Initialize batch storage
    this.batchStorage = options.batchStorage || createStorage({
      backend: options.batchStorageBackend || options.storageBackend || "jsonl",
      filePath: options.batchFilePath ?? DEFAULT_BATCH_FILE,
      idField: options.batchIdField ?? "batch_id",
      tableName: options.batchTableName ?? "vri_batches",
      collectionName: options.batchCollectionName ?? "vri_batches",
      pool: options.postgresPool,
      client: options.mongoClient,
      db: options.mongoDb
    });
  }

  async ensureStorage() {
    await this.eventStorage.initialize();
    await this.batchStorage.initialize();
  }

  async listEvents() {
    return this.eventStorage.getAll();
  }

  async listBatches() {
    return this.batchStorage.getAll();
  }

  async getLatestRecord() {
    const events = await this.listEvents();
    return events.length === 0 ? null : events[events.length - 1];
  }

  async getLatestBatch() {
    const batches = await this.listBatches();
    return batches.length === 0 ? null : batches[batches.length - 1];
  }

  async rewriteEvents(events) {
    await this.ensureStorage();
    await this.eventStorage.replaceAll(events);
  }

  async appendUsageEvent(proofPackage, context = {}) {
    await this.ensureStorage();
    const previousRecord = await this.getLatestRecord();
    const usageEvent = createUsageEvent(proofPackage, context);
    const previousAnchor = previousRecord?.chain_anchor ?? ZERO_HASH;
    const sequence = previousRecord?.sequence != null ? previousRecord.sequence + 1 : 1;
    const contentHash = `0x${sha256Hex(Buffer.from(canonicalizeRecord(usageEvent), "utf8"))}`;
    const chainAnchor = buildAnchorHash(previousAnchor, {
      ...usageEvent,
      sequence,
      previous_anchor: previousAnchor,
      content_hash: contentHash
    });
    const record = {
      ...usageEvent,
      sequence,
      previous_anchor: previousAnchor,
      content_hash: contentHash,
      chain_anchor: chainAnchor,
      ledger_anchor: null,
      batch_anchor: null,
      recorded_at: Math.floor(Date.now() / 1000)
    };

    await this.eventStorage.append(record);

    const shouldAnchorNow = context.anchorNow ?? (sequence % this.batchSize === 0);

    if (shouldAnchorNow) {
      const batch = await this.anchorPendingEvents();

      if (batch) {
        return this.getEvent(record.event_id);
      }
    }

    return record;
  }

  async anchorPendingEvents() {
    await this.ensureStorage();
    const events = await this.listEvents();
    const pendingEvents = events.filter((event) => !event.ledger_batch_id);

    if (pendingEvents.length === 0) {
      return null;
    }

    const latestBatch = await this.getLatestBatch();
    const batchId = `batch_${crypto.randomUUID()}`;
    const eventIds = pendingEvents.map((event) => event.event_id);
    const rootHash = buildMerkleRoot(pendingEvents.map((event) => event.content_hash));
    const previousBatchAnchor = latestBatch?.batch_anchor ?? ZERO_HASH;
    const batch = {
      batch_id: batchId,
      root_hash: rootHash,
      event_count: pendingEvents.length,
      event_ids: eventIds,
      previous_batch_anchor: previousBatchAnchor,
      batch_anchor: buildAnchorHash(previousBatchAnchor, {
        batch_id: batchId,
        root_hash: rootHash,
        event_ids: eventIds
      }),
      anchor_time: Math.floor(Date.now() / 1000),
      blockchain_chain: null,
      blockchain_tx: null,
      blockchain_confirmed: false
    };

    const updatedEvents = events.map((event) => {
      if (!eventIds.includes(event.event_id)) {
        return event;
      }

      return {
        ...event,
        ledger_batch_id: batch.batch_id,
        ledger_anchor: batch.root_hash,
        batch_anchor: batch.batch_anchor
      };
    });

    await this.rewriteEvents(updatedEvents);
    await this.batchStorage.append(batch);

    return batch;
  }

  async getEvent(eventId) {
    const events = await this.listEvents();
    return events.find((event) => event.event_id === eventId) ?? null;
  }

  async getBatch(batchId) {
    const batches = await this.listBatches();
    return batches.find((batch) => batch.batch_id === batchId) ?? null;
  }

  async rewriteBatches(batches) {
    await this.ensureStorage();
    await this.batchStorage.replaceAll(batches);
  }

  async publishBatchAnchor(batchId, context = {}) {
    const batches = await this.listBatches();
    const targetIndex = batches.findIndex((batch) => batch.batch_id === batchId);

    if (targetIndex < 0) {
      return null;
    }

    const batch = batches[targetIndex];
    const provider = context.provider ?? "external-anchor";
    const network = context.network ?? "mainnet";
    const publication = await this.anchorPublisher.publish({
      provider,
      network,
      endpoint: context.endpoint,
      batch
    });
    const updatedBatch = {
      ...batch,
      blockchain_chain: publication.network ?? network,
      blockchain_tx: publication.transactionHash,
      blockchain_confirmed: publication.confirmed,
      external_anchor_provider: publication.provider ?? provider,
      external_anchor_id: publication.anchorId,
      external_anchor_published_at: publication.publishedAt
    };

    batches[targetIndex] = updatedBatch;
    await this.rewriteBatches(batches);

    return updatedBatch;
  }

  async getMerkleProof(eventId) {
    const event = await this.getEvent(eventId);

    if (!event) {
      return null;
    }

    if (!event.ledger_batch_id) {
      return {
        event,
        batch: null,
        proof: [],
        leaf_hash: event.content_hash,
        root_hash: null,
        verified: false
      };
    }

    const [events, batch] = await Promise.all([
      this.listEvents(),
      this.getBatch(event.ledger_batch_id)
    ]);

    if (!batch) {
      return null;
    }

    const batchEvents = events.filter((candidate) => candidate.ledger_batch_id === batch.batch_id);
    const hashes = batchEvents.map((candidate) => candidate.content_hash);
    const targetIndex = batchEvents.findIndex((candidate) => candidate.event_id === eventId);

    if (targetIndex < 0) {
      return null;
    }

    const proof = buildMerkleProof(hashes, targetIndex);

    return {
      event,
      batch,
      proof,
      leaf_hash: event.content_hash,
      root_hash: batch.root_hash,
      verified: verifyMerkleProof({
        leafHash: event.content_hash,
        proof,
        rootHash: batch.root_hash
      })
    };
  }

  async verifyProofPackage(proofPackage) {
    if (!proofPackage.usage_event_id || !proofPackage.ledger_anchor) {
      return {
        ok: false,
        reason: "LEDGER_REFERENCE_MISSING"
      };
    }

    const event = await this.getEvent(proofPackage.usage_event_id);

    if (!event) {
      return {
        ok: false,
        reason: "LEDGER_EVENT_NOT_FOUND"
      };
    }

    const consistent = event.audio_hash === proofPackage.audio_hash
      && event.public_key === proofPackage.public_key
      && event.creator_id === proofPackage.creator_id
      && event.watermark_payload === proofPackage.watermark_payload
      && event.timestamp === proofPackage.timestamp
      && event.ledger_anchor === proofPackage.ledger_anchor;
    const batch = event.ledger_batch_id ? await this.getBatch(event.ledger_batch_id) : null;
    const merkleProof = event.ledger_batch_id ? await this.getMerkleProof(event.event_id) : null;
    const proofVerified = merkleProof?.verified ?? false;

    return {
      ok: consistent && proofVerified,
      reason: consistent && proofVerified ? "LEDGER_CONFIRMED" : "LEDGER_MISMATCH",
      event,
      batch,
      merkle_proof: merkleProof
    };
  }

  async getStatus() {
    const [events, batches] = await Promise.all([this.listEvents(), this.listBatches()]);

    return {
      event_count: events.length,
      batch_count: batches.length,
      pending_event_count: events.filter((event) => !event.ledger_batch_id).length,
      latest_batch_id: batches.at(-1)?.batch_id ?? null,
      latest_batch_root: batches.at(-1)?.root_hash ?? null,
      latest_external_anchor_id: batches.at(-1)?.external_anchor_id ?? null
    };
  }
}

export function createLedger(options) {
  return new FileLedger(options);
}

export { ExternalAnchorError };
