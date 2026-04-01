/**
 * Audit logging for VRI operations.
 * Logs registration, verification, publishing, and errors.
 */

import { EventEmitter } from "node:events";

const LOG_LEVELS = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3
};

const EVENT_TYPES = {
  VOICE_REGISTERED: "voice_registered",
  VOICE_VERIFIED: "voice_verified",
  BATCH_ANCHORED: "batch_anchored",
  BATCH_PUBLISHED: "batch_published",
  KEYPAIR_ROTATED: "keypair_rotated",
  ERROR: "error"
};

/**
 * In-memory audit log
 */
export class AuditLog extends EventEmitter {
  #entries = [];
  #minLevel = LOG_LEVELS.INFO;

  constructor(options = {}) {
    super();
    this.#minLevel = LOG_LEVELS[options.minLevel ?? "INFO"] ?? LOG_LEVELS.INFO;
  }

  log(level, eventType, message, metadata = {}) {
    const entry = {
      timestamp: Math.floor(Date.now() / 1000),
      level,
      eventType,
      message,
      metadata
    };

    if (level >= this.#minLevel) {
      this.#entries.push(entry);
      this.emit(eventType, entry);
    }

    return entry;
  }

  info(eventType, message, metadata = {}) {
    return this.log(LOG_LEVELS.INFO, eventType, message, metadata);
  }

  warn(eventType, message, metadata = {}) {
    return this.log(LOG_LEVELS.WARN, eventType, message, metadata);
  }

  error(eventType, message, metadata = {}) {
    return this.log(LOG_LEVELS.ERROR, eventType, message, metadata);
  }

  getEntries(filters = {}) {
    let entries = this.#entries;

    if (filters.eventType) {
      entries = entries.filter((e) => e.eventType === filters.eventType);
    }

    if (filters.level != null) {
      entries = entries.filter((e) => e.level === filters.level);
    }

    if (filters.startTime != null) {
      entries = entries.filter((e) => e.timestamp >= filters.startTime);
    }

    if (filters.endTime != null) {
      entries = entries.filter((e) => e.timestamp <= filters.endTime);
    }

    return entries;
  }

  countByEventType() {
    const counts = {};

    for (const entry of this.#entries) {
      counts[entry.eventType] = (counts[entry.eventType] ?? 0) + 1;
    }

    return counts;
  }

  clear() {
    this.#entries = [];
  }
}

/**
 * File-based audit log (append-only JSONL)
 */
export class FileAuditLog extends AuditLog {
  #filePath;
  #fs;

  constructor(options = {}) {
    super(options);
    this.#filePath = options.filePath;
    this.#fs = null;
  }

  async initialize(fsModule = null) {
    if (fsModule) {
      this.#fs = fsModule;
    } else {
      this.#fs = await import("node:fs/promises");
    }

    if (this.#filePath) {
      const path = await import("node:path");
      const dirPath = path.dirname(this.#filePath);
      await this.#fs.mkdir(dirPath, { recursive: true });
    }
  }

  async log(level, eventType, message, metadata = {}) {
    const entry = super.log(level, eventType, message, metadata);

    if (this.#filePath && this.#fs) {
      const line = JSON.stringify(entry) + "\n";
      try {
        await this.#fs.appendFile(this.#filePath, line, "utf8");
      } catch (err) {
        // Log to console if file write fails
        console.error("Audit log write failed:", err);
      }
    }

    return entry;
  }

  async getEntriesFromFile(filters = {}) {
    if (!this.#filePath || !this.#fs) {
      return [];
    }

    try {
      const data = await this.#fs.readFile(this.#filePath, "utf8");
      const entries = data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));

      return entries.filter((e) => {
        if (filters.eventType && e.eventType !== filters.eventType) return false;
        if (filters.level != null && e.level !== filters.level) return false;
        if (filters.startTime != null && e.timestamp < filters.startTime) return false;
        if (filters.endTime != null && e.timestamp > filters.endTime) return false;
        return true;
      });
    } catch (err) {
      return [];
    }
  }
}

/**
 * Create audit log instance
 */
export function createAuditLog(options = {}) {
  const backend = options.backend || "memory";

  if (backend === "memory") {
    return new AuditLog(options);
  }

  if (backend === "file") {
    return new FileAuditLog(options);
  }

  throw new Error(`Unknown audit log backend: ${backend}`);
}

export { LOG_LEVELS, EVENT_TYPES };
