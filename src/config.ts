import { existsSync, readFileSync } from "fs";
import path from "path";
import type { DispatcherErrorCode } from "./dispatcher.js";

// ---------------------------------------------------------------------------
// Config schema
// ---------------------------------------------------------------------------

export type Mode = "daemon" | "legacy";
export type SaturationMode = "queue" | "fail-fast" | "hybrid";

export interface SaturationCfg {
  mode: SaturationMode;
  waitMs: number; // only meaningful for "hybrid"
}

export interface PoolCfg {
  socketPath?: string; // empty/undefined => derived in pool.ts
  profileDir?: string; // empty/undefined => derived in pool.ts
  maxConcurrency?: number;
  idleShutdownMs?: number;
  saturation?: Partial<SaturationCfg>;
  searchTimeoutMs?: number;
  deepTimeoutMs?: number;
}

// Client-side resilience knobs: retry-with-backoff, structured error logging,
// and desktop notifications. These live in the CLIENT process (which knows the
// consuming project's cwd), not the daemon.
export interface RetryCfg {
  attempts: number; // total attempts including the first (1 = no retry)
  baseDelayMs: number; // first backoff delay; doubles each retry up to maxDelayMs
  maxDelayMs: number;
  retryableCodes: DispatcherErrorCode[];
}

export interface NotifyCfg {
  enabled: boolean; // fire a desktop notification (notify-send) when a call finally fails
}

export interface ErrorLogCfg {
  enabled: boolean;
  path?: string; // empty/undefined => derived under XDG_STATE_HOME/perplexity-web-mcp/errors.jsonl
}

export interface ResilienceCfg {
  retry: RetryCfg;
  notify: NotifyCfg;
  errorLog: ErrorLogCfg;
}

export interface Config {
  mode: Mode;
  defaultPool: string;
  pools: Record<string, PoolCfg>;
  resilience?: {
    retry?: Partial<RetryCfg>;
    notify?: Partial<NotifyCfg>;
    errorLog?: Partial<ErrorLogCfg>;
  };
}

// Fully-resolved pool knobs (paths still derived separately in pool.ts).
export interface PoolKnobs {
  socketPath: string;
  profileDir: string;
  maxConcurrency: number;
  idleShutdownMs: number;
  saturation: SaturationCfg;
  searchTimeoutMs: number;
  deepTimeoutMs: number;
}

export const DEFAULT_POOL_KNOBS: Omit<PoolKnobs, "socketPath" | "profileDir"> = {
  maxConcurrency: 3,
  idleShutdownMs: 300_000,
  saturation: { mode: "hybrid", waitMs: 30_000 },
  searchTimeoutMs: 60_000,
  deepTimeoutMs: 600_000,
};

export const DEFAULT_RESILIENCE: ResilienceCfg = {
  // Retry transient failures only. BROWSER_BUSY is included for safety even
  // though "queue" saturation makes it rare; LOGIN_REQUIRED / PROTOCOL_MISMATCH
  // are deliberately NOT retryable (they need human/version action).
  retry: {
    attempts: 3,
    baseDelayMs: 1_000,
    maxDelayMs: 8_000,
    retryableCodes: ["BROWSER_BUSY", "TIMEOUT", "INTERNAL"],
  },
  notify: { enabled: true },
  errorLog: { enabled: true },
};

// ---------------------------------------------------------------------------
// CLI flags
// ---------------------------------------------------------------------------

export interface Flags {
  config?: string;
  pool?: string;
  mode?: string;
  timeout?: string;
  daemon: boolean;
}

export function parseFlags(argv: string[]): Flags {
  const get = (key: string): string | undefined => {
    const prefix = `--${key}=`;
    const hit = argv.find((a) => a.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
  };
  return {
    config: get("config"),
    pool: get("pool"),
    mode: get("mode"),
    timeout: get("timeout"),
    daemon: argv.includes("--daemon"),
  };
}

// ---------------------------------------------------------------------------
// Pure merge / resolution (unit-tested)
// ---------------------------------------------------------------------------

export function mergeConfig(partial: Partial<Config> | null | undefined): Config {
  return {
    mode: partial?.mode === "legacy" ? "legacy" : "daemon",
    defaultPool: partial?.defaultPool ?? "default",
    pools: partial?.pools ?? {},
    resilience: partial?.resilience,
  };
}

// Merge built-in resilience defaults with the config's optional overrides, then
// apply env kill-switches (PERPLEXITY_WEB_MCP_NOTIFY/RETRIES/ERRORLOG=0|off).
export function getResilience(config: Config, env: NodeJS.ProcessEnv): ResilienceCfg {
  const r = config.resilience ?? {};
  const off = (v: string | undefined) => v === "0" || v === "false" || v === "off";
  const attempts = r.retry?.attempts ?? DEFAULT_RESILIENCE.retry.attempts;
  const envAttempts = env.PERPLEXITY_WEB_MCP_RETRIES ? parseInt(env.PERPLEXITY_WEB_MCP_RETRIES, 10) : NaN;
  return {
    retry: {
      attempts: Number.isFinite(envAttempts) && envAttempts >= 1 ? envAttempts : attempts,
      baseDelayMs: r.retry?.baseDelayMs ?? DEFAULT_RESILIENCE.retry.baseDelayMs,
      maxDelayMs: r.retry?.maxDelayMs ?? DEFAULT_RESILIENCE.retry.maxDelayMs,
      retryableCodes: r.retry?.retryableCodes ?? DEFAULT_RESILIENCE.retry.retryableCodes,
    },
    notify: { enabled: off(env.PERPLEXITY_WEB_MCP_NOTIFY) ? false : (r.notify?.enabled ?? DEFAULT_RESILIENCE.notify.enabled) },
    errorLog: {
      enabled: off(env.PERPLEXITY_WEB_MCP_ERRORLOG) ? false : (r.errorLog?.enabled ?? DEFAULT_RESILIENCE.errorLog.enabled),
      path: r.errorLog?.path,
    },
  };
}

// Default structured error-log path: XDG_STATE_HOME/perplexity-web-mcp/errors.jsonl.
export function defaultErrorLogPath(env: NodeJS.ProcessEnv): string {
  const state = env.XDG_STATE_HOME || (env.HOME ? path.join(env.HOME, ".local", "state") : path.join("/tmp"));
  return path.join(state, "perplexity-web-mcp", "errors.jsonl");
}

export function resolveMode(flags: Flags, env: NodeJS.ProcessEnv, config: Config): Mode {
  const raw = flags.mode ?? env.PERPLEXITY_WEB_MCP_MODE ?? config.mode;
  return raw === "legacy" ? "legacy" : "daemon";
}

export function resolvePoolName(flags: Flags, env: NodeJS.ProcessEnv, config: Config): string {
  return flags.pool ?? env.PERPLEXITY_WEB_MCP_POOL ?? config.defaultPool ?? "default";
}

// Merge built-in pool defaults with the pool's config entry (if any). Paths
// (socketPath/profileDir) stay as-supplied — empty string means "derive later".
export function getPoolKnobs(config: Config, name: string): PoolKnobs {
  const p = config.pools[name] ?? {};
  return {
    socketPath: p.socketPath ?? "",
    profileDir: p.profileDir ?? "",
    maxConcurrency: p.maxConcurrency ?? DEFAULT_POOL_KNOBS.maxConcurrency,
    idleShutdownMs: p.idleShutdownMs ?? DEFAULT_POOL_KNOBS.idleShutdownMs,
    saturation: {
      mode: p.saturation?.mode ?? DEFAULT_POOL_KNOBS.saturation.mode,
      waitMs: p.saturation?.waitMs ?? DEFAULT_POOL_KNOBS.saturation.waitMs,
    },
    searchTimeoutMs: p.searchTimeoutMs ?? DEFAULT_POOL_KNOBS.searchTimeoutMs,
    deepTimeoutMs: p.deepTimeoutMs ?? DEFAULT_POOL_KNOBS.deepTimeoutMs,
  };
}

// ---------------------------------------------------------------------------
// Config file loading (fs side effects — thin wrapper around the pure logic)
// ---------------------------------------------------------------------------

// Resolve which config file to load. CLI flag and env force a specific path;
// otherwise the first existing default location wins. Returns null => built-ins.
export function resolveConfigFilePath(
  flags: Flags,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): string | null {
  if (flags.config) return flags.config;
  if (env.PERPLEXITY_WEB_MCP_CONFIG) return env.PERPLEXITY_WEB_MCP_CONFIG;
  const xdg = env.XDG_CONFIG_HOME || (env.HOME ? path.join(env.HOME, ".config") : null);
  if (xdg) {
    const p = path.join(xdg, "perplexity-web-mcp", "config.json");
    if (existsSync(p)) return p;
  }
  const repoCfg = path.join(repoRoot, ".playwright", "config.json");
  if (existsSync(repoCfg)) return repoCfg;
  return null;
}

export function loadConfig(flags: Flags, env: NodeJS.ProcessEnv, repoRoot: string): Config {
  const file = resolveConfigFilePath(flags, env, repoRoot);
  if (!file) return mergeConfig(null);
  try {
    const raw = JSON.parse(readFileSync(file, "utf-8")) as Partial<Config>;
    return mergeConfig(raw);
  } catch (err) {
    // A broken config must not break the tool — fall back to defaults, loudly.
    console.error(`[perplexity-web-mcp] Failed to read config ${file}: ${(err as Error).message}. Using defaults.`);
    return mergeConfig(null);
  }
}
