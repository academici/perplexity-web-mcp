import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { acquireSocket, probeAlive } from "../src/daemon/bind.ts";

test("acquireSocket: exactly one of two racers binds; the other sees a live peer", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-bind-"));
  const sockPath = path.join(dir, "race.sock");
  const s1 = net.createServer(() => {});
  const s2 = net.createServer(() => {});
  try {
    const [r1, r2] = await Promise.all([
      acquireSocket(s1, sockPath),
      acquireSocket(s2, sockPath),
    ]);
    const winners = [r1, r2].filter((r) => r !== null);
    const losers = [r1, r2].filter((r) => r === null);
    assert.equal(winners.length, 1, "exactly one winner");
    assert.equal(losers.length, 1, "exactly one loser");
    assert.equal(await probeAlive(sockPath), true, "winner is accepting connections");
  } finally {
    s1.close();
    s2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("acquireSocket: removes a stale socket leftover and binds", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-stale-"));
  const sockPath = path.join(dir, "stale.sock");
  writeFileSync(sockPath, ""); // crash leftover: a file at the socket path, no listener
  const s = net.createServer(() => {});
  try {
    const r = await acquireSocket(s, sockPath);
    assert.notEqual(r, null, "bound after clearing the stale file");
    assert.equal(await probeAlive(sockPath), true);
  } finally {
    s.close();
    if (existsSync(sockPath)) rmSync(sockPath, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeAlive returns false for a path with no server", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-dead-"));
  const sockPath = path.join(dir, "nobody.sock");
  try {
    assert.equal(await probeAlive(sockPath, 300), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
