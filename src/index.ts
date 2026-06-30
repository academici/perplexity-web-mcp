#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import { parseFlags, loadConfig, resolveMode, resolvePoolName } from "./config.js";
import { resolvePool, type ResolvedPool } from "./pool.js";
import { DispatcherError, type Dispatcher } from "./dispatcher.js";
import type { SearchResult } from "./search.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

const flags = parseFlags(process.argv.slice(2));
const env = process.env;
const config = loadConfig(flags, env, repoRoot);

function formatResult(result: SearchResult): string {
  if (!result.answer) return "No answer found. Perplexity may have changed its structure.";
  const sourcesText = result.sources.length > 0
    ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
    : "";
  return result.answer + sourcesText;
}

// Resolve the active pool, applying the legacy --timeout=<seconds> override to
// the pool's search timeout for backward compatibility.
function resolveActivePool(): ResolvedPool {
  const pool = resolvePool(config, resolvePoolName(flags, env, config), env, repoRoot);
  if (flags.timeout) {
    const t = parseInt(flags.timeout, 10);
    if (Number.isFinite(t)) pool.searchTimeoutMs = t * 1000;
  }
  return pool;
}

// --- Build the dispatcher for the client process. ---
async function buildDispatcher(pool: ResolvedPool): Promise<Dispatcher> {
  const mode = resolveMode(flags, env, config);

  if (mode === "legacy") {
    const { createLegacyDispatcher } = await import("./legacy.js");
    return createLegacyDispatcher({ searchTimeoutMs: pool.searchTimeoutMs, deepTimeoutMs: pool.deepTimeoutMs });
  }

  // daemon mode with automatic fallback to legacy if no daemon can be reached/started
  const { createDaemonDispatcher, DaemonUnavailableError } = await import("./daemon/client.js");
  // The daemon is a separate executable (dist/daemon/main.js), spawned detached.
  const daemonEntry = path.join(__dirname, "daemon", "main.js");
  // Use the --key=value form: parseFlags only understands that form.
  const daemonArgs = [`--pool=${pool.name}`, ...(flags.config ? [`--config=${flags.config}`] : [])];
  const daemon = createDaemonDispatcher(pool, daemonEntry, daemonArgs);

  let legacy: Dispatcher | null = null;
  let usingLegacy = false;
  async function getLegacy(): Promise<Dispatcher> {
    if (!legacy) {
      const { createLegacyDispatcher } = await import("./legacy.js");
      legacy = createLegacyDispatcher({ searchTimeoutMs: pool.searchTimeoutMs, deepTimeoutMs: pool.deepTimeoutMs });
    }
    return legacy;
  }
  async function route<T>(fn: (d: Dispatcher) => Promise<T>): Promise<T> {
    if (usingLegacy) return fn(await getLegacy());
    try {
      return await fn(daemon);
    } catch (e) {
      if (e instanceof DaemonUnavailableError) {
        console.error(`[perplexity-web-mcp] Daemon unavailable (${e.message}) — falling back to legacy in-process mode.`);
        usingLegacy = true;
        return fn(await getLegacy());
      }
      throw e;
    }
  }
  return {
    search: (q) => route((d) => d.search(q)),
    searchAdvanced: (q, s) => route((d) => d.searchAdvanced(q, s)),
    searchDeep: (q) => route((d) => d.searchDeep(q)),
    login: () => route((d) => d.login()),
  };
}

// --- MCP server wiring (client process). ---
async function startMcp(dispatcher: Dispatcher): Promise<void> {
  const { FastMCP, UserError } = await import("fastmcp");
  const { z } = await import("zod");

  async function guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof DispatcherError) {
        throw new UserError(e.code === "BROWSER_BUSY" ? `BROWSER_BUSY: ${e.message}` : e.message);
      }
      throw e;
    }
  }

  const mcp = new FastMCP({ name: "perplexity-web", version: "1.3.0" });

  mcp.addTool({
    name: "search",
    description:
      "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources. Uses default Perplexity settings.",
    parameters: z.object({ query: z.string().describe("The search query") }),
    execute: ({ query }) => guarded(async () => formatResult(await dispatcher.search(query))),
  });

  mcp.addTool({
    name: "search_advanced",
    description:
      "Search Perplexity.ai with specific source selection. Lets you combine multiple sources (e.g. web + academic). Use this when source control matters; prefer `search` for general queries.",
    parameters: z.object({
      query: z.string().describe("The search query"),
      sources: z
        .array(z.enum(["web", "academic", "social"]))
        .min(1)
        .describe("Sources to search: 'web' (general web), 'academic' (scholarly articles), 'social' (Reddit & forums). Can combine multiple."),
    }),
    execute: ({ query, sources }) => guarded(async () => formatResult(await dispatcher.searchAdvanced(query, sources))),
  });

  mcp.addTool({
    name: "search_deep",
    description:
      "Run a Deep Research query on Perplexity.ai — multi-step iterative search that synthesizes 20+ sources. Much slower than `search` (up to 5 minutes). Use only when breadth and depth matter: market analysis, competitive landscape, academic overviews.",
    parameters: z.object({ query: z.string().describe("The research query") }),
    execute: ({ query }) => guarded(async () => formatResult(await dispatcher.searchDeep(query))),
  });

  mcp.addTool({
    name: "login",
    description:
      "Check if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.",
    parameters: z.object({}),
    execute: () => guarded(() => dispatcher.login()),
  });

  mcp.start({ transportType: "stdio" });
}

async function runAsClient(): Promise<void> {
  const pool = resolveActivePool();
  const mode = resolveMode(flags, env, config);
  console.error(`[perplexity-web-mcp] Starting (mode=${mode}, pool=${pool.name}). Browser launches on first tool call.`);
  const dispatcher = await buildDispatcher(pool);
  await startMcp(dispatcher);
}

async function main(): Promise<void> {
  await runAsClient();
}

main().catch((err) => {
  console.error("[perplexity-web-mcp] Fatal error:", err);
  process.exit(1);
});
