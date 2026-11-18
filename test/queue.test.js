import assert from "node:assert/strict";
import { test } from "node:test";
import { PRIORITY, SlotQueue, wrapStreamWithQueue } from "../queue.js";

const tick = () => new Promise((r) => setImmediate(r));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
// A fake provider stream whose result() settles when we say so.
function fakeInner(log) {
  const calls = [];
  const inner = (model) => {
    const d = deferred();
    calls.push({ model, d });
    log.push(`start:${model}`);
    return { result: () => d.promise };
  };
  return { inner, calls };
}

test("limit 1 runs requests one at a time, in FIFO order", async () => {
  const q = new SlotQueue({ limit: 1 });
  const log = [];
  const { inner, calls } = fakeInner(log);
  const wrapped = wrapStreamWithQueue(inner, q);
  const a = wrapped("a"); const b = wrapped("b"); const c = wrapped("c");
  await tick();
  assert.deepEqual(log, ["start:a"]);
  assert.deepEqual(q.stats, { limit: 1, active: 1, waiting: 2 });
  await a; calls[0].d.resolve("done"); await tick(); await tick();
  assert.deepEqual(log, ["start:a", "start:b"]);
  await b; calls[1].d.resolve("done"); await tick(); await tick();
  assert.deepEqual(log, ["start:a", "start:b", "start:c"]);
  await c; calls[2].d.resolve("done"); await tick(); await tick();
  assert.deepEqual(q.stats, { limit: 1, active: 0, waiting: 0 });
});

test("slot is released when the stream result rejects", async () => {
  const q = new SlotQueue({ limit: 1 });
  const log = [];
  const { inner, calls } = fakeInner(log);
  const wrapped = wrapStreamWithQueue(inner, q);
  const a = wrapped("a"); const b = wrapped("b");
  await a; calls[0].d.reject(new Error("boom")); await tick(); await tick();
  await b;
  assert.deepEqual(log, ["start:a", "start:b"]);
});

test("slot is released when inner throws before returning a stream", async () => {
  const q = new SlotQueue({ limit: 1 });
  const wrapped = wrapStreamWithQueue(() => { throw new Error("sync fail"); }, q);
  await assert.rejects(wrapped("a"), /sync fail/);
  assert.equal(q.stats.active, 0);
});

test("limit 2 allows two at once and queues the third", async () => {
  const q = new SlotQueue({ limit: 2 });
  const log = [];
  const { inner, calls } = fakeInner(log);
  const wrapped = wrapStreamWithQueue(inner, q);
  wrapped("a"); wrapped("b"); wrapped("c");
  await tick();
  assert.deepEqual(log, ["start:a", "start:b"]);
  calls[0].d.resolve(); await tick(); await tick();
  assert.deepEqual(log, ["start:a", "start:b", "start:c"]);
});

test("abort while queued leaves the queue and does not take a slot", async () => {
  const q = new SlotQueue({ limit: 1 });
  const log = [];
  const { inner, calls } = fakeInner(log);
  const wrapped = wrapStreamWithQueue(inner, q);
  wrapped("a");
  const ac = new AbortController();
  const b = wrapped("b", {}, { signal: ac.signal });
  await tick();
  assert.equal(q.stats.waiting, 1);
  ac.abort();
  await b; // handed to the transport without a slot
  assert.deepEqual(log, ["start:a", "start:b"]);
  assert.deepEqual(q.stats, { limit: 1, active: 1, waiting: 0 });
  calls[0].d.resolve(); await tick(); await tick();
  assert.equal(q.stats.active, 0);
});

test("foreground requests go ahead of background ones", async () => {
  const q = new SlotQueue({ limit: 1 });
  const order = [];
  const first = await q.acquire();
  q.acquire({ priority: PRIORITY.background }).then((r) => { order.push("background"); r(); });
  q.acquire({ priority: PRIORITY.normal }).then((r) => { order.push("normal"); r(); });
  q.acquire({ priority: PRIORITY.foreground }).then((r) => { order.push("foreground"); r(); });
  first();
  await tick(); await tick(); await tick(); await tick();
  assert.deepEqual(order, ["foreground", "normal", "background"]);
});

test("after an abort, the slot is held for holdAfterAbortMs", async () => {
  const q = new SlotQueue({ limit: 1 });
  const log = [];
  const { inner, calls } = fakeInner(log);
  const timersLog = [];
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; timersLog.push(t); return t; },
    clearTimeout: () => {},
  };
  const wrapped = wrapStreamWithQueue(inner, q, { holdAfterAbortMs: 5000, timers });
  const ac = new AbortController();
  await wrapped("a", {}, { signal: ac.signal });
  wrapped("b");
  ac.abort();
  calls[0].d.resolve("aborted"); await tick(); await tick();
  assert.deepEqual(log, ["start:a"], "b must still be waiting during the hold");
  const hold = timersLog.find((t) => t.ms === 5000);
  assert.ok(hold, "a 5000 ms hold timer was scheduled");
  hold.fn(); await tick(); await tick();
  assert.deepEqual(log, ["start:a", "start:b"]);
});

test("release is idempotent and the safety timer frees a stuck slot", async () => {
  const q = new SlotQueue({ limit: 1 });
  const timersLog = [];
  const timers = {
    setTimeout: (fn, ms) => { const t = { fn, ms }; timersLog.push(t); return t; },
    clearTimeout: () => {},
  };
  const never = () => ({ result: () => new Promise(() => {}) });
  const wrapped = wrapStreamWithQueue(never, q, { maxHoldMs: 1000, timers });
  await wrapped("a");
  assert.equal(q.stats.active, 1);
  timersLog.find((t) => t.ms === 1000).fn();
  timersLog.find((t) => t.ms === 1000).fn();
  assert.equal(q.stats.active, 0);
});

test("rejects an invalid limit", () => {
  assert.throws(() => new SlotQueue({ limit: 0 }));
  assert.throws(() => new SlotQueue({ limit: 1.5 }));
});
