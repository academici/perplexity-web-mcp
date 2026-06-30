import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  runtimeDir,
  sanitize,
  deriveEndpointPath,
  deriveProfileDir,
  resolvePool,
} from "../src/pool.ts";
import { mergeConfig } from "../src/config.ts";

test("runtimeDir prefers XDG_RUNTIME_DIR, falls back to tmpdir", () => {
  assert.equal(runtimeDir({ XDG_RUNTIME_DIR: "/run/user/1000" }), "/run/user/1000");
  assert.notEqual(runtimeDir({}), undefined);
});

test("sanitize strips unsafe characters", () => {
  assert.equal(sanitize("default"), "default");
  assert.equal(sanitize("a/b c:d"), "a_b_c_d");
  assert.equal(sanitize(""), "_");
});

test("deriveEndpointPath builds <runtime>/perplexity-web-mcp/<pool>.<ext>", () => {
  const p = deriveEndpointPath("/run/user/1000", "default", "sock");
  assert.equal(p, "/run/user/1000/perplexity-web-mcp/default.sock");
  const l = deriveEndpointPath("/run/user/1000", "default", "log");
  assert.equal(l, "/run/user/1000/perplexity-web-mcp/default.log");
});

test("deriveEndpointPath hashes very long pool names and stays under the limit", () => {
  const longName = "x".repeat(200);
  const p = deriveEndpointPath("/run/user/1000", longName, "sock");
  assert.ok(p.length <= 100, `path too long: ${p.length}`);
  assert.match(path.basename(p), /^p-[0-9a-f]{16}\.sock$/);
  // deterministic
  assert.equal(p, deriveEndpointPath("/run/user/1000", longName, "sock"));
});

test("deriveProfileDir maps 'default' to the legacy profile, others to isolated dirs", () => {
  assert.equal(deriveProfileDir("/repo", "default"), "/repo/.playwright/profile");
  assert.equal(deriveProfileDir("/repo", "research"), "/repo/.playwright/profiles/research");
});

test("resolvePool: same name => same socket/profile (shared daemon)", () => {
  const cfg = mergeConfig(null);
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const a = resolvePool(cfg, "default", env, "/repo");
  const b = resolvePool(cfg, "default", env, "/repo");
  assert.equal(a.socketPath, b.socketPath);
  assert.equal(a.profileDir, b.profileDir);
});

test("resolvePool: different names => isolated socket + profile", () => {
  const cfg = mergeConfig(null);
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
  const a = resolvePool(cfg, "alpha", env, "/repo");
  const b = resolvePool(cfg, "beta", env, "/repo");
  assert.notEqual(a.socketPath, b.socketPath);
  assert.notEqual(a.profileDir, b.profileDir);
});

test("resolvePool: explicit socketPath/profileDir override derivation", () => {
  const cfg = mergeConfig({ pools: { custom: { socketPath: "/tmp/my.sock", profileDir: "/tmp/prof" } } });
  const r = resolvePool(cfg, "custom", { XDG_RUNTIME_DIR: "/run/user/1000" }, "/repo");
  assert.equal(r.socketPath, "/tmp/my.sock");
  assert.equal(r.profileDir, "/tmp/prof");
  // log path is still derived
  assert.equal(r.logPath, "/run/user/1000/perplexity-web-mcp/custom.log");
});
