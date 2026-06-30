import os from "os";
import path from "path";
import { createHash } from "crypto";
import { type Config, type SaturationCfg, getPoolKnobs } from "./config.js";

export interface ResolvedPool {
  name: string;
  socketPath: string;
  profileDir: string;
  logPath: string;
  maxConcurrency: number;
  idleShutdownMs: number;
  saturation: SaturationCfg;
  searchTimeoutMs: number;
  deepTimeoutMs: number;
  authWaitMs: number;
  authCooldownMs: number;
}

const ENDPOINT_DIR_NAME = "perplexity-web-mcp";
// Keep socket paths comfortably under the macOS sun_path limit (~104 bytes);
// Linux allows ~108. Above this threshold we hash the pool name to a short file.
const MAX_SOCKET_PATH = 100;

export function runtimeDir(env: NodeJS.ProcessEnv): string {
  return env.XDG_RUNTIME_DIR || os.tmpdir();
}

export function endpointDir(runtimeDirPath: string): string {
  return path.join(runtimeDirPath, ENDPOINT_DIR_NAME);
}

export function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "_") || "_";
}

// Derive a per-pool endpoint path (socket or logfile). Long names are hashed so
// the socket path never exceeds the OS limit.
export function deriveEndpointPath(runtimeDirPath: string, poolName: string, ext: string): string {
  const dir = endpointDir(runtimeDirPath);
  const full = path.join(dir, `${sanitize(poolName)}.${ext}`);
  if (full.length > MAX_SOCKET_PATH) {
    const h = createHash("sha256").update(poolName).digest("hex").slice(0, 16);
    return path.join(dir, `p-${h}.${ext}`);
  }
  return full;
}

// The "default" pool maps onto the pre-existing profile so already-logged-in
// users keep their session; other pools get an isolated profile dir.
export function deriveProfileDir(repoRoot: string, poolName: string): string {
  if (poolName === "default") return path.join(repoRoot, ".playwright", "profile");
  return path.join(repoRoot, ".playwright", "profiles", sanitize(poolName));
}

export function resolvePool(
  config: Config,
  name: string,
  env: NodeJS.ProcessEnv,
  repoRoot: string,
): ResolvedPool {
  const knobs = getPoolKnobs(config, name);
  const rt = runtimeDir(env);
  return {
    name,
    socketPath: knobs.socketPath || deriveEndpointPath(rt, name, "sock"),
    logPath: deriveEndpointPath(rt, name, "log"),
    profileDir: knobs.profileDir || deriveProfileDir(repoRoot, name),
    maxConcurrency: knobs.maxConcurrency,
    idleShutdownMs: knobs.idleShutdownMs,
    saturation: knobs.saturation,
    searchTimeoutMs: knobs.searchTimeoutMs,
    deepTimeoutMs: knobs.deepTimeoutMs,
    authWaitMs: knobs.authWaitMs,
    authCooldownMs: knobs.authCooldownMs,
  };
}
