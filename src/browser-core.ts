import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { execSync } from "child_process";
import { existsSync, rmSync, readlinkSync, mkdirSync } from "fs";
import { log } from "./logger.js";

// Daemon-owned persistent context. Unlike legacy browser.ts this carries NO
// cross-process PID lock and NO idle-for-handoff timer and registers NO signal
// handlers — the daemon is the single owner of its profile and manages its own
// lifecycle. One context per process; the profile dir is fixed at launch.

let context: BrowserContext | null = null;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function checkChromiumInstalled(): void {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) return;
  try {
    execSync("npx playwright install --dry-run chromium", { stdio: "ignore" });
  } catch {
    // dry-run not available in all versions — fall through
  }
  try {
    chromium.executablePath();
  } catch {
    log(
      "Chromium is not installed. Run: npx playwright install chromium " +
      "(or set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/chromium)"
    );
    throw new Error("Chromium is not installed");
  }
}

// Chromium's SingletonLock is a symlink to "<hostname>-<pid>". Remove it only
// when the owning process is dead — deleting it while a live instance owns the
// profile corrupts that instance.
export function removeStaleSingletonLock(profileDir: string): void {
  const lockFile = path.join(profileDir, "SingletonLock");
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

export async function launchContext(profileDir: string): Promise<BrowserContext> {
  if (context) return context;
  checkChromiumInstalled();
  mkdirSync(profileDir, { recursive: true });
  removeStaleSingletonLock(profileDir);

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  context = await chromium.launchPersistentContext(profileDir, {
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
  context.on("close", () => { context = null; });
  return context;
}

export function getContext(): BrowserContext {
  if (!context) throw new Error("Browser context not initialized. Call launchContext first.");
  return context;
}

export function isContextAlive(): boolean {
  if (!context) return false;
  try { context.pages(); return true; } catch { return false; }
}

export async function newSearchPage(): Promise<Page> {
  return getContext().newPage();
}

export async function getFirstPage(): Promise<Page> {
  const ctx = getContext();
  return ctx.pages()[0] ?? ctx.newPage();
}

export async function closeContext(): Promise<void> {
  if (!context) return;
  const ctx = context;
  context = null;
  await ctx.close().catch(() => {});
}
