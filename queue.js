// FIFO slot queue with a concurrency limit and three priority levels.
// Pure logic, no OpenClaw imports, so it can be unit-tested on its own.

export const PRIORITY = { foreground: 0, normal: 1, background: 2 };

export class SlotQueue {
  constructor({ limit = 1 } = {}) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(`limit must be a positive integer, got ${limit}`);
    }
    this.limit = limit;
    this.active = 0;
    this.waiting = []; // { priority, seq, resolve, signal, onAbort }
    this.seq = 0;
  }

  get stats() {
    return { limit: this.limit, active: this.active, waiting: this.waiting.length };
  }

  /**
   * Wait for a slot. Resolves with a release function (safe to call more than
   * once), or with null if `signal` aborts before a slot is granted.
   */
  acquire({ signal, priority = PRIORITY.normal } = {}) {
    if (signal?.aborted) return Promise.resolve(null);
    if (this.active < this.limit && this.waiting.length === 0) {
      this.active += 1;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise((resolve) => {
      const entry = { priority, seq: this.seq++, resolve, signal, onAbort: null };
      if (signal) {
        entry.onAbort = () => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) {
            this.waiting.splice(index, 1);
            resolve(null);
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.waiting.push(entry);
    });
  }

  #makeRelease() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.#drain();
    };
  }

  #drain() {
    while (this.active < this.limit && this.waiting.length > 0) {
      // Lowest priority number first, then oldest.
      let best = 0;
      for (let i = 1; i < this.waiting.length; i += 1) {
        const a = this.waiting[i];
        const b = this.waiting[best];
        if (a.priority < b.priority || (a.priority === b.priority && a.seq < b.seq)) best = i;
      }
      const [entry] = this.waiting.splice(best, 1);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener("abort", entry.onAbort);
      }
      this.active += 1;
      entry.resolve(this.#makeRelease());
    }
  }
}

/**
 * Wrap an OpenClaw StreamFn so calls go through `queue`.
 * The slot is held from just before the request is sent until the returned
 * stream's result settles (success, error or abort).
 */
export function wrapStreamWithQueue(inner, queue, options = {}) {
  const {
    priority = PRIORITY.normal,
    holdAfterAbortMs = 0,
    maxHoldMs = 20 * 60 * 1000,
    log = () => {},
    timers = { setTimeout, clearTimeout },
  } = options;

  return async (model, context, streamOptions) => {
    const signal = streamOptions?.signal;
    const queuedAt = Date.now();
    const release = await queue.acquire({ signal, priority });
    if (!release) {
      // Aborted while waiting. Hand off to the transport, which reports the
      // abort through the stream protocol. No slot is held.
      log("aborted while queued", { waitedMs: Date.now() - queuedAt });
      return inner(model, context, streamOptions);
    }
    const waitedMs = Date.now() - queuedAt;
    if (waitedMs > 50) log("request waited for a slot", { waitedMs, ...queue.stats });

    let stream;
    try {
      stream = await inner(model, context, streamOptions);
    } catch (error) {
      release();
      throw error;
    }

    let finished = false;
    let safety;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (safety) timers.clearTimeout(safety);
      if (signal?.aborted && holdAfterAbortMs > 0) {
        // The upstream may still count an abandoned request for a while.
        const t = timers.setTimeout(release, holdAfterAbortMs);
        t?.unref?.();
      } else {
        release();
      }
    };
    safety = timers.setTimeout(() => {
      log("slot released by safety timer", { maxHoldMs });
      finish();
    }, maxHoldMs);
    safety?.unref?.();

    const settled =
      stream && typeof stream.result === "function"
        ? Promise.resolve().then(() => stream.result())
        : Promise.resolve();
    settled.then(finish, finish);
    return stream;
  };
}
