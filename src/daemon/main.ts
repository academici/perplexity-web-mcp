#!/usr/bin/env node
// Standalone daemon executable. The MCP client (index.ts) spawns this as a
// detached process: `node dist/daemon/main.js --pool=<name>`. It owns the
// browser for one pool and never touches the legacy in-process path.
import path from "path";
import { fileURLToPath } from "url";
import { parseFlags, loadConfig, resolvePoolName } from "../config.js";
import { resolvePool } from "../pool.js";
import { runDaemon } from "./server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..", "..");

const flags = parseFlags(process.argv.slice(2));
const env = process.env;
const config = loadConfig(flags, env, repoRoot);

const pool = resolvePool(config, resolvePoolName(flags, env, config), env, repoRoot);
if (flags.timeout) {
  const t = parseInt(flags.timeout, 10);
  if (Number.isFinite(t)) pool.searchTimeoutMs = t * 1000;
}

runDaemon(pool).catch((err) => {
  console.error("[perplexity-web-mcp daemon] Fatal:", err);
  process.exit(1);
});
