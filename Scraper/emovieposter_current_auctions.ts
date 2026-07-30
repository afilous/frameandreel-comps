/**
 * eMoviePoster CURRENT auctions scraper — goal #1: see upcoming auctions to
 * decide what to bid on and how much. Distinct from emovieposter_scraper.ts
 * (goal #2: historical realized sales for comps, which needs login — this
 * one does not).
 *
 * CONFIRMED (from real screenshots + pasted List-mode table output):
 *   - No login required.
 *   - "All Auctions" aggregates every current auction under ONE stable URL:
 *       https://www.emovieposter.com/agallery/all.html
 *     Confirmed via a real screenshot showing 2,069 items = 1,345 (Tuesday
 *     "flat") + 724 (Thursday "rolled") combined. No auction-cycle-specific
 *     ID in this URL, unlike the earlier mode/1/{id} per-day links — this
 *     appears stable across cycles and is now the default (see main()).
 *     Per-day URLs (mode/1/{id}.html, e.g. .../mode/1/14.html for Thursday)
 *     still exist if you want just one day, but aren't needed for the
 *     common case of "show me everything up for bid right now."
 *   - Real table structure confirmed via visible header row, same on both
 *     all.html and the per-day mode/1 pages:
 *       Thumbnail | Auction Title/Condition Grade/High Bidder | Recent Price | Time Left | Bid
 *     5 columns. Column 2 packs title + condition grade + bidder status
 *     into one cell as multi-line text (not 3 separate cells) — parsed by
 *     splitting that cell's own text, not the whole page's.
 *   - No "Starting Price:"/"Recent Price:" labels in this table — just a
 *     bare "$1.00" in its own column. Whether that's a starting price or
 *     an actual bid can only be inferred from the adjacent status line
 *     ("No Bids Yet" vs "High Bidder: {name}").
 *   - Item codes match the pattern seen everywhere on the site: digit +
 *     letter + 4 digits (e.g. "2g0003", "2f0009").
 *   - The duplicate-title-line artifact (an apostrophe splitting an <img>
 *     alt from a separate link's full text) still shows up within column
 *     2's own text — handled the same way as before (keep the longer line
 *     if one is a prefix of the other).
 *
 * STILL OPEN:
 *   - Whether Time Left actually appears in the DOM at scrape time, or is
 *     rendered by client-side JS after a delay (a countdown widget) —
 *     using 'networkidle' wait to be safe, but unverified
 *   - Real pagination URL pattern — likely simpler now that this is a
 *     stable URL, but not yet confirmed (does page 2 add a segment, or is
 *     it a different querystring?) — currently follows the page's own
 *     "Next" link rather than guessing
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

const WARM_UP_SITES = ["https://www.google.com", "https://www.wikipedia.org"];
const MAX_LISTING_PAGES = 40; // safety cap — real scale is ~10-12 pages per auction day

interface CurrentAuctionRow {
  itemCode: string;
  titleRaw: string;
  conditionGrade: string;
  priceType: "starting" | "current"; // inferred from "No Bids Yet" vs "High Bidder:"
  price: number;
  highBidder: string | null;
  timeLeftRaw: string | null; // null if not present in the DOM at scrape time — see header note
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
      // Part of the title — extract the item code from the first such line
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

async function extractListingPage(page: Page, sourceUrl: string): Promise<CurrentAuctionRow[]> {
  const scrapedAt = new Date().toISOString();

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
      scrapedAt,
      sourceUrl,
    });
  }

  return results;
}

// Follows the page's own "Next" link rather than constructing page URLs —
// pagination pattern for this mode/1 path isn't confirmed yet.
async function scrapeListing(page: Page, startUrl: string): Promise<CurrentAuctionRow[]> {
  const allResults: CurrentAuctionRow[] = [];
  let currentUrl = startUrl;
  let missingTimeLeftCount = 0;

  for (let pageNum = 1; pageNum <= MAX_LISTING_PAGES; pageNum++) {
    // networkidle rather than domcontentloaded — Time Left may be a
    // client-rendered countdown widget that hasn't populated yet at
    // domcontentloaded. Unverified whether this is actually necessary.
    await page.goto(currentUrl, { waitUntil: "networkidle" });

    if (await isBlockPage(page)) {
      throw new Error(`BLOCK_PAGE_DETECTED while scraping current auctions (page ${pageNum})`);
    }

    const pageResults = await extractListingPage(page, currentUrl);
    console.log(`  page ${pageNum}: ${pageResults.length} item(s) parsed`);

    if (pageResults.length === 0) {
      console.log("  no items parsed — stopping");
      break;
    }

    missingTimeLeftCount += pageResults.filter((r) => r.timeLeftRaw === null).length;
    allResults.push(...pageResults);

    const nextLink = page.locator("a:has-text('Next')").first();
    const hasNext = (await nextLink.count()) > 0 && (await nextLink.isVisible().catch(() => false));
    if (!hasNext) {
      console.log("  no 'Next' link found — stopping pagination");
      break;
    }

    const nextHref = await nextLink.getAttribute("href").catch(() => null);
    if (!nextHref) {
      console.log("  'Next' link had no href — stopping pagination");
      break;
    }
    currentUrl = new URL(nextHref, currentUrl).toString();

    await sleepJittered(1200);
  }

  if (missingTimeLeftCount > 0) {
    console.log(
      `  WARNING: ${missingTimeLeftCount} item(s) had no Time Left value — ` +
        `either it's client-rendered and needs a longer wait, or the column index guess is off.`
    );
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
  // Confirmed via screenshot: "All Auctions" aggregates every current
  // auction (Tuesday + Thursday, e.g. 1,345 + 724 = 2,069 items) under one
  // URL with no auction-cycle-specific ID in it — appears stable across
  // cycles, unlike the earlier mode/1/{id} per-day links. Defaulting here
  // so a bare run picks up everything without needing a fresh URL each
  // time. Override LISTING_URL if you want just one specific day instead.
  const listingUrl = process.env.LISTING_URL || "https://www.emovieposter.com/agallery/all.html";

  const browser = await launchStealthBrowser();
  const context = await createSpoofedContext(browser); // no login needed
  const page = await context.newPage();

  try {
    await warmUp(page, WARM_UP_SITES);

    console.log(`Scraping current auctions starting from ${listingUrl}...`);
    const rows = await withRetries("scrape current auctions", () => scrapeListing(page, listingUrl));
    console.log(`Found ${rows.length} current auction item(s) total.`);

    if (rows.length > 0) {
      console.log("Sample row:", JSON.stringify(rows[0], null, 2));
    }

    await withRetries("upsert current auctions", () => upsertCurrentAuctions(rows));
  } finally {
    await context.close();
    await browser.close();
  }
}

main().catch((err) => {
  console.error("Current-auctions scrape failed:", err);
  process.exit(1);
});
