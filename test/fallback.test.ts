import { test } from "node:test";
import assert from "node:assert/strict";
import { createFallbackDispatcher } from "../src/daemon/fallback.ts";
import { DaemonStartingError, DaemonUnavailableError } from "../src/daemon/client.ts";
import { DispatcherError, type Dispatcher } from "../src/dispatcher.ts";
import type { SearchResult } from "../src/search.ts";

function result(answer: string): SearchResult {
  return { answer, sources: [] };
}

function makeDispatcher(searchFn: (query: string) => Promise<SearchResult>): Dispatcher {
  return {
    search: searchFn,
    searchAdvanced: (query) => searchFn(query),
    searchDeep: (query) => searchFn(query),
    login: async () => "ok",
  };
}

test("fallback router: retries daemon after a temporary unavailable error", async () => {
  let daemonCalls = 0;
  let legacyCalls = 0;

  const daemon = makeDispatcher(async () => {
    daemonCalls++;
    if (daemonCalls === 1) throw new DaemonUnavailableError("temporary connect failure");
    return result("daemon");
  });
  const legacy = makeDispatcher(async () => {
    legacyCalls++;
    return result("legacy");
  });

  const routed = createFallbackDispatcher({
    poolName: "default",
    socketPath: "/tmp/pplx-fallback.sock",
    daemon,
    createLegacy: async () => legacy,
    socketExists: () => false,
    probeDaemonAlive: async () => false,
    retryDaemonAfterMs: 0,
  });

  const first = await routed.search("q1");
  const second = await routed.search("q2");
  assert.equal(first.answer, "legacy");
  assert.equal(second.answer, "daemon");
  assert.equal(daemonCalls, 2, "daemon is retried on the next request");
  assert.equal(legacyCalls, 1, "legacy is used only for the failed request");
});

test("fallback router: blocks legacy when pool socket is present", async () => {
  let legacyCalls = 0;
  const daemon = makeDispatcher(async () => {
    throw new DaemonUnavailableError("hello timeout");
  });
  const legacy = makeDispatcher(async () => {
    legacyCalls++;
    return result("legacy");
  });

  const routed = createFallbackDispatcher({
    poolName: "default",
    socketPath: "/run/user/1000/perplexity-web-mcp/default.sock",
    daemon,
    createLegacy: async () => legacy,
    socketExists: () => true,
    probeDaemonAlive: async () => false,
  });

  await assert.rejects(
    () => routed.search("q"),
    (e: unknown) =>
      e instanceof DispatcherError &&
      e.code === "PROTOCOL_MISMATCH" &&
      /legacy mode is blocked/i.test(e.message),
  );
  assert.equal(legacyCalls, 0, "legacy must never run while daemon socket exists");
});

test("fallback router: distinguishes daemon-starting state from unreachable", async () => {
  let legacyCalls = 0;
  const daemon = makeDispatcher(async () => {
    throw new DaemonStartingError("daemon booting");
  });
  const legacy = makeDispatcher(async () => {
    legacyCalls++;
    return result("legacy");
  });

  const routed = createFallbackDispatcher({
    poolName: "default",
    socketPath: "/run/user/1000/perplexity-web-mcp/default.sock",
    daemon,
    createLegacy: async () => legacy,
    socketExists: () => false,
    probeDaemonAlive: async () => false,
  });

  await assert.rejects(
    () => routed.search("q"),
    (e: unknown) =>
      e instanceof DispatcherError &&
      e.code === "PROTOCOL_MISMATCH" &&
      /still starting/i.test(e.message),
  );
  assert.equal(legacyCalls, 0, "legacy must stay disabled while daemon is starting");
});
