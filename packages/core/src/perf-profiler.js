export class PerfProfiler {
  #metrics = new Map();

  record(name, durationMs) {
    if (!name || !Number.isFinite(durationMs)) {
      return;
    }

    const existing = this.#metrics.get(name) ?? {
      count: 0,
      totalMs: 0,
      minMs: Number.POSITIVE_INFINITY,
      maxMs: 0,
      lastMs: 0
    };

    existing.count += 1;
    existing.totalMs += durationMs;
    existing.minMs = Math.min(existing.minMs, durationMs);
    existing.maxMs = Math.max(existing.maxMs, durationMs);
    existing.lastMs = durationMs;

    this.#metrics.set(name, existing);
  }

  start(name) {
    const startAt = performance.now();
    return () => {
      const duration = performance.now() - startAt;
      this.record(name, duration);
      return duration;
    };
  }

  snapshot() {
    const metrics = {};

    for (const [name, value] of this.#metrics.entries()) {
      metrics[name] = {
        count: value.count,
        avgMs: value.count > 0 ? value.totalMs / value.count : 0,
        totalMs: value.totalMs,
        minMs: Number.isFinite(value.minMs) ? value.minMs : 0,
        maxMs: value.maxMs,
        lastMs: value.lastMs
      };
    }

    return {
      metricCount: this.#metrics.size,
      metrics
    };
  }

  clear() {
    this.#metrics.clear();
  }
}

export function createPerfProfiler() {
  return new PerfProfiler();
}
