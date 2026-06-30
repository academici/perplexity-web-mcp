import { test } from "node:test";
import assert from "node:assert/strict";
import { TabPool, type Slot } from "../src/daemon/tabpool.ts";
import { DispatcherError } from "../src/dispatcher.ts";

const sat = (mode: "queue" | "fail-fast" | "hybrid", waitMs = 0) => ({ mode, waitMs });

test("acquire hands out distinct tab indexes up to the cap", async () => {
  const pool = new TabPool(3, sat("queue"));
  const a = await pool.acquire();
  const b = await pool.acquire();
  const c = await pool.acquire();
  assert.deepEqual([a.tabIndex, b.tabIndex, c.tabIndex], [0, 1, 2]);
  assert.equal(pool.active, 3);
});

test("fail-fast rejects with BROWSER_BUSY when saturated", async () => {
  const pool = new TabPool(1, sat("fail-fast"));
  await pool.acquire();
  await assert.rejects(
    () => pool.acquire(),
    (e: unknown) => e instanceof DispatcherError && e.code === "BROWSER_BUSY",
  );
});

test("queue blocks until a slot frees, then resolves FIFO", async () => {
  const pool = new TabPool(1, sat("queue"));
  const first = await pool.acquire();
  let secondResolved = false;
  const secondP = pool.acquire().then((s) => { secondResolved = true; return s; });
  // still blocked
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(secondResolved, false);
  assert.equal(pool.waiting, 1);
  first.release();
  const second = await secondP;
  assert.equal(secondResolved, true);
  assert.equal(second.tabIndex, 1);
});

test("queue preserves FIFO order across multiple waiters", async () => {
  const pool = new TabPool(1, sat("queue"));
  const held = await pool.acquire();
  const order: number[] = [];
  const p1 = pool.acquire().then((s) => { order.push(1); s.release(); });
  const p2 = pool.acquire().then((s) => { order.push(2); s.release(); });
  const p3 = pool.acquire().then((s) => { order.push(3); s.release(); });
  held.release();
  await Promise.all([p1, p2, p3]);
  assert.deepEqual(order, [1, 2, 3]);
});

test("hybrid resolves if a slot frees before the timeout", async () => {
  const pool = new TabPool(1, sat("hybrid", 200));
  const held = await pool.acquire();
  const p = pool.acquire();
  setTimeout(() => held.release(), 20);
  const slot = await p;
  assert.equal(slot.tabIndex, 1);
});

test("hybrid rejects with BROWSER_BUSY after waitMs with no free slot", async () => {
  const pool = new TabPool(1, sat("hybrid", 30));
  await pool.acquire();
  await assert.rejects(
    () => pool.acquire(),
    (e: unknown) => e instanceof DispatcherError && e.code === "BROWSER_BUSY",
  );
  // the timed-out waiter was removed from the queue
  assert.equal(pool.waiting, 0);
});

test("a hybrid waiter that already timed out is skipped when a slot frees", async () => {
  const pool = new TabPool(1, sat("hybrid", 20));
  const held = await pool.acquire();
  const timedOut = pool.acquire();
  await assert.rejects(() => timedOut, (e: unknown) => e instanceof DispatcherError);
  // releasing now must not throw or hand a slot to the dead waiter
  held.release();
  assert.equal(pool.active, 0);
  // a fresh acquire still works
  const fresh = await pool.acquire();
  assert.ok(fresh.tabIndex >= 0);
});

test("double release is a no-op", async () => {
  const pool = new TabPool(2, sat("queue"));
  const s: Slot = await pool.acquire();
  s.release();
  s.release();
  assert.equal(pool.active, 0);
});
