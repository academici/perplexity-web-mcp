import { existsSync } from "fs";
import type { Dispatcher } from "../dispatcher.js";
import { DispatcherError } from "../dispatcher.js";
import { probeAlive } from "./bind.js";
import { DaemonStartingError, DaemonUnavailableError } from "./client.js";

export interface FallbackDispatcherOptions {
  poolName: string;
  socketPath: string;
  daemon: Dispatcher;
  createLegacy: () => Promise<Dispatcher>;
  log?: (line: string) => void;
  retryDaemonAfterMs?: number;
  socketExists?: (socketPath: string) => boolean;
  probeDaemonAlive?: (socketPath: string, timeoutMs?: number) => Promise<boolean>;
  now?: () => number;
}

export function createFallbackDispatcher(opts: FallbackDispatcherOptions): Dispatcher {
  const log = opts.log ?? ((line: string) => console.error(line));
  const now = opts.now ?? (() => Date.now());
  const retryDaemonAfterMs = Math.max(0, opts.retryDaemonAfterMs ?? 0);
  const socketExists = opts.socketExists ?? ((socketPath: string) => existsSync(socketPath));
  const probeDaemonAlive = opts.probeDaemonAlive ?? probeAlive;

  let legacy: Dispatcher | null = null;
  let retryDaemonAt = 0;

  async function getLegacy(): Promise<Dispatcher> {
    if (!legacy) legacy = await opts.createLegacy();
    return legacy;
  }

  async function hasDaemonOwnershipSignal(): Promise<boolean> {
    if (socketExists(opts.socketPath)) return true;
    return probeDaemonAlive(opts.socketPath, 200).catch(() => false);
  }

  async function route<T>(fn: (d: Dispatcher) => Promise<T>): Promise<T> {
    const useLegacyOnly = legacy && now() < retryDaemonAt;
    if (useLegacyOnly) return fn(await getLegacy());

    try {
      return await fn(opts.daemon);
    } catch (e) {
      if (!(e instanceof DaemonUnavailableError)) throw e;

      if (e instanceof DaemonStartingError) {
        throw new DispatcherError(
          "PROTOCOL_MISMATCH",
          `Daemon for pool "${opts.poolName}" is still starting. ` +
            `Retry in a few seconds; legacy mode is blocked to avoid Chromium profile conflicts ` +
            `(socket: ${opts.socketPath}).`,
        );
      }

      if (await hasDaemonOwnershipSignal()) {
        throw new DispatcherError(
          "PROTOCOL_MISMATCH",
          `Daemon for pool "${opts.poolName}" appears active (socket present/reachable), ` +
            `but this request failed before a handshake: ${e.message}. ` +
            "Legacy mode is blocked to avoid Chromium profile conflicts. Retry shortly.",
        );
      }

      retryDaemonAt = now() + retryDaemonAfterMs;
      log(`[perplexity-web-mcp] Daemon unavailable (${e.message}) — falling back to legacy in-process mode.`);
      return fn(await getLegacy());
    }
  }

  return {
    search: (q) => route((d) => d.search(q)),
    searchAdvanced: (q, s) => route((d) => d.searchAdvanced(q, s)),
    searchDeep: (q) => route((d) => d.searchDeep(q)),
    login: () => route((d) => d.login()),
  };
}
