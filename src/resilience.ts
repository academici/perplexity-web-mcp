import path from "path";
import { mkdirSync, appendFileSync } from "fs";
import { spawn } from "child_process";
import { DispatcherError, type Dispatcher, type DispatcherErrorCode } from "./dispatcher.js";
import { type ResilienceCfg, type RetryCfg, defaultErrorLogPath } from "./config.js";
import { log } from "./logger.js";

// Wraps a Dispatcher in the client process (which, unlike the shared daemon,
// knows the consuming project's cwd) to add three cross-cutting guarantees:
//   1. retry-with-backoff on transient failures,
//   2. a structured JSONL error log (project + inputs + reason),
//   3. a desktop notification when a call finally fails.

export interface ProjectInfo {
  name: string; // basename of the project's cwd — what shows up in notifications
  path: string; // absolute project path
}

export interface ResilienceContext {
  cfg: ResilienceCfg;
  pool: string;
  project: ProjectInfo;
  env: NodeJS.ProcessEnv;
}

export interface FailureRecord {
  ts: string;
  project: string;
  projectPath: string;
  pool: string;
  tool: string;
  query: string;
  sources: string[] | null;
  attempts: number;
  code: DispatcherErrorCode;
  message: string;
  durationMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function errorCodeOf(e: unknown): DispatcherErrorCode {
  return e instanceof DispatcherError ? e.code : "INTERNAL";
}

export function isRetryable(code: DispatcherErrorCode, cfg: RetryCfg): boolean {
  return cfg.retryableCodes.includes(code);
}

// Exponential backoff: base * 2^(attempt-1), capped at maxDelayMs. `attempt` is
// 1-based and names the delay applied AFTER attempt N (before attempt N+1).
export function backoffDelay(attempt: number, cfg: RetryCfg): number {
  const raw = cfg.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1));
  return Math.min(raw, cfg.maxDelayMs);
}

function writeErrorLog(rec: FailureRecord, ctx: ResilienceContext): void {
  if (!ctx.cfg.errorLog.enabled) return;
  const file = ctx.cfg.errorLog.path || defaultErrorLogPath(ctx.env);
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, JSON.stringify(rec) + "\n");
  } catch (e) {
    log(`failed to write error log ${file}: ${(e as Error).message}`);
  }
}

// Fire-and-forget desktop alert. notify-send may be absent (headless, non-Linux)
// or have no display — any of that just no-ops, never breaks the tool call.
function notifyDesktop(rec: FailureRecord, ctx: ResilienceContext): void {
  if (!ctx.cfg.notify.enabled) return;
  const title = `Perplexity ✖ ${rec.project}`;
  const body = `${rec.tool} failed (${rec.code}) after ${rec.attempts} attempt(s): ${truncate(rec.message, 140)}`;
  try {
    const child = spawn("notify-send", ["-u", "critical", "-a", "perplexity-web-mcp", title, body], {
      stdio: "ignore",
      env: ctx.env,
    });
    child.on("error", () => {}); // notify-send missing or no DISPLAY — ignore
    child.unref();
  } catch {
    /* ignore */
  }
}

async function runOne<T>(
  tool: string,
  meta: { query?: string; sources?: string[] },
  fn: () => Promise<T>,
  ctx: ResilienceContext,
): Promise<T> {
  // login is interactive and long-running; retrying it would reopen the browser
  // and double the wait, so it always gets exactly one attempt.
  const attempts = tool === "login" ? 1 : Math.max(1, ctx.cfg.retry.attempts);
  const startedAt = Date.now();
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const code = errorCodeOf(e);
      const msg = e instanceof Error ? e.message : String(e);
      const canRetry = attempt < attempts && isRetryable(code, ctx.cfg.retry);
      log(`${tool} attempt ${attempt}/${attempts} failed: ${code} — ${truncate(msg, 160)}${canRetry ? " (retrying)" : ""}`);
      if (!canRetry) break;
      await sleep(backoffDelay(attempt, ctx.cfg.retry));
    }
  }

  const rec: FailureRecord = {
    ts: new Date().toISOString(),
    project: ctx.project.name,
    projectPath: ctx.project.path,
    pool: ctx.pool,
    tool,
    query: truncate(meta.query ?? "", 500),
    sources: meta.sources ?? null,
    attempts,
    code: errorCodeOf(lastErr),
    message: lastErr instanceof Error ? lastErr.message : String(lastErr),
    durationMs: Date.now() - startedAt,
  };
  writeErrorLog(rec, ctx);
  notifyDesktop(rec, ctx);
  throw lastErr;
}

export function withResilience(inner: Dispatcher, ctx: ResilienceContext): Dispatcher {
  return {
    search: (q) => runOne("search", { query: q }, () => inner.search(q), ctx),
    searchAdvanced: (q, s) => runOne("search_advanced", { query: q, sources: s }, () => inner.searchAdvanced(q, s), ctx),
    searchDeep: (q) => runOne("search_deep", { query: q }, () => inner.searchDeep(q), ctx),
    login: () => runOne("login", {}, () => inner.login(), ctx),
  };
}
