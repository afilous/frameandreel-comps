/**
 * eMoviePoster CURRENT auctions scraper — goal #1: see upcoming auctions to
 * decide what to bid on and how much. Distinct from emovieposter_scraper.ts
 * (goal #2: historical realized sales for comps, which needs login — this
 * one does not).
 *
 * See git history / conversation for the full confirmed-structure notes.
 * Short version: no login needed; three stable category IDs (Tuesday=13,
 * Thursday=14, Sunday=15) at https://www.emovieposter.com/agallery/mode/2/{id}.html;
 * confirmed via real screenshots to be a genuine <table> with columns
 * Thumbnail | Auction Title/Condition Grade/High Bidder | Recent Price | Time Left | Bid.
 *
 * CURRENT PROBLEM: three consecutive real runs against these confirmed
 * URLs all returned 0 items on every day, with no errors, no block-page
 * detection triggering, and no timeouts — meaning page.goto() succeeds and
 * $$eval("table tr", ...) finds nothing, despite screenshots showing real
 * table content at these exact URLs. Added real diagnostics below (screenshot
 * on zero-results, page title, raw HTML snippet, table-element count) since
 * guessing at another cause blind hasn't been productive — the artifact
 * upload / log output from the NEXT run should show what Playwright is
 * actually seeing (e.g. a login wall, a different template, an empty shell
 * page, a bot-check page our isBlockPage() keyword list doesn't catch).
 */

import type { Page } from "playwright";
import { promises as fs } from "fs";
import path from "path";
import {
  launchStealthBrowser,
  createSpoofedContext,
  warmUp,
  withRetries,
  ingestToBackend,
  isBlockPage,
  sleepJittered,
} from "./lib/scrape-core";

const ARCHIVE_BASE_URL = "https://www.emovieposter.com";
const WARM_UP_SITES = ["https://www.google.com", "https://www.wikipedia.org"];
const MAX_LISTING_PAGES = 40; // safety cap — real scale is ~10-12 pages per auction day
const SCREENSHOTS_DIR = path.resolve(process.cwd(), "screenshots");

// Confirmed stable category IDs — see header notes above.
const DEFAULT_AUCTION_DAYS: Record<string, string> = {
  tuesday: "13",
  thursday: "14",
  sunday: "15",
};

function buildDayUrl(categoryId: string): string {
  return `${ARCHIVE_BASE_URL}/agallery/mode/2/${categoryId}.html`; // mode/2 = Text, real table, no thumbnails
}

interface CurrentAuctionRow {
  itemCode: string;
  titleRaw: string;
  conditionGrade: string;
  priceType: "starting" | "current"; // inferred from "No Bids Yet" vs "High Bidder:"
  price: number;
  highBidder: string | null;
  timeLeftRaw: string | null; // null if not present in the DOM at scrape time — see header note
  auctionDay: string;         // 'tuesday' | 'thursday' | 'sunday' | 'custom' (when LISTING_URL overrides)
  scrapedAt: string;
  sourceUrl: string;
}

const ITEM_CODE_PREFIX = /^([0-9][a-z]\d{4})\s+(.*)$/;

// Handles the truncated-then-full title artifact within one cell's text:
// if one line is a prefix of another, keep only the longer one.
function dedupeTitleLines(lines: string[]): string {
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  if (nonEmpty.length <= 1) return (nonEmpty[0] ?? "").trim();
  const longest = nonEmpty.reduce((a, b) => (b.length > a.length ? b : a));
  const allArePrefixesOfLongest = nonEmpty.every((l) => longest.startsWith(l));
  if (allArePrefixesOfLongest) return longest;
  return nonEmpty.join(" ").replace(/\s+/g, " ").trim();
}

// Parses column 2's own multi-line text (title + Condition Grade + bidder
// status all packed into one cell) into structured pieces.
function parseCombinedCell(cellText: string): {
  itemCode: string | null;
  titleRaw: string;
  conditionGrade: string;
  highBidder: string | null;
} {
  const lines = cellText.split("\n").map((l) => l.trim()).filter(Boolean);
  const titleLines: string[] = [];
  let itemCode: string | null = null;
  let conditionGrade = "";
  let highBidder: string | null = null;

  for (const line of lines) {
    if (line.startsWith("Condition Grade:")) {
      conditionGrade = line.replace("Condition Grade:", "").trim();
    } else if (line.startsWith("High Bidder:")) {
      highBidder = line.replace("High Bidder:", "").trim();
    } else if (line === "No Bids Yet") {
      highBidder = null;
    } else {
      const codeMatch = line.match(ITEM_CODE_PREFIX);
      if (codeMatch) {
        if (!itemCode) itemCode = codeMatch[1];
        titleLines.push(codeMatch[2]);
      } else {
        titleLines.push(line);
      }
    }
  }

  return { itemCode, titleRaw: dedupeTitleLines(titleLines), conditionGrade, highBidder };
}

// Diagnostics — runs whenever a page yields zero parsed rows, so we get
// real visibility into what Playwright actually saw instead of guessing.
async function logDiagnostics(page: Page, label: string): Promise<void> {
  try {
    const title = await page.title();
    const url = page.url();
    const tableCount = await page.$$eval("table", (tables) => tables.length);
    const trCount = await page.$$eval("tr", (rows) => rows.length);
    const bodyTextSnippet = (await page.textContent("body").catch(() => "")) ?? "";
    const htmlLength = (await page.content()).length;

    console.log(`  [DIAGNOSTIC ${label}]`);
    console.log(`    final URL: ${url}`);
    console.log(`    page title: "${title}"`);
    console.log(`    <table> elements found: ${tableCount}`);
    console.log(`    <tr> elements found (any table): ${trCount}`);
    console.log(`    total HTML length: ${htmlLength} chars`);
    console.log(`    body text (first 500 chars): ${bodyTextSnippet.slice(0, 500).replace(/\s+/g, " ")}`);

    await fs.mkdir(SCREENSHOTS_DIR, { recursive: true });
    const screenshotPath = path.join(SCREENSHOTS_DIR, `${label.replace(/[^a-z0-9]/gi, "_")}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    console.log(`    screenshot saved: ${screenshotPath} (check the 'Upload logs' artifact for this run)`);
  } catch (err) {
    console.log(`  [DIAGNOSTIC ${label}] failed to collect diagnostics:`, err);
  }
}

async function extractListingPage(page: Page, auctionDay: string): Promise<CurrentAuctionRow[]> {
  const scrapedAt = new Date().toISOString();
  const url = page.url();

  const rawRows = await page.$$eval("table tr", (rows) =>
    rows.map((row) => Array.from(row.querySelectorAll("td")).map((td) => (td as HTMLElement).innerText ?? ""))
  );

  const results: CurrentAuctionRow[] = [];

  for (const cells of rawRows) {
    // Confirmed 5-column shape: Thumbnail | combined title/condition/bidder | Price | Time Left | Bid
    if (cells.length < 4) continue;

    const combined = parseCombinedCell(cells[1] ?? "");
    if (!combined.itemCode) continue; // header row or malformed row — skip

    const priceRaw = (cells[2] ?? "").trim();
    const price = parseFloat(priceRaw.replace(/[^0-9.]/g, ""));
    if (Number.isNaN(price)) continue;

    const timeLeftRaw = (cells[3] ?? "").trim() || null;

    results.push({
      itemCode: combined.itemCode,
      titleRaw: combined.titleRaw,
      conditionGrade: combined.conditionGrade,
      priceType: combined.highBidder ? "current" : "starting",
      price,
      highBidder: combined.highBidder,
      timeLeftRaw,
      auctionDay,
      scrapedAt,
      sourceUrl: url,
    });
  }

  if (results.length === 0) {
    await logDiagnostics(page, `${auctionDay}_zero_results`);
  }

  return results;
}

// Follows the page's own "Next" link rather than constructing page URLs —
// pagination pattern for these numbered category pages isn't confirmed yet.
async function scrapeListing(page: Page, startUrl: string, auctionDay: string): Promise<CurrentAuctionRow[]> {
  const allResults: CurrentAuctionRow[] = [];
  let currentUrl = startUrl;

  for (let pageNum = 1; pageNum <= MAX_LISTING_PAGES; pageNum++) {
    // networkidle rather than domcontentloaded — Time Left may be a
    // client-rendered countdown widget that hasn't populated yet at
    // domcontentloaded. Unverified whether this is actually necessary.
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

async function upsertCurrentAuctions(rows: CurrentAuctionRow[]): Promise<void> {
  if (rows.length === 0) return;
  await ingestToBackend("FRAMEANDREEL_INGEST_URL_CURRENT_AUCTIONS", "FRAMEANDREEL_INGEST_KEY", {
    source: "emovieposter_current",
    captureMethod: "automated_scrape",
    auctions: rows,
  });
}

async function main() {
  // If LISTING_URL is explicitly set, use ONLY that (ad-hoc single-page
  // testing/override) — otherwise default to hitting all three known,
  // confirmed-stable day category IDs and combining results.
  const overrideUrl = process.env.LISTING_URL;

  const browser = await launchStealthBrowser();
  const context = await createSpoofedContext(browser); // no login needed
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
