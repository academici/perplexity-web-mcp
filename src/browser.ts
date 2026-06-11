import { chromium, type BrowserContext, type Page } from "playwright";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = path.resolve(__dirname, "../.playwright/profile");

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

export async function launchBrowser(): Promise<void> {
  checkChromiumInstalled();
  if (context) {
    await context.close();
    context = null;
  }

  // Remove stale lock left by a crashed previous instance
  const lockFile = path.join(PROFILE_DIR, "SingletonLock");
  if (existsSync(lockFile)) {
    try { rmSync(lockFile); } catch {}
  }

  const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
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
}

export async function ensureBrowser(): Promise<void> {
  if (!context) { await launchBrowser(); return; }
  // Re-launch if context was closed externally
  try {
    context.pages();
  } catch {
    context = null;
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

export async function closeBrowser(): Promise<void> {
  if (context) {
    await context.close();
    context = null;
  }
}
