import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlags,
  mergeConfig,
  resolveMode,
  resolvePoolName,
  getPoolKnobs,
  DEFAULT_POOL_KNOBS,
  type Config,
} from "../src/config.ts";

test("parseFlags reads --key=value and the bare --daemon flag", () => {
  const f = parseFlags(["--pool=research", "--mode=legacy", "--daemon", "--timeout=90", "--config=/x/c.json"]);
  assert.equal(f.pool, "research");
  assert.equal(f.mode, "legacy");
  assert.equal(f.timeout, "90");
  assert.equal(f.config, "/x/c.json");
  assert.equal(f.daemon, true);
});

test("parseFlags defaults: no flags", () => {
  const f = parseFlags([]);
  assert.equal(f.pool, undefined);
  assert.equal(f.daemon, false);
});

test("mergeConfig applies defaults and defaults mode to daemon", () => {
  const c = mergeConfig(null);
  assert.equal(c.mode, "daemon");
  assert.equal(c.defaultPool, "default");
  assert.deepEqual(c.pools, {});
});

test("mergeConfig honors explicit legacy mode and custom defaultPool", () => {
  const c = mergeConfig({ mode: "legacy", defaultPool: "research", pools: { research: {} } });
  assert.equal(c.mode, "legacy");
  assert.equal(c.defaultPool, "research");
});

test("mergeConfig coerces unknown mode to daemon", () => {
  const c = mergeConfig({ mode: "weird" as unknown as Config["mode"] });
  assert.equal(c.mode, "daemon");
});

const baseConfig = (): Config => mergeConfig(null);

test("resolveMode precedence: CLI > env > config", () => {
  const cfg = mergeConfig({ mode: "legacy" });
  assert.equal(resolveMode(parseFlags(["--mode=daemon"]), {}, cfg), "daemon");
  assert.equal(resolveMode(parseFlags([]), { PERPLEXITY_WEB_MCP_MODE: "daemon" }, cfg), "daemon");
  assert.equal(resolveMode(parseFlags([]), {}, cfg), "legacy");
  assert.equal(resolveMode(parseFlags([]), {}, baseConfig()), "daemon");
});

test("resolvePoolName precedence: CLI > env > config.defaultPool > 'default'", () => {
  const cfg = mergeConfig({ defaultPool: "fromcfg" });
  assert.equal(resolvePoolName(parseFlags(["--pool=cli"]), { PERPLEXITY_WEB_MCP_POOL: "env" }, cfg), "cli");
  assert.equal(resolvePoolName(parseFlags([]), { PERPLEXITY_WEB_MCP_POOL: "env" }, cfg), "env");
  assert.equal(resolvePoolName(parseFlags([]), {}, cfg), "fromcfg");
  assert.equal(resolvePoolName(parseFlags([]), {}, baseConfig()), "default");
});

test("getPoolKnobs returns built-in defaults for an unknown pool", () => {
  const k = getPoolKnobs(baseConfig(), "missing");
  assert.equal(k.maxConcurrency, DEFAULT_POOL_KNOBS.maxConcurrency);
  assert.equal(k.idleShutdownMs, DEFAULT_POOL_KNOBS.idleShutdownMs);
  assert.deepEqual(k.saturation, { mode: "hybrid", waitMs: 30_000 });
  assert.equal(k.socketPath, "");
  assert.equal(k.profileDir, "");
});

test("getPoolKnobs merges a partial pool entry over defaults", () => {
  const cfg = mergeConfig({
    pools: { research: { maxConcurrency: 5, saturation: { mode: "queue" }, profileDir: "/p" } },
  });
  const k = getPoolKnobs(cfg, "research");
  assert.equal(k.maxConcurrency, 5);
  assert.equal(k.profileDir, "/p");
  assert.equal(k.saturation.mode, "queue");
  // waitMs falls back to the default since only mode was overridden
  assert.equal(k.saturation.waitMs, 30_000);
  // untouched knobs keep defaults
  assert.equal(k.idleShutdownMs, DEFAULT_POOL_KNOBS.idleShutdownMs);
});
