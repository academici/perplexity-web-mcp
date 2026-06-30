import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mergeConfig } from "../src/config.ts";
import { resolvePool } from "../src/pool.ts";
import { probeAlive } from "../src/daemon/bind.ts";
import { createDaemonDispatcher } from "../src/daemon/client.ts";
import type { SearchResult } from "../src/search.ts";

// Live, browser-driven smoke test for the exact concern raised about v1.3.0:
// when several searches run at once, does each tab read ITS OWN answer, or can a
// newly-opened/focus-stealing tab cross-contaminate or drop a sibling's read?
//
// It is OFF by default (it launches a real headful Chromium and hits the live
// perplexity.ai) — run it deliberately:
//
//   npm run build && PPLX_SMOKE=1 npm test
//
// It spins up a daemon on an ISOLATED pool (its own socket + throwaway profile),
// so it never touches the live "default" pool your agents use. A logged-in
// session is not required — the isolation assertions hold for anonymous answers
// too; login just yields richer text.
const RUN = !!process.env.PPLX_SMOKE;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("concurrent searches stay isolated per tab (no cross-read, no dropped read)",
  { skip: !RUN, timeout: 240_000 },
  async () => {
    const entry = path.join(repoRoot, "dist", "daemon", "main.js");
    assert.ok(existsSync(entry), `daemon entry missing — run "npm run build" first (${entry})`);

    // Unique pool name => derived socket + profile are isolated from "default".
    const poolName = `smoke-${process.pid}-${Date.now()}`;
    const pool = resolvePool(mergeConfig(null), poolName, process.env, repoRoot);

    // Own the daemon process here (production spawns it detached+unref'd, which
    // we couldn't clean up) so the finally block can SIGTERM it.
    const child: ChildProcess = spawn(process.execPath, [entry, `--pool=${poolName}`], {
      stdio: "ignore",
    });

    try {
      // Wait for the daemon to bind its socket before firing requests, so the
      // dispatcher connects to THIS child instead of racing to spawn a second.
      const upBy = Date.now() + 45_000;
      while (!(await probeAlive(pool.socketPath))) {
        assert.ok(child.exitCode === null, `daemon exited early (code ${child.exitCode})`);
        assert.ok(Date.now() < upBy, "daemon did not start within 45s");
        await sleep(250);
      }

      const dispatcher = createDaemonDispatcher(pool, entry, [`--pool=${poolName}`]);

      // Distinct queries with distinct, unmistakable answer tokens. maxConcurrency
      // defaults to 3, so all three run simultaneously in three sibling tabs.
      const cases: Array<{ q: string; expect: RegExp }> = [
        { q: "What is the capital of Japan? Answer in one short sentence.", expect: /tokyo/i },
        { q: "What is the chemical symbol for gold? Answer in one short sentence.", expect: /\bAu\b|gold/i },
        { q: "What is the largest planet in our solar system? Answer in one short sentence.", expect: /jupiter/i },
      ];

      const results = await Promise.all(
        cases.map((c) => dispatcher.search(c.q) as Promise<SearchResult>),
      );

      // 1) No dropped/lost read: every tab produced a non-empty answer.
      results.forEach((r, i) =>
        assert.ok(r.answer && r.answer.trim().length > 0, `case ${i} returned an empty answer`));

      // 2) Right tab -> right query: each answer matches ITS OWN expected token.
      results.forEach((r, i) =>
        assert.match(r.answer, cases[i].expect,
          `case ${i} ("${cases[i].q}") answer did not match ${cases[i].expect} — possible cross-tab read`));

      // 3) No cross-read: the three answers are pairwise distinct. Two identical
      //    answers would mean two tabs read the same page (focus-stealing bug).
      const norm = results.map((r) => r.answer.replace(/\s+/g, " ").trim().toLowerCase());
      for (let i = 0; i < norm.length; i++) {
        for (let j = i + 1; j < norm.length; j++) {
          assert.notEqual(norm[i], norm[j],
            `answers ${i} and ${j} are identical — tabs cross-read the same page`);
        }
      }
    } finally {
      child.kill("SIGTERM");
      try { rmSync(pool.profileDir, { recursive: true, force: true }); } catch {}
    }
  });
