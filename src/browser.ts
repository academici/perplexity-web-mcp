import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { existsSync, rmSync, readlinkSync, mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "../.playwright/profile");
// Advisory cross-process lock: several MCP server instances (one per client
// connection) share the same persistent profile. Chromium enforces single
// ownership via ProcessSingleton, so we must serialize access ourselves.
const LOCK_FILE = path.resolve(__dirname, "../.playwright/profile.lock");
const LOCK_ACQUIRE_TIMEOUT_MS = 120_000;
const LOCK_POLL_MS = 500;
// Close the browser after this much idle time so other server processes
// waiting on the profile lock can take over.
const IDLE_CLOSE_MS = 90_000;

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

function checkChromiumInstalled(): void {
  // If a custom executable is provided via env, skip the Playwright binary check
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return;
  try {
    execSync("npx playwright install --dry-run chromium", { stdio: "ignore" });
  } catch {
    // dry-run not available in all versions, fall back to checking executablePath
  }
  try {
    chromium.executablePath();
  } catch {
    console.error(
      "[perplexity-web-mcp] Chromium is not installed.\n" +
      "Run: npx playwright install chromium\n" +
      "Or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium"
    );
    process.exit(1);
  }
}

let context: BrowserContext | null = null;
let holdingLock = false;
let idleTimer: NodeJS.Timeout | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

// Chromium's SingletonLock is a symlink to "<hostname>-<pid>". Remove it only
// when the owning process is dead — blindly deleting it while another live
// instance owns the profile corrupts that instance.
function removeStaleSingletonLock(): void {
  const lockFile = path.join(PROFILE_DIR, "SingletonLock");
  if (!existsSync(lockFile)) return;
  try {
    const target = readlinkSync(lockFile);
    const pid = parseInt(target.split("-").pop() ?? "", 10);
    if (Number.isFinite(pid) && isProcessAlive(pid)) {
      log(`SingletonLock held by live pid ${pid} — not removing.`);
      return;
    }
  } catch {
    // Not a symlink / unreadable — treat as stale
  }
  try { rmSync(lockFile); log("Removed stale SingletonLock."); } catch {}
}

function tryAcquireLock(): boolean {
  mkdirSync(path.dirname(LOCK_FILE), { recursive: true });
  try {
    const fd = openSync(LOCK_FILE, "wx");
    writeSync(fd, String(process.pid));
    closeSync(fd);
    holdingLock = true;
    return true;
  } catch {
    // Lock exists — reclaim it if the owner is dead
    try {
      const ownerPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
      if (!Number.isFinite(ownerPid) || !isProcessAlive(ownerPid)) {
        unlinkSync(LOCK_FILE);
        return tryAcquireLock();
      }
    } catch {}
    return false;
  }
}

async function acquireProfileLock(): Promise<void> {
  if (holdingLock) return;
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
  let waitLogged = false;
  while (Date.now() < deadline) {
    if (tryAcquireLock()) {
      if (waitLogged) log("Profile lock acquired.");
      return;
    }
    if (!waitLogged) {
      log("Profile is in use by another perplexity-web-mcp instance — waiting...");
      waitLogged = true;
    }
    await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
  }
  throw new Error(
    `Profile is locked by another perplexity-web-mcp instance for over ${LOCK_ACQUIRE_TIMEOUT_MS / 1000}s. ` +
    "Retry later or close the other session."
  );
}

function releaseProfileLock(): void {
  if (!holdingLock) return;
  holdingLock = false;
  try {
    const ownerPid = parseInt(readFileSync(LOCK_FILE, "utf-8").trim(), 10);
    if (ownerPid === process.pid) unlinkSync(LOCK_FILE);
  } catch {}
}

export async function launchBrowser(): Promise<void> {
  checkChromiumInstalled();
  if (context) {
    await context.close().catch(() => {});
    context = null;
  }

  await acquireProfileLock();
  removeStaleSingletonLock();

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      ...(executablePath ? { executablePath } : {}),
      acceptDownloads: true,
      viewport: { width: 1280, height: 800 },
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--ozone-platform=x11",
        "--disable-gpu",
        "--window-position=-5000,-5000",
        "--no-focus-on-map",
      ],
    });
  } catch (err) {
    releaseProfileLock();
    throw err;
  }
  // If Chromium dies or the user closes the window, free the profile for others.
  context.on("close", () => {
    context = null;
    clearIdleTimer();
    releaseProfileLock();
  });
}

export async function ensureBrowser(): Promise<void> {
  clearIdleTimer();
  if (!context) { await launchBrowser(); return; }
  // Re-launch if context was closed externally
  try {
    context.pages();
  } catch {
    context = null;
    releaseProfileLock();
    await launchBrowser();
  }
}

export function getContext(): BrowserContext {
  if (!context) throw new Error("Browser not initialized. Call launchBrowser first.");
  return context;
}

export async function newSearchPage(): Promise<Page> {
  return getContext().newPage();
}

export async function getFirstPage(): Promise<Page> {
  const ctx = getContext();
  return ctx.pages()[0] ?? ctx.newPage();
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

// Called after each finished tool call: keeps the browser warm for follow-up
// queries, but releases the profile if no request arrives for IDLE_CLOSE_MS.
export function scheduleIdleClose(): void {
  clearIdleTimer();
  if (!context) return;
  idleTimer = setTimeout(() => {
    log(`Idle for ${IDLE_CLOSE_MS / 1000}s — closing browser to release the profile.`);
    void closeBrowser();
  }, IDLE_CLOSE_MS);
  // Don't keep the node process alive just for the idle timer
  idleTimer.unref?.();
}

export async function closeBrowser(): Promise<void> {
  clearIdleTimer();
  if (context) {
    const ctx = context;
    context = null;
    await ctx.close().catch(() => {});
  }
  releaseProfileLock();
}

// Release the profile on process shutdown so other instances aren't blocked
// until the stale-pid check kicks in.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    releaseProfileLock();
    process.exit(0);
  });
}
process.on("exit", () => releaseProfileLock());
