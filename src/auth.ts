import type { Page } from "playwright";
import { log } from "./logger.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
const AUTH_CHECK_URL = "https://www.perplexity.ai/api/auth/session?version=2.18&source=default";
const POLL_INTERVAL_MS = 2000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface Session {
  user?: { id: string; email?: string };
}

export async function checkSession(page: Page): Promise<boolean> {
  try {
    const response = await page.evaluate(async (url: string) => {
      const res = await fetch(url, { credentials: "include" });
      return res.json();
    }, AUTH_CHECK_URL);

    const session = response as Session;
    return !!session?.user?.id;
  } catch {
    return false;
  }
}

// Drive the login flow on a caller-supplied page. The daemon passes its shared
// visible first tab; the legacy wrapper below acquires it from the singleton
// context. Never creates the browser itself.
export async function ensureAuthenticatedOnPage(page: Page): Promise<void> {
  await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });

  const authenticated = await checkSession(page);
  if (authenticated) {
    log("Session active.");
    return;
  }

  log("No active session. Please log in to Perplexity in the browser window...");
  await waitForLogin(page);
  log("Login detected.");
}

async function waitForLogin(page: Page): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const ok = await checkSession(page);
    if (ok) return;
  }
  throw new Error("Login timeout after 5 minutes.");
}
