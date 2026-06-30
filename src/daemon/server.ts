import net from "net";
import path from "path";
import { spawn } from "child_process";
import { mkdirSync, unlinkSync, appendFileSync } from "fs";
import type { Page } from "playwright";
import type { ResolvedPool } from "../pool.js";
import { setLogger, log } from "../logger.js";
import { launchContext, closeContext, getContext } from "../browser-core.js";
import { runSearchOnPage } from "../search.js";
import { checkSession, ensureAuthenticatedOnPage } from "../auth.js";
import { DispatcherError } from "../dispatcher.js";
import { TabPool, type Slot } from "./tabpool.js";
import { acquireSocket } from "./bind.js";
import { NdjsonDecoder, encode, PROTOCOL_VERSION, type RpcRequest, type ServerMessage } from "./protocol.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
// How long a confirmed session is trusted before the next search re-probes it.
// Keeps the common (logged-in) path from fetching the session on every request.
const AUTH_OK_TTL_MS = 60_000;
// Background poll cadence while waiting for the user to log in.
const AUTH_POLL_MS = 3_000;

const notifyOff = (v?: string) =>
  v === "0" || v === "false" || v === "off";

// The browser-owning daemon. One per pool: owns the persistent context, runs up
// to maxConcurrency search tabs in parallel (one per request), applies the
// saturation policy at the cap, and self-shuts-down after idleShutdownMs.
export async function runDaemon(pool: ResolvedPool): Promise<void> {
  // Route all logging (search/auth/browser-core too) to the per-pool logfile —
  // the daemon has no attached stdout/stderr.
  mkdirSync(path.dirname(pool.logPath), { recursive: true });
  setLogger((msg) => {
    try { appendFileSync(pool.logPath, `[${new Date().toISOString()}] [pid ${process.pid}] ${msg}\n`); } catch {}
  });
  log(`Daemon starting for pool "${pool.name}" (socket=${pool.socketPath}, profile=${pool.profileDir})`);

  mkdirSync(path.dirname(pool.socketPath), { recursive: true, mode: 0o700 });

  // --- state ---
  const tabPool = new TabPool(pool.maxConcurrency, pool.saturation);
  const active = new Map<string, { cancel: () => Promise<void> }>();
  let loginMutex: Promise<unknown> = Promise.resolve();
  let inFlight = 0;
  let lastActivity = Date.now();
  let idleTimer: NodeJS.Timeout | null = null;
  let server: net.Server | null = null;
  let shuttingDown = false;
  const markActivity = () => { lastActivity = Date.now(); };

  // --- auth gate state ---
  // A single daemon-wide login window coordinates every connected client (the
  // user may run ~6 background agents at once). We never block a search waiting
  // for an interactive login — that would exceed the client's request timeout
  // and churn tabs. Instead: detect logged-out, fire one notification, open one
  // grace window, and fail incoming searches fast with LOGIN_REQUIRED until the
  // user logs in (then searches resume) or the window expires (then a cooldown
  // before the next search may reopen it).
  let authOkUntil = 0;       // session confirmed; trust it until this time
  let authWindowUntil = 0;   // a login grace window is open until this time
  let authBlockedUntil = 0;  // window expired w/o login; skip until this time
  let authPolling = false;   // background login-poll loop is running
  let probeInFlight: Promise<boolean> | null = null;

  // Run the session check on the shared visible first tab. Navigates it to
  // Perplexity only when it isn't already there, so it never interrupts an
  // in-progress login (incl. an OAuth redirect away from perplexity.ai — there
  // the fetch simply fails and we report "not authenticated" without touching
  // the page). Concurrent callers share one in-flight probe.
  function probeSession(): Promise<boolean> {
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
      const ctx = getContext();
      const page = ctx.pages()[0] ?? await ctx.newPage();
      if (!page.url().startsWith(PERPLEXITY_HOME)) {
        await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      return checkSession(page);
    })().finally(() => { probeInFlight = null; });
    return probeInFlight;
  }

  function notifyAuthRequired(): void {
    if (notifyOff(process.env.PERPLEXITY_WEB_MCP_NOTIFY)) return;
    const secs = Math.round(pool.authWaitMs / 1000);
    try {
      const child = spawn(
        "notify-send",
        ["-u", "critical", "-a", "perplexity-web-mcp",
         "Perplexity: требуется вход",
         `Сессия слетела — открой окно браузера и войди в Perplexity (есть ~${secs} с).`],
        { stdio: "ignore", env: process.env },
      );
      child.on("error", () => {}); // notify-send missing / no DISPLAY — ignore
      child.unref();
    } catch { /* ignore */ }
  }

  // Open the single login grace window: notify once, then poll the session in the
  // background. On login → trust the session and clear the window. On timeout →
  // enter a cooldown so searches are skipped (not hung) until it lapses.
  function openLoginWindow(): void {
    if (authPolling) return;
    authPolling = true;
    authWindowUntil = Date.now() + pool.authWaitMs;
    notifyAuthRequired();
    log(`Not authenticated — login window open for ${Math.round(pool.authWaitMs / 1000)}s; user notified.`);
    void (async () => {
      try {
        while (Date.now() < authWindowUntil) {
          await new Promise((r) => setTimeout(r, AUTH_POLL_MS));
          if (await probeSession().catch(() => false)) {
            authOkUntil = Date.now() + AUTH_OK_TTL_MS;
            authWindowUntil = 0;
            authBlockedUntil = 0;
            log("Login detected — resuming searches.");
            return;
          }
        }
        // Loop ended. If an explicit login (handleLogin) confirmed the session
        // meanwhile, don't arm the cooldown — let searches resume.
        if (Date.now() < authOkUntil) { authWindowUntil = 0; return; }
        authBlockedUntil = Date.now() + pool.authCooldownMs;
        authWindowUntil = 0;
        log(`Login window expired without auth — skipping searches for ${Math.round(pool.authCooldownMs / 1000)}s.`);
      } finally {
        authPolling = false;
      }
    })();
  }

  // Preflight gate for every search. Throws LOGIN_REQUIRED (fast, never hangs)
  // whenever the session isn't usable, so no search tab is ever opened while
  // logged out.
  async function gateAuth(): Promise<void> {
    const now = Date.now();
    if (now < authOkUntil) return;
    if (now < authWindowUntil) {
      throw new DispatcherError("LOGIN_REQUIRED", "Perplexity login required — a login window is open and you have been notified. Retry once logged in.");
    }
    if (now < authBlockedUntil) {
      throw new DispatcherError("LOGIN_REQUIRED", "Perplexity login required — the login window passed; skipping this request. Log in, then retry.");
    }
    if (await probeSession().catch(() => false)) {
      authOkUntil = Date.now() + AUTH_OK_TTL_MS;
      return;
    }
    openLoginWindow();
    throw new DispatcherError("LOGIN_REQUIRED", "Perplexity login required — a login window was opened and you have been notified. Retry once logged in.");
  }

  let markReady!: () => void;
  const ready = new Promise<void>((res) => { markReady = res; });

  async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Shutting down (code=${code}).`);
    if (idleTimer) clearInterval(idleTimer);
    try { server?.close(); } catch {}
    try { unlinkSync(pool.socketPath); } catch {}
    await closeContext().catch(() => {});
    process.exit(code);
  }

  function send(socket: net.Socket, msg: ServerMessage): void {
    if (!socket.destroyed) socket.write(encode(msg));
  }
  function toDispatcherError(e: unknown): DispatcherError {
    if (e instanceof DispatcherError) return e;
    return new DispatcherError("INTERNAL", e instanceof Error ? e.message : String(e));
  }
  function sendError(socket: net.Socket, id: string, e: unknown): void {
    const de = toDispatcherError(e);
    send(socket, { type: "error", id, code: de.code, message: de.message });
  }

  async function runMethod(page: Page, req: RpcRequest) {
    const query = req.params?.query ?? "";
    switch (req.method) {
      case "search":          return runSearchOnPage(page, query, pool.searchTimeoutMs, {});
      case "search_advanced": return runSearchOnPage(page, query, pool.searchTimeoutMs, { sources: req.params?.sources ?? null });
      case "search_deep":     return runSearchOnPage(page, query, pool.deepTimeoutMs, { deepResearch: true });
      default:                throw new DispatcherError("INTERNAL", `Unknown method ${req.method}`);
    }
  }

  async function handleSearch(socket: net.Socket, req: RpcRequest): Promise<void> {
    try { await ready; } catch (e) { sendError(socket, req.id, e); return; }

    // Auth preflight — fail fast (don't open a search tab) while logged out.
    try { await gateAuth(); } catch (e) { sendError(socket, req.id, e); return; }

    let slot: Slot;
    try { slot = await tabPool.acquire(); }
    catch (e) { sendError(socket, req.id, e); return; }

    // The client may have disconnected while we waited for a free tab.
    if (socket.destroyed) { slot.release(); return; }

    let page: Page;
    try { page = await getContext().newPage(); }
    catch (e) { slot.release(); sendError(socket, req.id, toDispatcherError(e)); return; }

    let cancelled = false;
    active.set(req.id, { cancel: async () => { cancelled = true; await page.close().catch(() => {}); } });
    send(socket, { type: "accepted", id: req.id, tabIndex: slot.tabIndex });
    log(`req ${req.id} -> tab ${slot.tabIndex} (${req.method}, inFlight=${tabPool.active}/${tabPool.capacity}, waiting=${tabPool.waiting})`);

    try {
      const result = await runMethod(page, req);
      if (!cancelled) send(socket, { type: "result", id: req.id, result });
    } catch (e) {
      if (!cancelled) sendError(socket, req.id, e);
    } finally {
      active.delete(req.id);
      await page.close().catch(() => {});
      slot.release();
    }
  }

  // Login uses the single visible first tab, serialized with a mutex so two
  // logins never fight over the window. It does NOT consume a search slot.
  function handleLogin(socket: net.Socket, req: RpcRequest): Promise<void> {
    const run = async () => {
      try {
        await ready;
        const ctx = getContext();
        const page = ctx.pages()[0] ?? await ctx.newPage();
        if (await checkSession(page)) {
          authOkUntil = Date.now() + AUTH_OK_TTL_MS;
          authWindowUntil = 0;
          authBlockedUntil = 0;
          send(socket, { type: "result", id: req.id, result: { message: "Already authenticated on Perplexity.ai." } });
          return;
        }
        await ensureAuthenticatedOnPage(page);
        // Successful interactive login — let queued searches resume immediately.
        authOkUntil = Date.now() + AUTH_OK_TTL_MS;
        authWindowUntil = 0;
        authBlockedUntil = 0;
        send(socket, { type: "result", id: req.id, result: { message: "Login successful. You are now authenticated on Perplexity.ai." } });
      } catch (e) {
        sendError(socket, req.id, e);
      }
    };
    const next = loginMutex.then(run, run);
    loginMutex = next.catch(() => {});
    return next as Promise<void>;
  }

  function handleMessage(socket: net.Socket, req: RpcRequest, localIds: Set<string>): void {
    if (!req || typeof req !== "object" || typeof req.method !== "string") return;
    if (req.method === "ping") { send(socket, { type: "pong" }); return; }
    if (req.v !== PROTOCOL_VERSION) {
      send(socket, { type: "error", id: req.id, code: "PROTOCOL_MISMATCH", message: `daemon protocol v${PROTOCOL_VERSION}, client v${req.v}` });
      return;
    }
    markActivity();
    localIds.add(req.id);
    inFlight++;
    const done = () => { inFlight--; localIds.delete(req.id); markActivity(); };
    const work = req.method === "login" ? handleLogin(socket, req) : handleSearch(socket, req);
    void work.then(done, done);
  }

  function handleConnection(socket: net.Socket): void {
    socket.setTimeout(0);
    socket.setNoDelay(true);
    const decoder = new NdjsonDecoder();
    const localIds = new Set<string>();
    send(socket, { type: "hello", v: PROTOCOL_VERSION, pool: pool.name, pid: process.pid });
    socket.on("data", (chunk) => {
      let msgs: unknown[];
      try { msgs = decoder.push(chunk); } catch { return; } // ignore malformed frame
      for (const m of msgs) handleMessage(socket, m as RpcRequest, localIds);
    });
    const cleanup = () => {
      for (const id of localIds) {
        const a = active.get(id);
        if (a) { active.delete(id); log(`req ${id} cancelled (client disconnect)`); void a.cancel(); }
      }
      localIds.clear();
    };
    socket.on("close", cleanup);
    socket.on("error", () => {});
  }

  // --- bind FIRST (the socket is the single-owner token), so a losing racer
  // never touches the shared profile. Only the winner launches Chromium. ---
  const srv = net.createServer(handleConnection);
  server = await acquireSocket(srv, pool.socketPath);
  if (!server) {
    log("Another live daemon already owns this pool socket — exiting.");
    process.exit(0);
    return;
  }
  log(`Listening on ${pool.socketPath} (maxConcurrency=${pool.maxConcurrency}, saturation=${pool.saturation.mode}, idleShutdownMs=${pool.idleShutdownMs}).`);

  try {
    const ctx = await launchContext(pool.profileDir);
    ctx.on("close", () => { log("Browser context closed — shutting down."); void shutdown(0); });
  } catch (e) {
    log(`Failed to launch browser: ${(e as Error).message}`);
    try { unlinkSync(pool.socketPath); } catch {}
    process.exit(1);
    return;
  }
  markReady();
  log("Browser ready.");

  idleTimer = setInterval(() => {
    if (inFlight === 0 && Date.now() - lastActivity > pool.idleShutdownMs) {
      log(`Idle for >${Math.round(pool.idleShutdownMs / 1000)}s — shutting down.`);
      void shutdown(0);
    }
  }, 10_000);
  idleTimer.unref?.();

  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void shutdown(0));
  process.on("uncaughtException", (e) => { log(`uncaughtException: ${e?.stack ?? e}`); void shutdown(1); });
  process.on("unhandledRejection", (e) => { log(`unhandledRejection: ${String(e)}`); });
}
