/**
 * eMoviePoster CURRENT auctions scraper — goal #1: see upcoming auctions to
 * decide what to bid on and how much. Distinct from emovieposter_scraper.ts
 * (goal #2: historical realized sales for comps, which needs login — this
 * one does not).
 *
 * CONFIRMED (from real screenshots):
 *   - No login required.
 *   - Three separate, STABLE per-day category IDs (confirmed directly):
 *       Tuesday = 13, Thursday = 14, Sunday = 15
 *     URL pattern: https://www.emovieposter.com/agallery/mode/2/{id}.html
 *     (mode/2 = Text — no thumbnails, real <table> markup, lightest fetch;
 *     mode/0 = Grid is the default with thumbnails; mode/1 = List, also a
 *     real table but with thumbnails. Each mode has a DIFFERENT URL, not
 *     just a display toggle — confirmed directly.)
 *   - https://www.emovieposter.com/agallery/all.html — the "aggregate
 *     everything" page — returns a REAL page (confirmed via screenshot,
 *     2,069 items = Tuesday + Thursday combined) but the scraper found
 *     ZERO table rows on it in an actual run. Likely uses a different
 *     underlying template (div/card-based) than the per-day mode/2 pages,
 *     even though it displays similarly. NOT used as the default anymore
 *     — hitting the three known per-day IDs directly is more reliable.
 *   - Real table structure confirmed via visible header row, consistent
 *     across all per-day pages regardless of mode:
 *       Thumbnail | Auction Title/Condition Grade/High Bidder | Recent Price | Time Left | Bid
 *     5 columns. Column 2 packs title + condition grade + bidder status
 *     into one cell as multi-line text (not 3 separate cells) — parsed by
 *     splitting that cell's own text, not the whole page's.
 *   - No "Starting Price:"/"Recent Price:" labels — just a bare "$1.00" in
 *     its own column. Whether that's a starting price or an actual bid can
 *     only be inferred from the adjacent status line ("No Bids Yet" vs
 *     "High Bidder: {name}").
 *   - Item codes match the pattern seen everywhere on the site: digit +
 *     letter + 4 digits (e.g. "2f0083", "2f0229").
 *   - The duplicate-title-line artifact (an apostrophe splitting an <img>
 *     alt from a separate link's full text) still shows up within column
 *     2's own text — handled the same way as before (keep the longer line
 *     if one is a prefix of the other).
 *   - Items-per-page dropdown (40/80/120/160/200) is a real, separate
 *     per-mode setting — text mode showed 160 as the current selection in
 *     one screenshot vs 80 for grid mode, so this may reset per mode
 *     rather than persisting; not something this scraper controls, it
 *     just reads whatever the default renders.
 *
 * STILL OPEN:
 *   - Whether IDs 13/14/15 are truly PERMANENT (stable across many future
 *     auction cycles) or just happen to be stable right now — worth
 *     rechecking occasionally, especially around special/major auctions
 *     (the calendar mentioned "August Major Auction", "Elvis auction" etc.
 *     which might use different IDs than the regular weekly 13/14/15)
 *   - Real pagination URL pattern for these pages — not yet confirmed
 *     (does page 2 add a /page/{n}/ segment like the historical archive,
 *     or something else?) — still following the page's own "Next" link
 *     rather than guessing, which doesn't depend on knowing this
 *   - Whether Time Left actually appears in the DOM at scrape time, or is
 *     rendered by client-side JS after a delay — using 'networkidle' wait
 *     to be safe, but unverified
 *
 * Does NOT compute suggested_max_bid — that's the valuation engine's job,
 * comparing against poster_auctions history. This scraper only collects
 * what's currently up for bid. Read-only throughout: never places a bid.
 */

import type { Page } from "playwright";
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
    await page.goto(currentUrl, { waitUntil: "networkidle" });

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
