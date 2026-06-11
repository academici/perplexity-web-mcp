#!/usr/bin/env node
import { FastMCP } from "fastmcp";
import { z } from "zod";
import { ensureAuthenticated, checkSession } from "./auth.js";
import { ensureBrowser, getFirstPage, scheduleIdleClose } from "./browser.js";
import { search, searchWithSources, searchDeep, SearchResult, DEFAULT_TIMEOUT_MS, DEEP_RESEARCH_TIMEOUT_MS } from "./search.js";

function formatResult(result: SearchResult): string {
  if (!result.answer) return "No answer found. Perplexity may have changed its structure.";
  const sourcesText = result.sources.length > 0
    ? "\n\nSources:\n" + result.sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")
    : "";
  return result.answer + sourcesText;
}

// All tools share one browser window — concurrent tool calls used to race on
// pages and on browser teardown ("Target page, context or browser has been
// closed"). Serialize them through a promise queue instead.
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = async () => {
    await ensureBrowser();
    try {
      return await fn();
    } finally {
      scheduleIdleClose();
    }
  };
  const next = queue.then(run, run);
  queue = next.catch(() => {});
  return next;
}

// --- CLI args ---
const args = process.argv.slice(2);

const timeoutArg = args.find((a) => a.startsWith("--timeout="));
const TIMEOUT_MS = timeoutArg ? parseInt(timeoutArg.split("=")[1], 10) * 1000 : DEFAULT_TIMEOUT_MS;

// --- MCP server ---
const mcp = new FastMCP({
  name: "perplexity-web",
  version: "1.2.0",
});

mcp.addTool({
  name: "search",
  description:
    "Search the web using Perplexity.ai and get an AI-synthesized answer with cited sources. Uses default Perplexity settings.",
  parameters: z.object({
    query: z.string().describe("The search query"),
  }),
  execute: ({ query }) =>
    serialized(async () => formatResult(await search(query, TIMEOUT_MS))),
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
  execute: ({ query, sources }) =>
    serialized(async () => formatResult(await searchWithSources(query, TIMEOUT_MS, sources))),
});

mcp.addTool({
  name: "search_deep",
  description:
    "Run a Deep Research query on Perplexity.ai — multi-step iterative search that synthesizes 20+ sources. Much slower than `search` (up to 5 minutes). Use only when breadth and depth matter: market analysis, competitive landscape, academic overviews.",
  parameters: z.object({
    query: z.string().describe("The research query"),
  }),
  execute: ({ query }) =>
    serialized(async () => formatResult(await searchDeep(query, DEEP_RESEARCH_TIMEOUT_MS))),
});

mcp.addTool({
  name: "login",
  description:
    "Check if you are authenticated on Perplexity.ai. If not, opens a browser window so you can log in.",
  parameters: z.object({}),
  execute: () =>
    serialized(async () => {
      const page = await getFirstPage();
      const authenticated = await checkSession(page);
      if (authenticated) {
        return "Already authenticated on Perplexity.ai.";
      }
      await ensureAuthenticated();
      return "Login successful. You are now authenticated on Perplexity.ai.";
    }),
});

// --- Startup ---
async function main() {
  console.error(`[perplexity-web-mcp] Starting (timeout=${TIMEOUT_MS}ms)...`);
  console.error("[perplexity-web-mcp] Ready. Browser will launch on first tool call.");
  mcp.start({ transportType: "stdio" });
}

main().catch((err) => {
  console.error("[perplexity-web-mcp] Fatal error:", err);
  process.exit(1);
});
