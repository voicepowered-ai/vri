import fs from "node:fs";
import path from "node:path";

export class RevocationRegistry {
  #records;
  #filePath;

  constructor(options = {}) {
    this.#records = new Map();
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
    const records = Array.isArray(payload?.records) ? payload.records : [];

    for (const record of records) {
      if (record && typeof record.key_id === "string" && record.key_id.length > 0) {
        this.#records.set(record.key_id, record);
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
      records: Array.from(this.#records.values())
    }, null, 2), "utf8");
  }

  revoke({ keyId, creatorId = null, publicKey = null, effectiveAt, reason = null, recordedAt = null }) {
    if (typeof keyId !== "string" || keyId.length === 0) {
      throw new TypeError("keyId is required.");
    }

    if (!Number.isInteger(effectiveAt) || effectiveAt < 0) {
      throw new TypeError("effectiveAt must be a non-negative integer.");
    }

    const record = {
      key_id: keyId,
      creator_id: creatorId,
      public_key: publicKey,
      revoked_at: effectiveAt,
      reason,
      recorded_at: recordedAt ?? effectiveAt
    };

    this.#records.set(keyId, record);
    this.#persistToDisk();
    return record;
  }

  get(keyId) {
    return this.#records.get(keyId) ?? null;
  }
}

export function createRevocationRegistry(options = {}) {
  return new RevocationRegistry(options);
}
