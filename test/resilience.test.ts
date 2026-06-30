import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, rmSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getResilience, mergeConfig, DEFAULT_RESILIENCE } from "../src/config.ts";
import { isRetryable, backoffDelay, errorCodeOf, withResilience } from "../src/resilience.ts";
import { DispatcherError, type Dispatcher } from "../src/dispatcher.ts";
import type { SearchResult } from "../src/search.ts";

const OK: SearchResult = { answer: "ok", sources: [] };

function tmpLog(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "pplx-resil-"));
  return path.join(dir, "errors.jsonl");
}

// Build a context with retries fast (1ms base) and notify off, error log to a temp file.
function ctx(logPath: string, attempts = 3) {
  return {
    cfg: {
      retry: { attempts, baseDelayMs: 1, maxDelayMs: 4, retryableCodes: ["TIMEOUT", "INTERNAL", "BROWSER_BUSY"] as const },
      notify: { enabled: false },
      errorLog: { enabled: true, path: logPath },
    },
    pool: "default",
    project: { name: "demo", path: "/tmp/demo" },
    env: {} as NodeJS.ProcessEnv,
  };
}

// A dispatcher whose search() throws `err` the first `failTimes` calls, then returns OK.
function flaky(err: Error, failTimes: number): { d: Dispatcher; calls: () => number } {
  let calls = 0;
  const d: Dispatcher = {
    search: async () => {
      calls++;
      if (calls <= failTimes) throw err;
      return OK;
    },
    searchAdvanced: async () => OK,
    searchDeep: async () => OK,
    login: async () => {
      calls++;
      throw err;
    },
  };
  return { d, calls: () => calls };
}

test("backoffDelay grows exponentially and caps at maxDelayMs", () => {
  const cfg = { attempts: 5, baseDelayMs: 1000, maxDelayMs: 8000, retryableCodes: [] as never[] };
  assert.equal(backoffDelay(1, cfg), 1000);
  assert.equal(backoffDelay(2, cfg), 2000);
  assert.equal(backoffDelay(3, cfg), 4000);
  assert.equal(backoffDelay(4, cfg), 8000); // would be 8000
  assert.equal(backoffDelay(5, cfg), 8000); // capped
});

test("isRetryable only matches configured codes", () => {
  const cfg = DEFAULT_RESILIENCE.retry;
  assert.equal(isRetryable("TIMEOUT", cfg), true);
  assert.equal(isRetryable("INTERNAL", cfg), true);
  assert.equal(isRetryable("BROWSER_BUSY", cfg), true);
  assert.equal(isRetryable("LOGIN_REQUIRED", cfg), false);
  assert.equal(isRetryable("PROTOCOL_MISMATCH", cfg), false);
});

test("errorCodeOf falls back to INTERNAL for non-DispatcherError", () => {
  assert.equal(errorCodeOf(new DispatcherError("TIMEOUT", "x")), "TIMEOUT");
  assert.equal(errorCodeOf(new Error("plain")), "INTERNAL");
});

test("getResilience: env kill-switches and RETRIES override", () => {
  const cfg = mergeConfig(null);
  assert.equal(getResilience(cfg, {}).notify.enabled, true);
  assert.equal(getResilience(cfg, { PERPLEXITY_WEB_MCP_NOTIFY: "0" }).notify.enabled, false);
  assert.equal(getResilience(cfg, { PERPLEXITY_WEB_MCP_ERRORLOG: "off" }).errorLog.enabled, false);
  assert.equal(getResilience(cfg, { PERPLEXITY_WEB_MCP_RETRIES: "5" }).retry.attempts, 5);
});

test("withResilience retries a transient error then succeeds (no log written)", async () => {
  const logPath = tmpLog();
  const { d, calls } = flaky(new DispatcherError("TIMEOUT", "transient"), 2);
  const r = withResilience(d, ctx(logPath, 3));
  const res = await r.search("q");
  assert.deepEqual(res, OK);
  assert.equal(calls(), 3); // 2 failures + 1 success
  assert.throws(() => readFileSync(logPath, "utf-8")); // no error log file created
});

test("withResilience does NOT retry a non-retryable error and logs it", async () => {
  const logPath = tmpLog();
  const { d, calls } = flaky(new DispatcherError("LOGIN_REQUIRED", "login needed"), 99);
  const r = withResilience(d, ctx(logPath, 3));
  await assert.rejects(() => r.search("hello world"), /login needed/);
  assert.equal(calls(), 1); // not retried
  const line = JSON.parse(readFileSync(logPath, "utf-8").trim());
  assert.equal(line.code, "LOGIN_REQUIRED");
  assert.equal(line.tool, "search");
  assert.equal(line.project, "demo");
  assert.equal(line.query, "hello world");
  assert.equal(line.attempts, 3);
  rmSync(path.dirname(logPath), { recursive: true, force: true });
});

test("withResilience exhausts retries on a retryable error then logs", async () => {
  const logPath = tmpLog();
  const { d, calls } = flaky(new DispatcherError("TIMEOUT", "still timing out"), 99);
  const r = withResilience(d, ctx(logPath, 3));
  await assert.rejects(() => r.search("q"), /still timing out/);
  assert.equal(calls(), 3); // all attempts used
  const line = JSON.parse(readFileSync(logPath, "utf-8").trim());
  assert.equal(line.code, "TIMEOUT");
  assert.equal(line.attempts, 3);
  rmSync(path.dirname(logPath), { recursive: true, force: true });
});

test("login is never retried even on a retryable code", async () => {
  const logPath = tmpLog();
  const { d, calls } = flaky(new DispatcherError("INTERNAL", "boom"), 99);
  const r = withResilience(d, ctx(logPath, 3));
  await assert.rejects(() => r.login(), /boom/);
  assert.equal(calls(), 1); // login forced to a single attempt
  const line = JSON.parse(readFileSync(logPath, "utf-8").trim());
  assert.equal(line.tool, "login");
  assert.equal(line.attempts, 1);
  rmSync(path.dirname(logPath), { recursive: true, force: true });
});
