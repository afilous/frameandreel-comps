/**
 * Shared scraping utilities — stealth browser launch, jittered delays,
 * retry/backoff, checkpointing, and block-page detection.
 *
 * Used by: emovieposter_scraper.ts, retail_listings_scraper.ts
 */

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";

export const JITTER_RATIO = 0.4;
export const MAX_RETRIES = 2;

export const BLOCK_PAGE_INDICATORS = [
  "captcha",
  "verify you are human",
  "unusual traffic",
  "access denied",
  "temporarily blocked",
];

export function stateDir(scraperName: string): string {
  return path.resolve(process.cwd(), ".scraper-state", scraperName);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sleepJittered(baseMs: number): Promise<void> {
  const jitter = baseMs * JITTER_RATIO * (Math.random() * 2 - 1);
  return sleep(Math.max(200, baseMs + jitter));
}

export async function launchStealthBrowser(): Promise<Browser> {
  try {
    const { chromium: chromiumExtra } = await import("playwright-extra");
    const stealth = (await import("puppeteer-extra-plugin-stealth")).default();
    chromiumExtra.use(stealth);
    return await chromiumExtra.launch({ headless: true });
  } catch {
    try {
      const { chromium: rebrowserChromium } = await import("rebrowser-playwright");
      return await rebrowserChromium.launch({ headless: true });
    } catch {
      return await chromium.launch({ headless: true });
    }
  }
}

export async function createSpoofedContext(
  browser: Browser,
  opts?: { timezoneId?: string; storageStatePath?: string }
): Promise<BrowserContext> {
  const hasSavedSession = opts?.storageStatePath
    ? await fs.access(opts.storageStatePath).then(() => true).catch(() => false)
    : false;

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
    timezoneId: opts?.timezoneId ?? "America/Los_Angeles",
    storageState: hasSavedSession ? opts!.storageStatePath : undefined,
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
    Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3, 4, 5] });
    Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
  });

  await context.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (["image", "media", "font"].includes(type)) {
      return route.abort();
    }
    return route.continue();
  });

  return context;
}

export async function warmUp(page: Page, sites: string[]): Promise<void> {
  for (const site of sites) {
    await page.goto(site, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(1000 + Math.random() * 1000);
  }
}

export async function isBlockPage(page: Page): Promise<boolean> {
  const bodyText = (await page.textContent("body").catch(() => "")) ?? "";
  const lower = bodyText.toLowerCase();
  return BLOCK_PAGE_INDICATORS.some((indicator) => lower.includes(indicator));
}

export async function withRetries<T>(
  label: string,
  fn: () => Promise<T>,
  maxRetries = MAX_RETRIES
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const backoff = 2000 * Math.pow(2, attempt);
        console.warn(`  ${label} failed (attempt ${attempt + 1}), retrying in ${backoff}ms:`, err);
        await sleepJittered(backoff);
      }
    }
  }
  throw lastErr;
}

export async function loadCheckpoint(checkpointPath: string): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(checkpointPath, "utf-8");
    return new Set(JSON.parse(raw));
  } catch {
    return new Set();
  }
}

export async function saveCheckpoint(checkpointPath: string, completed: Set<string>): Promise<void> {
  await fs.mkdir(path.dirname(checkpointPath), { recursive: true });
  await fs.writeFile(checkpointPath, JSON.stringify([...completed], null, 2));
}

export async function runInBatches<T>(
  items: T[],
  concurrency: number,
  baseDelayMs: number,
  handler: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency);
    await Promise.all(batch.map(handler));
    if (i + concurrency < items.length) {
      await sleepJittered(baseDelayMs);
    }
  }
}

export function isWithinYearsBack(dateText: string, yearsBack: number): boolean {
  const parsed = new Date(dateText);
  if (Number.isNaN(parsed.getTime())) return true; // can't parse — keep it rather than silently dropping data
  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - yearsBack);
  return parsed >= cutoff;
}

export async function ingestToBackend(
  endpointEnvVar: string,
  keyEnvVar: string,
  payload: Record<string, unknown>
): Promise<void> {
  const endpoint = process.env[endpointEnvVar];
  const apiKey = process.env[keyEnvVar];
  if (!endpoint || !apiKey) {
    throw new Error(`Missing ${endpointEnvVar} / ${keyEnvVar} env vars`);
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  }
}

// Generic page-walker shared by every eMoviePoster (or future site) scraper
// that needs pagination — used by both emovieposter_scraper.ts (per-title
// archive) and emovieposter_current_auctions.ts (listing pages), instead of
// each hand-rolling its own loop. Handles navigation, block/session-expiry
// checks, stopping on an empty page, jittered delays between pages, and an
// optional early-stop predicate (e.g. "stop once we have enough results").
// extractPage is the only site/page-specific part — just parses whatever's
// on the current page into items.
export async function paginateUntilEmpty<T>(
  page: Page,
  opts: {
    buildUrl: (pageNum: number) => string;
    maxPages: number;
    delayBetweenPagesMs: number;
    extractPage: (page: Page) => Promise<T[]>;
    label: string;
    stopWhen?: (accumulated: T[]) => boolean;
  }
): Promise<T[]> {
  const results: T[] = [];

  for (let pageNum = 1; pageNum <= opts.maxPages; pageNum++) {
    const url = opts.buildUrl(pageNum);
    await page.goto(url, { waitUntil: "domcontentloaded" });

    if (await isBlockPage(page)) {
      throw new Error(`BLOCK_PAGE_DETECTED (${opts.label}, page ${pageNum})`);
    }
    if (page.url().includes("/login")) {
      throw new Error(`SESSION_EXPIRED (${opts.label}, page ${pageNum}) — redirected to login`);
    }

    const pageResults = await opts.extractPage(page);
    console.log(`  ${opts.label} page ${pageNum}: ${pageResults.length} item(s)`);

    if (pageResults.length === 0) break; // empty page — past the end

    results.push(...pageResults);

    if (opts.stopWhen && opts.stopWhen(results)) break;
    if (pageNum < opts.maxPages) await sleepJittered(opts.delayBetweenPagesMs);
  }

  return results;
}
