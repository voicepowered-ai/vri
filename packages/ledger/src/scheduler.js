/**
 * Background scheduler for batch anchoring with retry policy
 * Manages async publication to external anchors with exponential backoff
 */

import crypto from 'node:crypto';

export const SCHEDULER_STATES = {
  PENDING: 'pending',
  PUBLISHING: 'publishing',
  PUBLISHED: 'published',
  FAILED: 'failed',
  PAUSED: 'paused'
};

export const RETRY_CONFIG = {
  maxRetries: 5,
  initialDelayMs: 1000,
  maxDelayMs: 60000,
  backoffMultiplier: 2,
  jitterFactor: 0.1,
  maxQueueSize: 1000
};

function secureJitterUnit() {
  const r = crypto.randomInt(0, 1_000_000) / 999_999;
  return (r * 2) - 1;
}

export class BatchScheduler {
  #queue = [];
  #processing = false;
  #retryMap = new Map(); // batchId -> { count, nextRetryAt }
  #ledger = null;
  #config = RETRY_CONFIG;
  #stateMap = new Map(); // batchId -> state
  #onStateChange = null;

  constructor(ledger, config = {}) {
    this.#ledger = ledger;
    this.#config = { ...RETRY_CONFIG, ...config };
  }

  /**
   * Schedule a batch for publication to external anchor
   * @param {string} batchId - Batch ID to publish
   * @param {object} options - { provider, network, endpoint }
   * @returns {object} { batchId, state, scheduledAt }
   */
  schedule(batchId, options = {}) {
    if (!batchId) {
      throw new Error('batchId is required');
    }

    const existing = this.#queue.find(item => item.batchId === batchId);
    if (existing) {
      return { batchId, state: this.#stateMap.get(batchId) ?? SCHEDULER_STATES.PENDING };
    }

    if (this.#queue.length >= this.#config.maxQueueSize) {
      throw new Error(`Batch scheduler queue is full (max ${this.#config.maxQueueSize} items)`);
    }

    const scheduledItem = {
      batchId,
      options,
      scheduledAt: new Date().toISOString(),
      state: SCHEDULER_STATES.PENDING
    };

    this.#queue.push(scheduledItem);
    this.#stateMap.set(batchId, SCHEDULER_STATES.PENDING);
    this.#notifyStateChange(batchId, SCHEDULER_STATES.PENDING);

    return {
      batchId,
      state: SCHEDULER_STATES.PENDING,
      scheduledAt: scheduledItem.scheduledAt
    };
  }

  /**
   * Start processing queue
   * @param {number} concurrency - Number of concurrent publications
   */
  async start(concurrency = 1) {
    if (this.#processing) {
      return;
    }

    this.#processing = true;
    const workerCount = Math.max(1, Number(concurrency) || 1);

    const workers = Array.from({ length: workerCount }, (_, i) =>
      this.#worker(i)
    );

    await Promise.all(workers);
  }

  /**
   * Stop processing
   */
  stop() {
    this.#processing = false;
  }

  /**
   * Get queue status
   * @returns {object} { queued, publishing, published, failed }
   */
  getStatus() {
    const counts = {
      queued: this.#queue.filter(item => item.state === SCHEDULER_STATES.PENDING).length,
      publishing: this.#queue.filter(item => item.state === SCHEDULER_STATES.PUBLISHING).length,
      published: this.#queue.filter(item => item.state === SCHEDULER_STATES.PUBLISHED).length,
      failed: this.#queue.filter(item => item.state === SCHEDULER_STATES.FAILED).length,
      paused: this.#queue.filter(item => item.state === SCHEDULER_STATES.PAUSED).length
    };

    return {
      ...counts,
      total: this.#queue.length,
      isProcessing: this.#processing
    };
  }

  /**
   * Get batch schedule state
   * @param {string} batchId
   * @returns {string|null}
   */
  getState(batchId) {
    return this.#stateMap.get(batchId) ?? null;
  }

  /**
   * Register state change listener
   * @param {function} callback - Called with (batchId, state)
   */
  onStateChange(callback) {
    this.#onStateChange = callback;
  }

  async #worker(workerId) {
    void workerId;

    while (this.#processing) {
      const now = Date.now();
      const item = this.#queue.find((candidate) => {
        if (candidate.state !== SCHEDULER_STATES.PENDING) {
          return false;
        }

        const retryInfo = this.#retryMap.get(candidate.batchId);
        if (!retryInfo?.nextRetryAt) {
          return true;
        }

        const retryAtMs = Date.parse(retryInfo.nextRetryAt);
        return Number.isFinite(retryAtMs) && retryAtMs <= now;
      });

      if (!item) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      item.state = SCHEDULER_STATES.PUBLISHING;
      this.#stateMap.set(item.batchId, SCHEDULER_STATES.PUBLISHING);
      this.#notifyStateChange(item.batchId, SCHEDULER_STATES.PUBLISHING);

      try {
        await this.#ledger.publishBatchAnchor(item.batchId, item.options);

        item.state = SCHEDULER_STATES.PUBLISHED;
        this.#stateMap.set(item.batchId, SCHEDULER_STATES.PUBLISHED);
        this.#notifyStateChange(item.batchId, SCHEDULER_STATES.PUBLISHED);
        this.#retryMap.delete(item.batchId);
      } catch (error) {
        const retryCount = (this.#retryMap.get(item.batchId)?.count ?? 0) + 1;

        if (retryCount >= this.#config.maxRetries) {
          item.state = SCHEDULER_STATES.FAILED;
          this.#stateMap.set(item.batchId, SCHEDULER_STATES.FAILED);
          this.#notifyStateChange(item.batchId, SCHEDULER_STATES.FAILED, error.message);
          this.#retryMap.delete(item.batchId);
        } else {
          const delay = this.#calculateBackoffDelay(retryCount);
          item.state = SCHEDULER_STATES.PAUSED;
          this.#stateMap.set(item.batchId, SCHEDULER_STATES.PAUSED);
          this.#retryMap.set(item.batchId, {
            count: retryCount,
            nextRetryAt: new Date(Date.now() + delay).toISOString(),
            lastError: error.message
          });
          this.#notifyStateChange(item.batchId, SCHEDULER_STATES.PAUSED, error.message);
          setTimeout(() => {
            if (!this.#processing) {
              return;
            }

            const currentState = this.#stateMap.get(item.batchId);
            if (currentState === SCHEDULER_STATES.PAUSED) {
              item.state = SCHEDULER_STATES.PENDING;
              this.#stateMap.set(item.batchId, SCHEDULER_STATES.PENDING);
              this.#notifyStateChange(item.batchId, SCHEDULER_STATES.PENDING);
            }
          }, Math.max(0, delay));
        }
      }

      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  #calculateBackoffDelay(retryCount) {
    const baseDelay = Math.min(
      this.#config.initialDelayMs * Math.pow(this.#config.backoffMultiplier, retryCount - 1),
      this.#config.maxDelayMs
    );

    const jitter = baseDelay * this.#config.jitterFactor * secureJitterUnit();
    return Math.max(0, baseDelay + jitter);
  }

  #notifyStateChange(batchId, state, error = null) {
    if (this.#onStateChange) {
      this.#onStateChange(batchId, state, error);
    }
  }

  getQueue() {
    return this.#queue.map(item => ({
      batchId: item.batchId,
      state: this.#stateMap.get(item.batchId) ?? item.state,
      scheduledAt: item.scheduledAt,
      retryInfo: this.#retryMap.get(item.batchId) ?? null
    }));
  }

  clear() {
    this.#queue = [];
    this.#retryMap.clear();
    this.#stateMap.clear();
  }
}

export function createBatchScheduler(ledger, config = {}) {
  return new BatchScheduler(ledger, config);
}
