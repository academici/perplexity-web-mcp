import { ensureBrowser, getFirstPage, newSearchPage, scheduleIdleClose } from "./browser.js";
import { runSearchOnPage, type SearchResult } from "./search.js";
import { checkSession, ensureAuthenticatedOnPage } from "./auth.js";
import { log } from "./logger.js";
import type { Dispatcher } from "./dispatcher.js";

// In-process dispatcher reproducing the pre-daemon behavior byte-for-byte: one
// shared singleton context (legacy browser.ts, with its cross-process PID lock
// and idle-close), all tool calls serialized through a promise queue. Used when
// mode=legacy or as the automatic fallback when the daemon can't be reached.
export function createLegacyDispatcher(opts: { searchTimeoutMs: number; deepTimeoutMs: number }): Dispatcher {
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

  async function runOnFreshPage(
    query: string,
    timeoutMs: number,
    sources: string[] | null,
    deepResearch: boolean,
  ): Promise<SearchResult> {
    const page = await newSearchPage();
    try {
      return await runSearchOnPage(page, query, timeoutMs, { sources, deepResearch });
    } finally {
      await page.close().catch(() => {});
    }
  }

  return {
    search: (query) =>
      serialized(() => {
        log(`Search: "${query}" (timeout: ${opts.searchTimeoutMs}ms)`);
        return runOnFreshPage(query, opts.searchTimeoutMs, null, false);
      }),
    searchAdvanced: (query, sources) =>
      serialized(() => {
        log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${opts.searchTimeoutMs}ms)`);
        return runOnFreshPage(query, opts.searchTimeoutMs, sources, false);
      }),
    searchDeep: (query) =>
      serialized(() => {
        log(`Deep Research: "${query}" (timeout: ${opts.deepTimeoutMs}ms)`);
        return runOnFreshPage(query, opts.deepTimeoutMs, null, true);
      }),
    login: () =>
      serialized(async () => {
        const page = await getFirstPage();
        if (await checkSession(page)) {
          return "Already authenticated on Perplexity.ai.";
        }
        await ensureAuthenticatedOnPage(page);
        return "Login successful. You are now authenticated on Perplexity.ai.";
      }),
  };
}
