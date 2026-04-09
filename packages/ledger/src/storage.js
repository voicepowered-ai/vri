/**
 * Storage abstraction for VRI Ledger.
 * Supports pluggable backends: JSONL (default), Postgres, MongoDB.
 */

import fs from "node:fs/promises";
import path from "node:path";

/**
 * JSONL file-based storage (default)
 */
export class JsonlStorage {
  filePath;
  #idField;
  #dirPath;

  constructor(options = {}) {
    this.filePath = options.filePath || path.resolve(process.cwd(), "tmp/vri-ledger/events.jsonl");
    this.#idField = options.idField || "event_id";
    this.#dirPath = path.dirname(this.filePath);
  }

  async initialize() {
    await fs.mkdir(this.#dirPath, { recursive: true });
  }

  async append(record) {
    const line = JSON.stringify(record) + "\n";
    await fs.appendFile(this.filePath, line, "utf8");
  }

  async getAll() {
    try {
      const data = await fs.readFile(this.filePath, "utf8");
      return data
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            console.warn(`[vri/ledger] Skipping corrupted record in ${this.filePath}: ${line.substring(0, 80)}`);
            return null;
          }
        })
        .filter((record) => record !== null);
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  }

  async getById(id) {
    const records = await this.getAll();
    return records.find((r) => r[this.#idField] === id) || null;
  }

  async getByIdBatch(ids) {
    const records = await this.getAll();
    return ids.map((id) => records.find((r) => r[this.#idField] === id) || null);
  }

  async replaceAll(records) {
    const content = records.map((record) => JSON.stringify(record)).join("\n");
    await fs.writeFile(this.filePath, content ? `${content}\n` : "", "utf8");
  }

  async close() {
    // No-op for JSONL
  }
}

/**
 * In-memory storage for testing
 */
export class MemoryStorage {
  #records = [];
  #idField;

  constructor(options = {}) {
    this.#idField = options.idField || "event_id";
  }

  async initialize() {
    // No-op
  }

  async append(record) {
    this.#records.push(record);
  }

  async getAll() {
    return JSON.parse(JSON.stringify(this.#records));
  }

  async getById(id) {
    return this.#records.find((r) => r[this.#idField] === id) || null;
  }

  async getByIdBatch(ids) {
    return ids.map((id) => this.#records.find((r) => r[this.#idField] === id) || null);
  }

  async replaceAll(records) {
    this.#records = JSON.parse(JSON.stringify(records));
  }

  async close() {
    // No-op
  }
}

/**
 * PostgreSQL storage adapter (stub for beta)
 */
export class PostgresStorage {
  #pool;
  #tableName;
  #idField;

  constructor(options = {}) {
    this.#pool = options.pool;
    this.#tableName = options.tableName || "vri_events";
    this.#idField = options.idField || "event_id";
    if (!this.#pool) {
      throw new Error("PostgresStorage requires a pg.Pool instance in options.pool");
    }
  }

  async initialize() {
    const client = await this.#pool.connect();
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.#tableName} (
          ${this.#idField} VARCHAR(128) PRIMARY KEY,
          data JSONB NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_created_at ON ${this.#tableName}(created_at);
      `);
    } finally {
      client.release();
    }
  }

  async append(record) {
    const id = record[this.#idField];

    if (typeof id !== "string" || id.length === 0) {
      throw new Error(`PostgresStorage record missing string ${this.#idField}`);
    }

    const data = { ...record };
    delete data[this.#idField];

    await this.#pool.query(
      `INSERT INTO ${this.#tableName} (${this.#idField}, data) VALUES ($1, $2)`,
      [id, JSON.stringify(data)]
    );
  }

  async getAll() {
    const result = await this.#pool.query(`SELECT ${this.#idField}, data FROM ${this.#tableName} ORDER BY created_at ASC`);
    return result.rows.map((row) => ({ [this.#idField]: row[this.#idField], ...row.data }));
  }

  async getById(id) {
    const result = await this.#pool.query(`SELECT ${this.#idField}, data FROM ${this.#tableName} WHERE ${this.#idField} = $1`, [id]);
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    return { [this.#idField]: row[this.#idField], ...row.data };
  }

  async getByIdBatch(ids) {
    if (ids.length === 0) return [];
    const result = await this.#pool.query(
      `SELECT ${this.#idField}, data FROM ${this.#tableName} WHERE ${this.#idField} = ANY($1)`,
      [ids]
    );
    const map = new Map(result.rows.map((row) => [row[this.#idField], { [this.#idField]: row[this.#idField], ...row.data }]));
    return ids.map((id) => map.get(id) || null);
  }

  async replaceAll(records) {
    const client = await this.#pool.connect();

    try {
      await client.query("BEGIN");
      await client.query(`DELETE FROM ${this.#tableName}`);

      for (const record of records) {
        const id = record[this.#idField];
        if (typeof id !== "string" || id.length === 0) {
          throw new Error(`PostgresStorage record missing string ${this.#idField}`);
        }
        const data = { ...record };
        delete data[this.#idField];

        await client.query(
          `INSERT INTO ${this.#tableName} (${this.#idField}, data) VALUES ($1, $2)`,
          [id, JSON.stringify(data)]
        );
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async close() {
    await this.#pool.end();
  }
}

/**
 * MongoDB storage adapter (stub for beta)
 */
export class MongoDbStorage {
  #db;
  #collectionName;
  #idField;
  #manageClient;
  #client;

  constructor(options = {}) {
    this.#client = options.client;
    this.#db = options.db;
    this.#collectionName = options.collectionName || "vri_events";
    this.#idField = options.idField || "event_id";
    this.#manageClient = options.manageClient === true;
    if (!this.#client || !this.#db) {
      throw new Error("MongoDbStorage requires options.client and options.db (MongoClient and Db instances)");
    }
  }

  async initialize() {
    const collection = this.#db.collection(this.#collectionName);
    await collection.createIndex({ [this.#idField]: 1 }, { unique: true });
    await collection.createIndex({ created_at: 1 });
  }

  async append(record) {
    const doc = {
      ...record,
      created_at: new Date(),
    };
    const collection = this.#db.collection(this.#collectionName);
    await collection.insertOne(doc);
  }

  async getAll() {
    const collection = this.#db.collection(this.#collectionName);
    const docs = await collection.find({}, { projection: { _id: 0 } }).sort({ created_at: 1 }).toArray();
    return docs;
  }

  async getById(id) {
    const collection = this.#db.collection(this.#collectionName);
    return await collection.findOne({ [this.#idField]: id }, { projection: { _id: 0 } });
  }

  async getByIdBatch(ids) {
    const collection = this.#db.collection(this.#collectionName);
    const docs = await collection.find({ [this.#idField]: { $in: ids } }, { projection: { _id: 0 } }).toArray();
    const map = new Map(docs.map((doc) => [doc[this.#idField], doc]));
    return ids.map((id) => map.get(id) || null);
  }

  async replaceAll(records) {
    const collection = this.#db.collection(this.#collectionName);
    await collection.deleteMany({});

    if (records.length === 0) {
      return;
    }

    const docs = records.map((record) => ({
      ...record,
      created_at: record.created_at ?? new Date()
    }));

    await collection.insertMany(docs);
  }

  async close() {
    if (this.#manageClient) {
      await this.#client.close();
    }
  }
}

/**
 * Factory to create storage backend
 */
export function createStorage(options = {}) {
  const backend = options.backend || "jsonl";

  if (backend === "jsonl") {
    return new JsonlStorage(options);
  }

  if (backend === "memory") {
    return new MemoryStorage(options);
  }

  if (backend === "postgres") {
    return new PostgresStorage(options);
  }

  if (backend === "mongodb") {
    return new MongoDbStorage(options);
  }

  throw new Error(`Unknown storage backend: ${backend}`);
}
