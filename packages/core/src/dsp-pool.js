/**
 * DSP Worker Pool
 *
 * Manages a pool of Worker Threads running dsp-worker.js.
 * Offloads CPU-intensive audio canonicalization to worker threads,
 * keeping the main event loop responsive.
 *
 * Usage:
 *   import { createDspPool } from "@vri/core/dsp-pool";
 *   const pool = createDspPool({ size: 2 });
 *   const canonical = await pool.canonicalize(wavBuffer);
 *   await pool.terminate();
 */

import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const WORKER_PATH = fileURLToPath(new URL("./dsp-worker.js", import.meta.url));
class DspWorker {
  #worker;
  #pending = new Map();
  #idle = true;

  constructor() {
    this.#worker = new Worker(WORKER_PATH);
    this.#worker.on("message", ({ id, result, error }) => {
      const { resolve, reject } = this.#pending.get(id) ?? {};
      this.#pending.delete(id);
      this.#idle = true;

      if (error) {
        reject?.(new Error(error));
      } else {
        resolve?.(Buffer.from(result));
      }
    });
    this.#worker.on("error", (err) => {
      for (const { reject } of this.#pending.values()) {
        reject(err);
      }
      this.#pending.clear();
      this.#idle = true;
    });
  }

  get idle() {
    return this.#idle;
  }

  send(op, buffer) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      this.#idle = false;
      this.#pending.set(id, { resolve, reject });

      // Transfer the underlying ArrayBuffer to avoid copying
      const ab = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      this.#worker.postMessage({ op, id, payload: ab }, [ab]);
    });
  }

  terminate() {
    return this.#worker.terminate();
  }
}

export class DspPool {
  #workers;
  #queue = [];

  constructor({ size = 1 } = {}) {
    this.#workers = Array.from({ length: Math.max(1, size) }, () => new DspWorker());
  }

  #dispatch(op, buffer) {
    const idle = this.#workers.find((w) => w.idle);
    if (idle) {
      return idle.send(op, buffer);
    }

    // All workers busy — queue the task
    return new Promise((resolve, reject) => {
      this.#queue.push({ op, buffer, resolve, reject });
    });
  }

  #drainQueue() {
    while (this.#queue.length > 0) {
      const idle = this.#workers.find((w) => w.idle);
      if (!idle) break;

      const { op, buffer, resolve, reject } = this.#queue.shift();
      idle.send(op, buffer).then(resolve).catch(reject);
    }
  }

  async canonicalize(wavBuffer) {
    const result = await this.#dispatch("canonicalize", wavBuffer);
    this.#drainQueue();
    return result;
  }

  async sha256(buffer) {
    const result = await this.#dispatch("sha256", buffer);
    this.#drainQueue();
    return result;
  }

  async terminate() {
    await Promise.all(this.#workers.map((w) => w.terminate()));
  }

  get size() {
    return this.#workers.length;
  }
}

let _sharedPool = null;

/**
 * Returns a module-level shared pool (lazy-initialized, size = CPU count / 2).
 * Suitable for production use. Call terminateSharedPool() on shutdown.
 */
export function getSharedDspPool() {
  if (!_sharedPool) {
    const cpuCount = typeof os.availableParallelism === "function"
      ? os.availableParallelism()
      : os.cpus().length;
    const size = Math.max(1, Math.floor(cpuCount / 2));
    _sharedPool = new DspPool({ size });
  }
  return _sharedPool;
}

export async function terminateSharedPool() {
  if (_sharedPool) {
    await _sharedPool.terminate();
    _sharedPool = null;
  }
}

export function createDspPool(options = {}) {
  return new DspPool(options);
}
