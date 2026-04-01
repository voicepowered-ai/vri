import { test } from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { JsonlStorage, MemoryStorage, MongoDbStorage, createStorage } from "../src/storage.js";

function getTempFilePath(name) {
  return path.join(os.tmpdir(), `vri-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.jsonl`);
}

test("JsonlStorage basic operations", async (t) => {
  const filePath = getTempFilePath("test-storage");
  const storage = new JsonlStorage({ filePath });
  await storage.initialize();

  t.after(async () => {
    await fs.rm(filePath, { force: true });
  });

  const record1 = { event_id: "evt_1", data: "test" };
  const record2 = { event_id: "evt_2", data: "test2" };

  await storage.append(record1);
  await storage.append(record2);

  const all = await storage.getAll();
  assert.equal(all.length, 2);
  assert.deepEqual(all[0], record1);
  assert.deepEqual(all[1], record2);

  const byId = await storage.getById("evt_1");
  assert.deepEqual(byId, record1);

  const batch = await storage.getByIdBatch(["evt_1", "evt_2", "evt_3"]);
  assert.equal(batch.length, 3);
  assert.deepEqual(batch[0], record1);
  assert.deepEqual(batch[1], record2);
  assert.equal(batch[2], null);

  await storage.close();
});

test("MemoryStorage basic operations", async (t) => {
  const storage = new MemoryStorage();
  await storage.initialize();

  const record1 = { event_id: "evt_1", data: "test" };
  const record2 = { event_id: "evt_2", data: "test2" };

  await storage.append(record1);
  await storage.append(record2);

  const all = await storage.getAll();
  assert.equal(all.length, 2);

  const byId = await storage.getById("evt_1");
  assert.deepEqual(byId, record1);

  await storage.close();
});

test("createStorage factory for jsonl", async (t) => {
  const storage = createStorage({ backend: "jsonl", filePath: getTempFilePath("factory-test") });
  assert(storage instanceof JsonlStorage);
});

test("createStorage factory for memory", async (t) => {
  const storage = createStorage({ backend: "memory" });
  assert(storage instanceof MemoryStorage);
});

test("createStorage factory rejects unknown backend", async (t) => {
  assert.throws(() => {
    createStorage({ backend: "unknown" });
  }, /Unknown storage backend/);
});

test("MemoryStorage replaceAll supports custom id field", async () => {
  const storage = new MemoryStorage({ idField: "batch_id" });
  await storage.initialize();

  await storage.replaceAll([
    { batch_id: "batch_1", value: 1 },
    { batch_id: "batch_2", value: 2 }
  ]);

  const byId = await storage.getById("batch_2");
  assert.equal(byId.value, 2);
});

test("JsonlStorage replaceAll rewrites file contents", async () => {
  const filePath = getTempFilePath("jsonl-rewrite-test");
  const storage = new JsonlStorage({ filePath, idField: "batch_id" });
  await storage.initialize();

  await storage.append({ batch_id: "batch_old", value: 0 });
  await storage.replaceAll([
    { batch_id: "batch_new", value: 1 }
  ]);

  const all = await storage.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].batch_id, "batch_new");

  await fs.rm(filePath, { force: true });
});

function createFakeMongoDb() {
  const collections = new Map();

  function ensureCollection(name) {
    if (!collections.has(name)) {
      collections.set(name, []);
    }
    return collections.get(name);
  }

  function matches(query, doc) {
    if (!query || Object.keys(query).length === 0) {
      return true;
    }

    for (const [key, value] of Object.entries(query)) {
      if (value && typeof value === "object" && "$in" in value) {
        if (!value.$in.includes(doc[key])) {
          return false;
        }
      } else if (doc[key] !== value) {
        return false;
      }
    }

    return true;
  }

  return {
    collection(name) {
      return {
        async createIndex() {
          return;
        },
        async insertOne(doc) {
          ensureCollection(name).push({ ...doc });
        },
        async insertMany(docs) {
          ensureCollection(name).push(...docs.map((doc) => ({ ...doc })));
        },
        find(query = {}) {
          const docs = ensureCollection(name).filter((doc) => matches(query, doc));
          return {
            sort(sortSpec = {}) {
              const entries = Object.entries(sortSpec);
              const sorted = [...docs];

              if (entries.length > 0) {
                const [field, direction] = entries[0];
                sorted.sort((a, b) => {
                  const aValue = a[field];
                  const bValue = b[field];
                  if (aValue < bValue) return direction < 0 ? 1 : -1;
                  if (aValue > bValue) return direction < 0 ? -1 : 1;
                  return 0;
                });
              }

              return {
                async toArray() {
                  return sorted.map((doc) => {
                    const { _id, ...rest } = doc;
                    return rest;
                  });
                }
              };
            },
            async toArray() {
              return docs.map((doc) => {
                const { _id, ...rest } = doc;
                return rest;
              });
            }
          };
        },
        async findOne(query = {}) {
          const found = ensureCollection(name).find((doc) => matches(query, doc));
          if (!found) {
            return null;
          }
          const { _id, ...rest } = found;
          return rest;
        },
        async deleteMany() {
          collections.set(name, []);
        }
      };
    }
  };
}

test("MongoDbStorage supports idField and replaceAll", async () => {
  const fakeDb = createFakeMongoDb();
  const fakeClient = { close: async () => {} };
  const storage = new MongoDbStorage({
    client: fakeClient,
    db: fakeDb,
    collectionName: "vri_batches",
    idField: "batch_id"
  });

  await storage.initialize();
  await storage.append({ batch_id: "batch_1", created_at: 1, root_hash: "0x1" });
  await storage.append({ batch_id: "batch_2", created_at: 2, root_hash: "0x2" });

  const before = await storage.getAll();
  assert.equal(before.length, 2);

  await storage.replaceAll([{ batch_id: "batch_3", created_at: 3, root_hash: "0x3" }]);

  const all = await storage.getAll();
  assert.equal(all.length, 1);
  assert.equal(all[0].batch_id, "batch_3");

  const byId = await storage.getById("batch_3");
  assert.equal(byId.root_hash, "0x3");
});
