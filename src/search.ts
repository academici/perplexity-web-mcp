import type { Page } from "playwright";
import { readFile } from "fs/promises";
import { newSearchPage } from "./browser.js";

const PERPLEXITY_HOME = "https://www.perplexity.ai/";
export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEEP_RESEARCH_TIMEOUT_MS = 600_000; // 10 minutes

// Streaming is considered finished when the stop button is gone AND the answer
// text hasn't changed for this long...
const STREAM_STABLE_MS = 2_500;
// ...then we wait a little more before parsing/exporting, so late DOM updates
// (citations, footers, export button) are in place.
const SETTLE_BEFORE_PARSE_MS = 1_500;

// Maps source name to its SVG icon id in the Perplexity UI — locale-independent
const SOURCE_ICON: Record<string, string> = {
  web:      "#pplx-icon-world",
  academic: "#pplx-icon-books",
  social:   "#pplx-icon-social",
};

export interface Source {
  title: string;
  url: string;
}

export interface SearchResult {
  answer: string;
  sources: Source[];
}

const log = (msg: string) => console.error(`[perplexity-web-mcp] ${msg}`);

export async function search(query: string, timeoutMs: number): Promise<SearchResult> {
  log(`Search: "${query}" (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, null, false);
}

export async function searchWithSources(query: string, timeoutMs: number, sources: string[]): Promise<SearchResult> {
  log(`Search: "${query}" sources=[${sources.join(",")}] (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, sources, false);
}

export async function searchDeep(query: string, timeoutMs: number): Promise<SearchResult> {
  log(`Deep Research: "${query}" (timeout: ${timeoutMs}ms)`);
  return runSearch(query, timeoutMs, null, true);
}

async function runSearch(query: string, timeoutMs: number, sources: string[] | null, deepResearch: boolean): Promise<SearchResult> {
  const page = await newSearchPage();

  try {
    log("Navigating to perplexity.ai...");
    await page.goto(PERPLEXITY_HOME, { waitUntil: "domcontentloaded" });
    await dismissDialogs(page);

    // Wait for the search input to be ready before any further interaction
    await page.locator("#ask-input").first().waitFor({ state: "visible", timeout: 10_000 });

    if (deepResearch) {
      await enableDeepResearch(page);
    } else if (sources) {
      log(`Selecting sources: [${sources.join(", ")}]...`);
      await selectSources(page, sources);
    }

    log("Typing query...");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);

    const searchBox = page.locator("#ask-input").first();
    await searchBox.waitFor({ state: "visible", timeout: 10_000 }).catch(async (err) => {
      const bodyHtml = await page.evaluate(() => document.body.innerHTML.slice(0, 5000));
      log(`DOM dump (first 5000 chars):\n${bodyHtml}`);
      throw err;
    });
    await searchBox.click();
    await searchBox.fill(query);
    await searchBox.press("Enter");

    log("Waiting for answer to complete...");
    await waitForAnswerComplete(page, timeoutMs);

    await dismissDialogs(page);

    log("Extracting result...");
    const mdContent = await exportAsMarkdown(page);
    let answer: string;
    let citedSources: Source[];

    if (mdContent) {
      log(`MD export succeeded (${mdContent.length} chars)`);
      answer = mdContent;
      citedSources = [];
    } else {
      log("MD export failed — falling back to DOM extraction");
      [answer, citedSources] = await Promise.all([
        extractAnswer(page),
        extractSources(page),
      ]);
    }

    log(`Done. Answer length: ${answer.length} chars, sources: ${citedSources.length}`);
    return { answer, sources: citedSources };
  } finally {
    // Close only this tab. The browser context stays alive between calls
    // (closing it here killed requests still streaming in parallel tabs);
    // an idle timer in browser.ts releases the profile when unused.
    await page.close().catch(() => {});
  }
}

// True while Perplexity is still generating: a stop button is present.
// Located by icon id (locale-independent) with aria-label fallback.
function isGenerating(): boolean {
  const byIcon = Array.from(document.querySelectorAll("button")).some((b) => {
    const use = b.querySelector("use");
    const href = use?.getAttribute("xlink:href") ?? use?.getAttribute("href") ?? "";
    return href === "#pplx-icon-stop" || href === "#pplx-icon-stop-circle";
  });
  if (byIcon) return true;
  return Array.from(document.querySelectorAll("button")).some((b) => {
    const label = (b.getAttribute("aria-label") ?? "").toLowerCase();
    return label.includes("stop") || label.includes("arrêter") || label.includes("остановить");
  });
}

async function waitForAnswerComplete(page: Page, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  // 1. Wait until the answer has started: answer panel got text, generation
  //    indicator appeared, or (legacy fallback) the "N sources" button showed up.
  await page.waitForFunction(
    `(${isGenerating.toString()})()
      || ((document.querySelector('[role="tabpanel"]')?.textContent ?? '').trim().length > 0)
      || Array.from(document.querySelectorAll('button')).some(b => /\\d/.test(b.textContent ?? ''))`,
    undefined,
    { timeout: timeoutMs },
  );

  // 2. Poll until generation finished: no stop button AND content stable.
  //    Uses the full deadline — deep research streams for many minutes, and a
  //    short cap here used to truncate answers mid-stream.
  let lastContent = "";
  let stableMs = 0;

  while (Date.now() < deadline) {
    const { generating, content } = await page.evaluate(
      `(() => ({
        generating: (${isGenerating.toString()})(),
        content: document.querySelector('[role="tabpanel"]')?.textContent ?? document.body.textContent ?? "",
      }))()`,
    ) as { generating: boolean; content: string };

    if (!generating && content === lastContent) {
      stableMs += 500;
      if (stableMs >= STREAM_STABLE_MS) break;
    } else {
      lastContent = content;
      stableMs = 0;
    }
    await page.waitForTimeout(500);
  }

  // 3. Grace period before parsing/export — let the final DOM mutations
  //    (citations, export controls) land.
  await page.waitForTimeout(SETTLE_BEFORE_PARSE_MS);
}

async function exportAsMarkdown(page: Page): Promise<string | null> {
  try {
    // .catch prevents unhandled rejection if page closes before download triggers
    const downloadPromise = page.waitForEvent("download", { timeout: 8_000 }).catch(() => null);

    // Click the download button (#pplx-icon-download / "Скачать")
    const iconClicked = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll("button, [role='button']")).find((b) => {
        const use = b.querySelector("use");
        return use && (use.getAttribute("xlink:href") === "#pplx-icon-download" || use.getAttribute("href") === "#pplx-icon-download");
      });
      if (btn) { (btn as HTMLElement).click(); return true; }
      return false;
    });

    if (!iconClicked) return null;

    // Submenu may appear — look for Markdown option
    await page.waitForTimeout(400);
    const mdItem = page.locator(
      '[role="menuitem"]:has-text("Markdown"), [role="option"]:has-text("Markdown"), [role="menuitem"]:has-text("markdown" )'
    ).first();
    if (await mdItem.isVisible({ timeout: 1_500 }).catch(() => false)) {
      await mdItem.click();
    }

    const download = await downloadPromise;
    if (!download) return null;
    const filePath = await download.path();
    if (!filePath) return null;

    return readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

async function enableDeepResearch(page: Page): Promise<void> {
  log("Enabling deep research mode...");

  // Strategy 1: SVG icon ID — same locale-independent pattern used by selectSources
  const iconClicked = await page.evaluate(() => {
    const candidates = ["#pplx-icon-deep-research", "#pplx-icon-microscope", "#pplx-icon-research"];
    for (const id of candidates) {
      const btn = Array.from(document.querySelectorAll("button")).find((b) => {
        const use = b.querySelector("use");
        return use && (use.getAttribute("xlink:href") === id || use.getAttribute("href") === id);
      });
      if (btn) { (btn as HTMLElement).click(); return id; }
    }
    return null;
  });

  if (iconClicked) {
    log(`Deep research activated via icon ${iconClicked}`);
    await page.waitForTimeout(500);
    return;
  }

  // Strategy 2: visible button by text or aria-label
  const textSelectors = [
    'button:has-text("Deep Research")',
    'button:has-text("Recherche approfondie")',
    'button[aria-label*="Deep Research"]',
    'button[aria-label*="deep research" i]',
  ];
  for (const sel of textSelectors) {
    const btn = page.locator(sel).first();
    if (await btn.isVisible({ timeout: 1_000 }).catch(() => false)) {
      await btn.click();
      log(`Deep research activated via: ${sel}`);
      await page.waitForTimeout(500);
      return;
    }
  }

  log("Warning: deep research toggle not found — proceeding with default mode.");
}

// Selects the given sources in the Perplexity "Connecteurs et sources" submenu.
// All icon IDs are locale-independent — they don't change with UI language.
async function selectSources(page: Page, sources: string[]): Promise<void> {
  const targetIcons = sources.map(s => SOURCE_ICON[s]).filter(Boolean);
  if (targetIcons.length === 0) return;

  // Open the "+" menu — located by its icon #pplx-icon-plus
  const addBtnLabel = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button[aria-haspopup="menu"]')).find(b => {
      const use = b.querySelector('use');
      return use && (use.getAttribute('xlink:href') === '#pplx-icon-plus' || use.getAttribute('href') === '#pplx-icon-plus');
    });
    return btn?.getAttribute('aria-label') ?? null;
  });
  if (!addBtnLabel) throw new Error("Could not find the + (add) button on Perplexity");
  await page.locator(`button[aria-label="${addBtnLabel}"]`).click();
  await page.waitForTimeout(300);

  // Open "Connecteurs et sources" submenu — located by its icon #pplx-icon-plug
  const connLabel = await page.evaluate(() => {
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find(el => {
      const use = el.querySelector('use');
      return use && (use.getAttribute('xlink:href') === '#pplx-icon-plug' || use.getAttribute('href') === '#pplx-icon-plug');
    });
    return item?.getAttribute('aria-label') ?? item?.textContent?.trim() ?? null;
  });
  if (!connLabel) throw new Error("Could not find 'Connecteurs et sources' menuitem");
  await page.locator('[role="menuitem"]').filter({ hasText: connLabel.slice(0, 10) }).click();
  await page.locator('[role="menuitemcheckbox"]').first().waitFor({ state: "visible", timeout: 3_000 });

  // Read current state of all checkboxes
  const getCheckboxInfo = (iconId: string) => page.evaluate((id) => {
    const item = Array.from(document.querySelectorAll('[role="menuitemcheckbox"]')).find(el => {
      const use = el.querySelector('use');
      return use && (use.getAttribute('xlink:href') === id || use.getAttribute('href') === id);
    });
    return item ? { label: item.getAttribute('aria-label') ?? item.textContent?.trim() ?? "", checked: item.getAttribute('aria-checked') === 'true' } : null;
  }, iconId);

  // Build the desired state: check targets, uncheck everything else
  const allIcons = Object.values(SOURCE_ICON);
  for (const icon of allIcons) {
    const info = await getCheckboxInfo(icon);
    if (!info || !info.label) continue;
    const shouldBeChecked = targetIcons.includes(icon);
    if (info.checked !== shouldBeChecked) {
      await page.locator('[role="menuitemcheckbox"]').filter({ hasText: info.label }).click();
      await page.waitForTimeout(200);
    }
  }

  // Close menus
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

async function dismissDialogs(page: Page): Promise<void> {
  // Cookie banner — "Cookies nécessaires" / "Necessary cookies"
  const cookieBtn = page.locator(
    'button:has-text("Cookies nécessaires"), button:has-text("Necessary cookies")'
  ).first();
  if (await cookieBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing cookie banner...");
    await cookieBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }

  // Login/signup overlay — Perplexity renders this as a generic div, not a <dialog>.
  // The close button text is "Fermer" (FR) or has aria-label "Close" (EN).
  const closeBtn = page.locator(
    'button:has-text("Fermer"), button[aria-label="Close"], button[aria-label="Fermer"]'
  ).first();
  if (await closeBtn.isVisible({ timeout: 1_500 }).catch(() => false)) {
    log("Dismissing login overlay...");
    await closeBtn.click().catch(() => {});
    await page.waitForTimeout(300);
  }
}

async function extractAnswer(page: Page): Promise<string> {
  return page.evaluate(() => {
    const panel = document.querySelector('[role="tabpanel"]');
    if (!panel) return "";

    function getCleanText(el: Element): string {
      let text = "";
      for (const node of Array.from(el.childNodes)) {
        if (node.nodeType === Node.TEXT_NODE) {
          text += node.textContent ?? "";
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const child = node as Element;
          const style = window.getComputedStyle(child);
          // Skip citation chips: pointer cursor + short text (e.g. "wikipedia+3")
          if (style.cursor === "pointer" && (child.textContent?.trim().length ?? 0) < 40) {
            continue;
          }
          text += getCleanText(child);
        }
      }
      return text;
    }

    const parts: string[] = [];
    const seen = new Set<string>();

    panel.querySelectorAll("h2, h3, p, li, pre code").forEach((el) => {
      if (el.tagName === "P" && el.closest("li")) return;
      if (el.tagName === "LI" && el.querySelector("li")) return;

      const tag = el.tagName.toLowerCase();
      const text = getCleanText(el).trim().replace(/\s+/g, " ");
      if (!text || seen.has(text)) return;
      seen.add(text);

      if (tag === "h2" || tag === "h3") {
        parts.push(`\n## ${text}\n`);
      } else if (tag === "code") {
        parts.push(`\`\`\`\n${text}\n\`\`\``);
      } else if (tag === "li") {
        parts.push(`- ${text}`);
      } else {
        parts.push(text);
      }
    });

    return parts.join("\n").trim();
  });
}

async function extractSources(page: Page): Promise<Source[]> {
  return page.evaluate(() => {
    const sources: { title: string; url: string }[] = [];
    const seen = new Set<string>();

    document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((link) => {
      const url = link.href;
      if (seen.has(url) || url.includes("perplexity.ai")) return;
      seen.add(url);
      const title = link.textContent?.trim() || new URL(url).hostname;
      sources.push({ title, url });
    });

    return sources.slice(0, 10);
  });
}
