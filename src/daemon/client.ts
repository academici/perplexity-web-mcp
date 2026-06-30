import net from "net";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import type { ResolvedPool } from "../pool.js";
import type { SearchResult } from "../search.js";
import { DispatcherError, type Dispatcher } from "../dispatcher.js";
import {
  NdjsonDecoder,
  encode,
  PROTOCOL_VERSION,
  type ClientMessage,
  type Method,
  type ServerMessage,
} from "./protocol.js";

// Thrown when no daemon is reachable and we couldn't start one. index.ts treats
// this (and only this) as the signal to fall back to legacy in-process mode.
// A PROTOCOL_MISMATCH deliberately does NOT fall back — a daemon IS running, just
// a different version, and launching a legacy browser on its profile would clash.
export class DaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnavailableError";
  }
}

const KEEPALIVE_MS = 20_000;
const HELLO_TIMEOUT_MS = 5_000;
const STARTUP_TIMEOUT_MS = 8_000;
const CLIENT_MARGIN_MS = 60_000; // grace beyond the daemon's own per-request timeout
const LOGIN_TIMEOUT_MS = 6 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One framed connection. The single 'data' handler decodes NDJSON and forwards
// parsed messages to whatever handler is currently installed.
class Conn {
  private decoder = new NdjsonDecoder();
  private handler: (m: ServerMessage) => void = () => {};
  constructor(public socket: net.Socket) {
    socket.on("data", (chunk: Buffer) => {
      let msgs: unknown[];
      try { msgs = this.decoder.push(chunk); } catch { return; }
      for (const m of msgs) this.handler(m as ServerMessage);
    });
  }
  onMessage(h: (m: ServerMessage) => void): void { this.handler = h; }
  send(msg: ClientMessage): void { if (!this.socket.destroyed) this.socket.write(encode(msg)); }
  close(): void { this.socket.destroy(); }
}

function tryConnect(socketPath: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const sock = net.connect(socketPath);
    const onErr = () => { sock.destroy(); resolve(null); };
    sock.once("error", onErr);
    sock.once("connect", () => { sock.removeListener("error", onErr); sock.setNoDelay(true); sock.setTimeout(0); resolve(sock); });
  });
}

function spawnDaemon(entry: string, daemonArgs: string[]): void {
  const child = spawn(process.execPath, [entry, ...daemonArgs], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  child.unref();
}

function awaitHello(conn: Conn): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new DaemonUnavailableError("Timed out waiting for daemon hello")), HELLO_TIMEOUT_MS);
    conn.onMessage((m) => {
      if (m.type !== "hello") return;
      clearTimeout(t);
      if (m.v !== PROTOCOL_VERSION) {
        reject(new DispatcherError(
          "PROTOCOL_MISMATCH",
          `Pool "${m.pool}" is served by an incompatible daemon (protocol v${m.v}, this client v${PROTOCOL_VERSION}). ` +
          "Stop that daemon (or let it idle out) so a matching one can start.",
        ));
        return;
      }
      resolve();
    });
    conn.socket.once("error", (e) => { clearTimeout(t); reject(new DaemonUnavailableError(e.message)); });
    conn.socket.once("close", () => { clearTimeout(t); reject(new DaemonUnavailableError("Connection closed before hello")); });
  });
}

async function connectOrSpawn(pool: ResolvedPool, entry: string, daemonArgs: string[]): Promise<Conn> {
  let sock = await tryConnect(pool.socketPath);
  if (!sock) {
    spawnDaemon(entry, daemonArgs);
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    let delay = 50;
    while (!sock && Date.now() < deadline) {
      await sleep(delay);
      sock = await tryConnect(pool.socketPath);
      delay = Math.min(Math.round(delay * 1.5), 500);
    }
    if (!sock) throw new DaemonUnavailableError(`Daemon for pool "${pool.name}" did not start within ${STARTUP_TIMEOUT_MS}ms`);
  }
  const conn = new Conn(sock);
  try {
    await awaitHello(conn); // throws DaemonUnavailableError or PROTOCOL_MISMATCH
  } catch (e) {
    conn.close(); // don't leak the socket on a failed handshake
    throw e;
  }
  return conn;
}

function request(
  conn: Conn,
  method: Method,
  params: { query?: string; sources?: string[] },
  serverTimeoutMs: number,
): Promise<SearchResult | { message: string }> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    let settled = false;
    let missedPongs = 0;

    const keepalive = setInterval(() => {
      if (missedPongs >= 2) { finish(reject, new DispatcherError("INTERNAL", "Daemon stopped responding (no pong).")); return; }
      missedPongs++;
      conn.send({ v: PROTOCOL_VERSION, id: "keepalive", method: "ping", params: {} });
    }, KEEPALIVE_MS);
    keepalive.unref?.();

    const hard = setTimeout(
      () => finish(reject, new DispatcherError("TIMEOUT", `Request timed out after ${serverTimeoutMs + CLIENT_MARGIN_MS}ms.`)),
      serverTimeoutMs + CLIENT_MARGIN_MS,
    );
    hard.unref?.();

    function finish(fn: (v: unknown) => void, val: unknown): void {
      if (settled) return;
      settled = true;
      clearInterval(keepalive);
      clearTimeout(hard);
      conn.close();
      fn(val);
    }

    conn.onMessage((m) => {
      if (m.type === "pong") { missedPongs = 0; return; }
      if (m.type === "hello") return;
      if (!("id" in m) || m.id !== id) return;
      if (m.type === "accepted") { missedPongs = 0; return; }
      if (m.type === "result") { finish(resolve as (v: unknown) => void, m.result); return; }
      if (m.type === "error") { finish(reject, new DispatcherError(m.code, m.message)); return; }
    });
    conn.socket.once("error", (e) => finish(reject, new DispatcherError("INTERNAL", `Daemon connection error: ${e.message}`)));
    conn.socket.once("close", () => finish(reject, new DispatcherError("INTERNAL", "Daemon connection closed before result.")));

    conn.send({ v: PROTOCOL_VERSION, id, method, params });
  });
}

export function createDaemonDispatcher(pool: ResolvedPool, entry: string, daemonArgs: string[]): Dispatcher {
  async function call(
    method: Method,
    params: { query?: string; sources?: string[] },
    serverTimeoutMs: number,
  ): Promise<SearchResult | { message: string }> {
    const conn = await connectOrSpawn(pool, entry, daemonArgs);
    return request(conn, method, params, serverTimeoutMs);
  }

  return {
    search: (query) => call("search", { query }, pool.searchTimeoutMs) as Promise<SearchResult>,
    searchAdvanced: (query, sources) => call("search_advanced", { query, sources }, pool.searchTimeoutMs) as Promise<SearchResult>,
    searchDeep: (query) => call("search_deep", { query }, pool.deepTimeoutMs) as Promise<SearchResult>,
    login: async () => {
      const r = await call("login", {}, LOGIN_TIMEOUT_MS);
      return (r as { message: string }).message;
    },
  };
}
