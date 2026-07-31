/**
 * eMoviePoster CURRENT auctions scraper — goal #1: see upcoming auctions to
 * decide what to bid on and how much. Distinct from emovieposter_scraper.ts
 * (goal #2: historical realized sales for comps).
 *
 * CONFIRMED WORKING (real run, 2026-07-31): no login needed. Three stable
 * category IDs (Tuesday=13, Thursday=14, Sunday=15) at
 * https://www.emovieposter.com/agallery/mode/2/{id}.html. A full real run
 * found 2,790 items total (1,343 Tuesday + 723 Thursday + 724 Sunday),
 * matching known real scale, with correct pagination all the way through
 * (17 pages for Tuesday, correctly stopping on the final partial page).
 *
 * Uses whole-page TEXT parsing (not DOM table selectors) — earlier
 * attempts assuming a clean <table>/<tr>/<td> structure repeatedly failed
 * even against confirmed-real markup, for reasons that were never fully
 * resolved (possibly transient server behavior toward automated requests
 * during heavy testing). Text parsing sidesteps that entirely: it reads
 * whatever's visible and pattern-matches on labels confirmed present in
 * every real listing ("Condition Grade:", "No Bids Yet" / "High Bidder:",
 * the item-code prefix like "2f0102"). This approach is what actually
 * worked at full scale.
 *
 * FIXED BUG: some rows render bidder/price/time-left on ONE line with TAB
 * characters between them (e.g. "High Bidder: PunchItBaby\t$925.00\t  4
 * days 2 hours") rather than clean separate newlines — confirmed from a
 * real failing sample row. Fix: split on tabs as well as newlines before
 * line-by-line parsing, so each tab-separated segment gets matched
 * independently by the existing per-line rules.
 */

import type { Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import {
  launchStealthBrowser,
  createSpoofedContext,
  warmUp,
  withRetries,
  isBlockPage,
  sleepJittered,
} from "./lib/scrape-core";

const ARCHIVE_BASE_URL = "https://www.emovieposter.com";
const WARM_UP_SITES = ["https://www.google.com", "https://www.wikipedia.org"];
const MAX_LISTING_PAGES = 40; // safety cap — real scale is ~10-17 pages per auction day

const DEFAULT_AUCTION_DAYS: Record<string, string> = {
  tuesday: "13",
  thursday: "14",
  sunday: "15",
};

function buildDayUrl(categoryId: string): string {
  return `${ARCHIVE_BASE_URL}/agallery/mode/2/${categoryId}.html`;
}

interface CurrentAuctionRow {
  itemCode: string | null;
  titleRaw: string;
  conditionGrade: string;
  priceType: "starting" | "current";
  price: number;
  highBidder: string | null;
  timeLeftRaw: string | null;
  auctionDay: string;
  scrapedAt: string;
  sourceUrl: string;
}

const ITEM_CODE_LINE = /^([0-9][a-z]\d{4})\s+(.*)$/;

function dedupeTitleLines(lines: string[]): string {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length === 0) return "";
  if (nonEmpty.length === 1) return nonEmpty[0];
  const longest = nonEmpty.reduce((a, b) => (b.length > a.length ? b : a));
  const allArePrefixesOfLongest = nonEmpty.every((l) => longest.startsWith(l));
  if (allArePrefixesOfLongest) return longest;
  return nonEmpty.join(" ").replace(/\s+/g, " ").trim();
}

function parseListingText(rawText: string, sourceUrl: string, auctionDay: string): CurrentAuctionRow[] {
  const scrapedAt = new Date().toISOString();
  // FIX: split on tabs too — some rows pack bidder/price/time-left onto one
  // tab-separated line rather than clean separate newlines. Confirmed from
  // a real failing row: "High Bidder: X\t$925.00\t  4 days 2 hours".
  const lines = rawText
    .split("\n")
    .flatMap((l) => l.split("\t"))
    .map((l) => l.trim())
    .filter(Boolean);

  const items: CurrentAuctionRow[] = [];

  let current: {
    itemCode: string;
    titleLines: string[];
    conditionGrade?: string;
    highBidder?: string | null;
    price?: number;
    timeLeftRaw?: string;
  } | null = null;

  const flush = () => {
    if (!current) return;
    if (current.conditionGrade) {
      items.push({
        itemCode: current.itemCode,
        titleRaw: dedupeTitleLines(current.titleLines),
        conditionGrade: current.conditionGrade,
        priceType: current.highBidder ? "current" : "starting",
        price: current.price ?? 0,
        highBidder: current.highBidder ?? null,
        timeLeftRaw: current.timeLeftRaw ?? null,
        auctionDay,
        scrapedAt,
        sourceUrl,
      });
    }
    current = null;
  };

  for (const line of lines) {
    const codeMatch = line.match(ITEM_CODE_LINE);
    if (codeMatch) {
      const [, code, rest] = codeMatch;
      if (current && current.itemCode === code) {
        current.titleLines.push(rest); // duplicate-title artifact — absorb
      } else {
        flush();
        current = { itemCode: code, titleLines: [rest] };
      }
      continue;
    }

    if (!current) continue;

    if (line.startsWith("Condition Grade:")) {
      current.conditionGrade = line.replace("Condition Grade:", "").trim();
    } else if (line.startsWith("High Bidder:")) {
      current.highBidder = line.replace("High Bidder:", "").trim();
    } else if (line === "No Bids Yet") {
      current.highBidder = null;
    } else if (line.startsWith("Starting Price:") || line.startsWith("Recent Price:")) {
      const num = parseFloat(line.replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(num)) current.price = num;
    } else if (/^\$[\d,]+(\.\d{2})?$/.test(line)) {
      const num = parseFloat(line.replace(/[^0-9.]/g, ""));
      if (!Number.isNaN(num)) current.price = num;
    } else if (line.startsWith("Time Left:")) {
      current.timeLeftRaw = line.replace("Time Left:", "").trim();
    } else if (/^\d+\s+(day|hour|minute)s?(\s|$)/i.test(line)) {
      current.timeLeftRaw = line;
    } else if (!current.conditionGrade) {
      current.titleLines.push(line);
    }
  }
  flush();

  return items;
}

async function logDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const title = await page.title();
    const url = page.url();
    const bodyTextSnippet = (await page.textContent("body").catch(() => "")) ?? "";
    const htmlLength = (await page.content()).length;

    console.log(`  [DIAGNOSTIC ${label}]`);
    console.log(`    final URL: ${url}`);
    console.log(`    page title: "${title}"`);
    console.log(`    total HTML length: ${htmlLength} chars`);
    console.log(`    body text (first 800 chars): ${bodyTextSnippet.slice(0, 800).replace(/\s+/g, " ")}`);

    const screenshotsDir = path.resolve(process.cwd(), "screenshots");
    await fs.mkdir(screenshotsDir, { recursive: true });
    const screenshotPath = path.join(screenshotsDir, `${label.replace(/[^a-z0-9]/gi, "_")}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`    screenshot saved: ${screenshotPath}`);
  } catch (err) {
    console.log(`  [DIAGNOSTIC ${label}] failed to collect diagnostics:`, err);
  }
}

async function extractListingPage(page: Page, auctionDay: string): Promise<CurrentAuctionRow[]> {
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText);
  const results = parseListingText(bodyText, url, auctionDay);

  console.log(`    (parsed from whole-page text: ${results.length} valid item(s) with a Condition Grade)`);

  if (results.length === 0) {
    await logDiagnostics(page, `${auctionDay}_zero_results`);
  }

  return results;
}

async function scrapeListing(page: Page, startUrl: string, auctionDay: string): Promise<CurrentAuctionRow[]> {
  const allResults: CurrentAuctionRow[] = [];
  let currentUrl = startUrl;

  for (let pageNum = 1; pageNum <= MAX_LISTING_PAGES; pageNum++) {
    const response = await page.goto(currentUrl, { waitUntil: "networkidle" });
    console.log(`  ${auctionDay} page ${pageNum}: HTTP status ${response?.status() ?? "unknown"}`);

    if (await isBlockPage(page)) {
      throw new Error(`BLOCK_PAGE_DETECTED while scraping ${auctionDay} (page ${pageNum})`);
    }

    const pageResults = await extractListingPage(page, auctionDay);
    console.log(`  ${auctionDay} page ${pageNum}: ${pageResults.length} item(s)`);

    if (pageResults.length === 0) {
      console.log(`  ${auctionDay}: no items parsed — stopping this day's pagination`);
      break;
    }

    allResults.push(...pageResults);

    const nextLink = page.locator("a:has-text('Next')").first();
    const hasNext = (await nextLink.count()) > 0 && (await nextLink.isVisible().catch(() => false));
    if (!hasNext) break;

    const nextHref = await nextLink.getAttribute("href").catch(() => null);
    if (!nextHref) break;
    currentUrl = new URL(nextHref, currentUrl).toString();

    await sleepJittered(1200);
  }

  return allResults;
}

// Writes directly to Supabase's REST API (current_auction_watch table) —
// same anon-key pattern already proven working for bid_watchlist, no
// custom backend endpoint needed. Batches inserts since Supabase/PostgREST
// handles large single POSTs poorly; a few thousand rows in one request is
// asking for trouble.
const SUPABASE_INSERT_BATCH_SIZE = 500;

async function upsertCurrentAuctions(rows: CurrentAuctionRow[]): Promise<void> {
  if (rows.length === 0) return;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;

  // Skip quietly (not a failure) if no destination is configured — this is
  // expected during testing/verification, not an error. A prior version of
  // this function threw on missing config, which hard-failed a fully
  // successful scrape run purely because persistence wasn't wired up yet.
  if (!supabaseUrl || !supabaseKey) {
    console.log(
      `Skipping ingest — SUPABASE_URL/SUPABASE_ANON_KEY not configured. ${rows.length} row(s) were found and logged above but not persisted anywhere.`
    );
    return;
  }

  const payloadRows = rows.map((r) => ({
    item_code: r.itemCode,
    title_raw: r.titleRaw,
    condition_grade: r.conditionGrade,
    price_type: r.priceType,
    price: r.price,
    high_bidder: r.highBidder,
    time_left_raw: r.timeLeftRaw,
    auction_day: r.auctionDay,
    scraped_at: r.scrapedAt,
    source_url: r.sourceUrl,
  }));

  for (let i = 0; i < payloadRows.length; i += SUPABASE_INSERT_BATCH_SIZE) {
    const batch = payloadRows.slice(i, i + SUPABASE_INSERT_BATCH_SIZE);
    const res = await fetch(`${supabaseUrl}/rest/v1/current_auction_watch`, {
      method: "POST",
      headers: {
        apikey: supabaseKey,
        Authorization: `Bearer ${supabaseKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(batch),
    });
    if (!res.ok) {
      throw new Error(`Supabase insert failed (batch starting at ${i}): ${res.status} ${await res.text()}`);
    }
    console.log(`  inserted rows ${i + 1}-${i + batch.length} of ${payloadRows.length}`);
  }
}

async function main() {
  const overrideUrl = process.env.LISTING_URL;

  const browser = await launchStealthBrowser();
  const context = await createSpoofedContext(browser); // confirmed: no login needed
  const page = await context.newPage();

  const allRows: CurrentAuctionRow[] = [];

  try {
    await warmUp(page, WARM_UP_SITES);

    if (overrideUrl) {
      console.log(`Scraping current auctions from override URL: ${overrideUrl}...`);
      const rows = await withRetries("scrape current auctions (override)", () =>
        scrapeListing(page, overrideUrl, "custom")
      );
      allRows.push(...rows);
    } else {
      for (const [day, categoryId] of Object.entries(DEFAULT_AUCTION_DAYS)) {
        const dayUrl = buildDayUrl(categoryId);
        console.log(`Scraping ${day} (category ${categoryId}): ${dayUrl}...`);
        try {
          const rows = await withRetries(`scrape ${day}`, () => scrapeListing(page, dayUrl, day));
          console.log(`  ${day}: ${rows.length} item(s) total`);
          allRows.push(...rows);
        } catch (err) {
          console.error(`  ${day} failed, continuing with remaining days:`, err);
        }
        await sleepJittered(1500);
      }
    }

    console.log(`Found ${allRows.length} current auction item(s) total across all days.`);
    if (allRows.length > 0) {
      console.log("Sample row:", JSON.stringify(allRows[0], null, 2));
    }

    await withRetries("upsert current auctions", () => upsertCurrentAuctions(allRows));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Current-auctions scrape failed:", err);
  process.exit(1);
});
