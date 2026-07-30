/**
 * eMoviePoster auction-history scraper (goal #2: historical realized sales
 * for comps — see emovieposter_current_auctions.ts for goal #1, upcoming
 * auctions to bid on).
 *
 * Shared infrastructure (stealth launch, context spoofing, pagination,
 * checkpointing, retries) lives in ./lib/scrape-core.ts — this file used to
 * carry local duplicate copies of all of it; deduped now that
 * emovieposter_current_auctions.ts needed the same pieces (pagination
 * especially). Login/session handling lives in ./lib/emovieposter-auth.ts,
 * shared with the current-auctions scraper.
 *
 * IMPORTANT: eMoviePoster's Terms of Use prohibit automated data collection.
 * This is a deliberate, accepted risk for a personal-use, low-stakes account —
 * see conversation context. Don't reuse this against Heritage or LiveAuctioneers;
 * their enforcement posture (esp. Heritage) is materially different.
 *
 * CONFIRMED (from real archive output + live inspection):
 *   - Per-title archive URL: /agallery/film_title/{encodedTitle}/archive.html
 *     — page 1 has NO /page/ segment; page N>1 adds /page/{n}/ right before
 *     archive.html (confirmed via a real page-3 URL for EMPIRE STRIKES BACK)
 *   - mode/2 is NOT required — confirmed working without it
 *   - Default sort is already Date Sold (Newest First) with no sort segment
 *     needed — confirmed across multiple titles' output
 *   - Default page size is ~75-80 rows (inferred from item-count/page-count
 *     ratios across 3 titles) — MAX_RESULTS_PER_TITLE=150 usually needs 2 pages
 *   - Encoding rule: encode normally once, then double-encode ONLY spaces
 *     (%20 -> %2520) — confirmed exactly against "EMPIRE%2520STRIKES%2520BACK"
 *   - Column order: Title | Film Year | Size | Country | Condition | Extra Info | Date Sold | Final Price
 *   - Row structure: 10 total <td> cells = 2 leading icon-only cells
 *     (camera/filter) + the 8 data cells above — counting from the END of
 *     the row (last 8) handles the leading icon cells regardless of count
 *   - Extra Info tags are real <a class="tag"> elements, concatenated with
 *     no separator when multiple (e.g. "#5" + "signed" back-to-back) —
 *     extracted via querySelectorAll('a.tag') scoped to that cell
 *   - Login form confirmed via screenshot — see emovieposter-auth.ts
 *   - /tag/{field}:{value}/ discovery endpoint confirmed, stacks arbitrarily
 *     (/tag/star:X/tag/art:Y/...), uses a THIRD distinct encoding rule from
 *     film_title and /search/ — see encodeTagValue() below
 *
 * STILL OPEN (needs your input):
 *   - Whether the label-anchored login locators actually work in practice —
 *     if fragile, get the raw <input> HTML for an exact-selector fallback
 */

import type { Page } from "playwright";
import {
  launchStealthBrowser,
  createSpoofedContext,
  warmUp,
  withRetries,
  loadCheckpoint,
  saveCheckpoint,
  runInBatches,
  sleepJittered,
  paginateUntilEmpty,
  stateDir,
  isWithinYearsBack,
} from "./lib/scrape-core";
import { ensureLoggedIn, ARCHIVE_BASE_URL, STORAGE_STATE_PATH } from "./lib/emovieposter-auth";
import path from "path";

// ── Config ──────────────────────────────────────────────────────────────
const CONCURRENCY = 2;              // parallel pages — keep low, this is a small personal account
const DELAY_BETWEEN_BATCHES_MS_BASE = 4000;
const DELAY_BETWEEN_TITLES_MS_BASE = 1500;
const YEARS_BACK = 2;               // only keep comps from the last N years
const MAX_RESULTS_PER_TITLE = 150;  // sorted newest-first, this covers ~2-4 years on real titles checked
const MAX_PAGES_PER_TITLE_SAFETY = 20; // hard safety cap on pagination — should never actually be hit
const WARM_UP_SITES = ["https://www.google.com", "https://www.wikipedia.org"];

const CHECKPOINT_PATH = path.join(stateDir("emovieposter"), "completed-titles.json");

// Builds the per-title archive URL. Confirmed pattern from real examples:
//   https://www.emovieposter.com/agallery/film_title/BLADE%2520RUNNER/mode/2/archive.html
//   https://www.emovieposter.com/agallery/mode/2/search/film%3A%2520godfather/page/2/archive.html
// The encoding rule is NOT "encode the whole string twice" — comparing
// "film: godfather" to "film%3A%2520godfather" shows the colon is
// single-encoded (%3A) while the space is double-encoded (%2520). So: encode
// normally once, then specifically double-encode only literal spaces.
// Titles are indexed in ALL CAPS (confirmed) — force uppercase here.
function encodeArchiveSegment(term: string): string {
  return encodeURIComponent(term).replace(/%20/g, "%2520");
}

function buildArchiveUrl(title: string, pageNum: number = 1): string {
  const encoded = encodeArchiveSegment(title.toUpperCase());
  const pageSegment = pageNum > 1 ? `/page/${pageNum}` : "";
  return `${ARCHIVE_BASE_URL}/agallery/film_title/${encoded}${pageSegment}/archive.html`;
}

interface ScrapedComp {
  title: string;
  filmYear?: number;
  size: string;
  country: string;
  condition: string;
  extraInfoRaw: string;
  extraInfoTags: string[];    // real anchor-tag text when available, else fallback text-split
  salePrice: number;
  saleDateRaw: string;        // e.g. "4/17/2022"
  sourceUrl: string;
}

interface RawCell {
  text: string;
  anchorTexts: string[]; // real per-tag links, when present (e.g. Extra Info's separate tags)
}

async function extractRawRows(page: Page): Promise<RawCell[][]> {
  return page.$$eval("table tr", (rows) =>
    rows.map((row) =>
      Array.from(row.querySelectorAll("td")).map((td) => ({
        text: (td.textContent ?? "").trim(),
        // Confirmed via inspection: Extra Info tags are <a class="tag">
        // elements, concatenated with no separator when there are several
        // (e.g. "#5" + "signed" back-to-back). Scoping to a.tag specifically
        // avoids picking up Size/Country/Condition's own anchor links.
        anchorTexts: Array.from(td.querySelectorAll("a.tag"))
          .map((a) => (a.textContent ?? "").trim())
          .filter(Boolean),
      }))
    )
  );
}

// Normalizes a row's cells to the canonical 8-field shape regardless of
// leading icon-only columns (camera/filter icons, confirmed via screenshot)
// or whether Size/Country/Condition are 3 separate cells or 1 combined —
// works from the END of the row, since Final Price and Date Sold are
// always the last 2 columns and Extra Info is always 3rd-from-last,
// regardless of how many icon columns lead the row.
function normalizeRow(rawCells: RawCell[]): { cells: string[]; extraInfoAnchors: string[] } | null {
  const texts = rawCells.map((c) => c.text);
  const extraInfoAnchors = rawCells.length >= 3 ? rawCells[rawCells.length - 3].anchorTexts : [];

  if (texts.length >= 8) {
    return { cells: texts.slice(-8), extraInfoAnchors };
  }

  if (texts.length === 6) {
    const [title, filmYear, combined, extraInfo, saleDate, price] = texts;
    const lines = combined.split("\n").map((s) => s.trim()).filter(Boolean);
    if (lines.length !== 3) return null;
    const [size, country, condition] = lines;
    return { cells: [title, filmYear, size, country, condition, extraInfo, saleDate, price], extraInfoAnchors };
  }

  return null; // unrecognized shape — skip this row rather than misparse it
}


// Fallback text-splitter — only used if a row's Extra Info cell has no
// anchor tags (shouldn't normally happen based on what we've seen, but
// don't let that assumption silently produce zero data for an edge case).
const KNOWN_TAG_PATTERNS: RegExp[] = [
  /^unfolded$/i, /^fully folded$/i, /^tri-folded$/i, /^linen$/i, /^pbacked$/i,
  /^rolled$/i, /^never folded$/i, /^R\d{2}$/, /^qty:\d+$/i, /^#\d+\/\d+$/,
  /^signed$/i, /^studio style$/i, /^NSS style$/i, /^style [A-Z]$/i, /^int'l$/i,
  /^advance$/i, /^teaser$/i, /^DS$/, /^First Edition$/i, /^Variant Edition$/i,
  /^Timed Edition$/i,
];

function parseExtraInfoFallback(raw: string): string[] {
  if (!raw) return [];
  const tags: string[] = [];
  let remaining = raw.trim();

  outer: while (remaining.length > 0) {
    for (const pattern of KNOWN_TAG_PATTERNS) {
      const match = remaining.match(new RegExp(`^(${pattern.source})`, pattern.flags));
      if (match) {
        tags.push(match[1]);
        remaining = remaining.slice(match[1].length).trim();
        continue outer;
      }
    }
    const boundaryMatch = remaining.match(/^[A-Z][a-z0-9']*(?=[A-Z]|$)/);
    if (boundaryMatch && boundaryMatch[0].length > 0) {
      tags.push(boundaryMatch[0]);
      remaining = remaining.slice(boundaryMatch[0].length).trim();
    } else {
      tags.push(remaining);
      break;
    }
  }

  return tags;
}

// Parses one row's cells (already normalized to the 8-field shape) into a
// ScrapedComp. Confirmed column order:
//   Title | Film Year | Size | Country | Condition | Extra Info | Date Sold | Final Price
function parseRow(cells: string[], extraInfoAnchors: string[], sourceUrl: string): ScrapedComp | null {
  if (cells.length < 8) return null;

  const [title, filmYearRaw, size, country, condition, extraInfoRaw, saleDateRaw, priceRaw] = cells;

  const priceNum = parseFloat(priceRaw.replace(/[^0-9.]/g, ""));
  if (!title || Number.isNaN(priceNum)) return null;

  const filmYear = parseInt(filmYearRaw, 10);

  return {
    title: title.trim(),
    filmYear: Number.isNaN(filmYear) ? undefined : filmYear,
    size: size.trim(),
    country: country.trim(),
    condition: condition.trim(),
    extraInfoRaw: extraInfoRaw.trim(),
    extraInfoTags: extraInfoAnchors.length > 0 ? extraInfoAnchors : parseExtraInfoFallback(extraInfoRaw.trim()),
    salePrice: priceNum,
    saleDateRaw: saleDateRaw.trim(),
    sourceUrl,
  };
}

// ── Scraping a single title's auction history ───────────────────────────
// Pagination mechanics (navigation, block/session checks, empty-page
// stopping, jittered delays) now live in the shared paginateUntilEmpty()
// helper — this just extracts+parses+filters whatever's on one page.
async function scrapeTitleHistory(page: Page, title: string): Promise<ScrapedComp[]> {
  let skippedOldCount = 0;
  let skippedUnparsedCount = 0;

  const extractPage = async (page: Page): Promise<ScrapedComp[]> => {
    const url = page.url();
    const rawRows = await extractRawRows(page);
    const pageResults: ScrapedComp[] = [];

    for (const rawCells of rawRows) {
      const normalized = normalizeRow(rawCells);
      if (!normalized) {
        if (rawCells.length > 0) skippedUnparsedCount++;
        continue;
      }
      const comp = parseRow(normalized.cells, normalized.extraInfoAnchors, url);
      if (!comp) continue;

      if (!isWithinYearsBack(comp.saleDateRaw, YEARS_BACK)) {
        skippedOldCount++;
        continue;
      }
      pageResults.push(comp);
    }

    return pageResults;
  };

  const results = await paginateUntilEmpty(page, {
    buildUrl: (pageNum) => buildArchiveUrl(title, pageNum),
    maxPages: MAX_PAGES_PER_TITLE_SAFETY,
    delayBetweenPagesMs: 1000,
    extractPage,
    label: `"${title}"`,
    stopWhen: (acc) => acc.length >= MAX_RESULTS_PER_TITLE,
  });

  if (skippedOldCount > 0) {
    console.log(`  skipped ${skippedOldCount} lot(s) older than ${YEARS_BACK} years`);
  }
  if (skippedUnparsedCount > 0) {
    console.log(`  WARNING: skipped ${skippedUnparsedCount} row(s) with unrecognized cell structure — check normalizeRow()`);
  }

  return results.slice(0, MAX_RESULTS_PER_TITLE);
}

// ── /tag/ endpoint encoding (discovery mode) ──────────────────────────────
// Confirmed via real hrefs that /tag/ uses a DIFFERENT rule than film_title:
// plain double-encoding, but with a stricter first-pass encoder than JS's
// encodeURIComponent — comparing "int'l style" to "int%2527l%2520style"
// shows the apostrophe itself gets encoded (%27) before the double-pass,
// which encodeURIComponent does NOT do on its own. So: escape those
// characters manually, then apply encodeURIComponent twice.
function strictEncodeURIComponent(str: string): string {
  return encodeURIComponent(str).replace(
    /['()*!~]/g,
    (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function encodeTagValue(value: string): string {
  return strictEncodeURIComponent(strictEncodeURIComponent(value));
}

// Builds a /tag/ discovery URL. Supports stacking multiple field:value tags
// (confirmed: /tag/star:X/tag/art:Y/archive.html chains arbitrarily).
function buildTagUrl(tags: string[], pageNum: number = 1): string {
  const tagSegments = tags.map((t) => `tag/${encodeTagValue(t)}`).join("/");
  const pageSegment = pageNum > 1 ? `/page/${pageNum}` : "";
  return `${ARCHIVE_BASE_URL}/agallery/${tagSegments}${pageSegment}/archive.html`;
}

const MAX_DISCOVERY_PAGES = 8; // cap — discovery is for finding titles, not exhaustive collection
const DISCOVERY_STALL_PAGES = 2; // stop early if this many consecutive pages add no new titles

// Walks a /tag/ query (e.g. ["star:Harrison Ford"]) and extracts distinct
// Titles seen, for feeding into the precise film_title scraper afterward.
// Also returns raw rows so that context can be stored, tagged distinctly
// from real film_title comps rather than mixed in with them.
async function discoverFromTag(
  page: Page,
  tags: string[]
): Promise<{ titles: string[]; rawComps: ScrapedComp[] }> {
  const seenTitles = new Set<string>();

  const rawComps = await paginateUntilEmpty(page, {
    buildUrl: (pageNum) => buildTagUrl(tags, pageNum),
    maxPages: MAX_DISCOVERY_PAGES,
    delayBetweenPagesMs: 1000,
    label: `discovery [${tags.join(", ")}]`,
    extractPage: async (page) => {
      const url = page.url();
      const rawRows = await extractRawRows(page);
      const pageComps: ScrapedComp[] = [];
      for (const rawCells of rawRows) {
        const normalized = normalizeRow(rawCells);
        if (!normalized) continue;
        const comp = parseRow(normalized.cells, normalized.extraInfoAnchors, url);
        if (!comp) continue;
        seenTitles.add(comp.title);
        pageComps.push(comp);
      }
      return pageComps;
    },
    // Stop early once several consecutive pages add nothing new — the
    // stopWhen check only sees the accumulated array, so approximate
    // "stalled" via a closure-tracked title-count high-water-mark.
    stopWhen: (() => {
      let lastSeenCount = 0;
      let stalledPages = 0;
      return () => {
        if (seenTitles.size === lastSeenCount) {
          stalledPages++;
        } else {
          stalledPages = 0;
          lastSeenCount = seenTitles.size;
        }
        return stalledPages >= DISCOVERY_STALL_PAGES;
      };
    })(),
  });

  return { titles: [...seenTitles], rawComps };
}

// ── Batch upsert into YouBase (via EdgeSpark HTTP API, since this runs
//    outside the EdgeSpark worker runtime — adjust to however you expose
//    a write endpoint, e.g. an authenticated /api/poster-auctions/bulk route).
//    Sends the full parsed row so the backend can do its own matching
//    against `inventory` rather than us collapsing fields here. ──
async function upsertComps(comps: ScrapedComp[], sourceOverride: string = "emovieposter"): Promise<void> {
  if (comps.length === 0) return;

  const endpoint = process.env.FRAMEANDREEL_INGEST_URL;
  const apiKey = process.env.FRAMEANDREEL_INGEST_KEY;
  if (!endpoint || !apiKey) {
    throw new Error("Missing FRAMEANDREEL_INGEST_URL / FRAMEANDREEL_INGEST_KEY env vars");
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ source: sourceOverride, captureMethod: "automated_scrape", comps }),
  });

  if (!res.ok) {
    throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  }
}

// ── Watchlist (Supabase) ───────────────────────────────────────────────
// bid_watchlist is how this scraper gets "directed" instead of running
// wide open against the ~2M-result archive — add a title there (via
// Supabase's Table Editor for now, a YouWare UI later) and it's picked up
// automatically. TITLES env var still works as an ad-hoc override for
// one-off lookups that skip the watchlist entirely.
const SUPABASE_URL = process.env.SUPABASE_URL; // e.g. https://vojshqdxkdvzowdsucjk.supabase.co
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

async function fetchWatchlistTitles(): Promise<string[]> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    throw new Error("Missing SUPABASE_URL / SUPABASE_ANON_KEY env vars — needed to read the watchlist");
  }
  const url = `${SUPABASE_URL}/rest/v1/bid_watchlist?status=eq.active&select=title`;
  const res = await fetch(url, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
  });
  if (!res.ok) {
    throw new Error(`Watchlist fetch failed: ${res.status} ${await res.text()}`);
  }
  const rows = (await res.json()) as Array<{ title: string }>;
  return rows.map((r) => r.title);
}

// Best-effort — a failure here shouldn't fail the whole scrape run, it's
// just a "last scraped" signal for your own visibility in Supabase.
async function markWatchlistScraped(title: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return;
  const url = `${SUPABASE_URL}/rest/v1/bid_watchlist?title=eq.${encodeURIComponent(title)}`;
  await fetch(url, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ last_scraped_at: new Date().toISOString() }),
  }).catch(() => {});
}

// ── Entry point ──────────────────────────────────────────────────────────
async function main() {
  const isDiscoveryMode = process.argv.includes("--discover");
  const discoveryOnly = process.env.DISCOVERY_ONLY === "true";

  const titlesArg = process.env.TITLES;
  let titles = titlesArg ? titlesArg.split(",").map((t) => t.trim()).filter(Boolean) : [];

  // If no explicit TITLES override and not in discovery mode, default to
  // the watchlist — this is the "run it and it works" case for ongoing use.
  const usingWatchlist = titles.length === 0 && !isDiscoveryMode;
  if (usingWatchlist) {
    console.log("No TITLES override given — pulling from the watchlist (bid_watchlist, status=active)...");
    titles = await fetchWatchlistTitles();
    console.log(`Watchlist has ${titles.length} active title(s): ${titles.join(", ")}`);
  }

  const browser = await launchStealthBrowser();
  // Load the shared session file if one exists, so we're not logging in
  // fresh every run — this was previously broken (context was created
  // without ever loading the saved storageState back in).
  const context = await createSpoofedContext(browser, { storageStatePath: STORAGE_STATE_PATH });
  const page = await context.newPage();

  let stoppedEarly = false;

  try {
    await warmUp(page, WARM_UP_SITES);
    await ensureLoggedIn(context, page);

    if (isDiscoveryMode) {
      const tagsArg = process.env.DISCOVERY_TAGS;
      const tags = tagsArg ? tagsArg.split(",").map((t) => t.trim()).filter(Boolean) : [];
      if (tags.length === 0) {
        console.log("No discovery tags provided (set DISCOVERY_TAGS, e.g. 'star:Harrison Ford'). Exiting.");
        return;
      }

      console.log(`Discovering via tag(s): ${tags.join(", ")}`);
      const { titles: discoveredTitles, rawComps } = await withRetries(
        `discover [${tags.join(", ")}]`,
        () => discoverFromTag(page, tags)
      );
      console.log(`Discovery found ${discoveredTitles.length} distinct title(s), ${rawComps.length} raw row(s).`);

      await withRetries("upsert discovery context", () =>
        upsertComps(rawComps, "emovieposter_tag_discovery")
      );

      const merged = new Map<string, string>();
      for (const t of [...titles, ...discoveredTitles]) merged.set(t.toUpperCase(), t);
      titles = [...merged.values()];

      if (discoveryOnly) {
        console.log("DISCOVERY_ONLY=true — skipping per-title scrape phase.");
        return;
      }
    }

    if (titles.length === 0) {
      console.log(
        usingWatchlist
          ? "Watchlist is empty (bid_watchlist has no active rows). Add titles there, or set TITLES for an ad-hoc run."
          : "No titles to scrape (set TITLES, and/or use --discover with DISCOVERY_TAGS). Exiting."
      );
      return;
    }

    const completed = await loadCheckpoint(CHECKPOINT_PATH);
    const remaining = titles.filter((t) => !completed.has(t));
    if (remaining.length < titles.length) {
      console.log(`Skipping ${titles.length - remaining.length} already-completed title(s) from checkpoint.`);
    }
    if (remaining.length === 0) {
      console.log("Nothing left to scrape — all titles already checkpointed.");
      return;
    }

    await runInBatches(remaining, CONCURRENCY, DELAY_BETWEEN_BATCHES_MS_BASE, async (title) => {
      if (stoppedEarly) return; // a sibling in a prior batch already tripped the block detector

      console.log(`Scraping: ${title}`);
      // Each concurrent worker gets its own Page — pages in the same
      // BrowserContext share cookies/session automatically, so no
      // re-login needed, but they can't share one Page object across
      // concurrent navigations (that was a real bug: two titles racing
      // page.goto() on the same tab). Fixed now that nothing's live yet.
      const workerPage = await context.newPage();
      try {
        const comps = await withRetries(`scrape "${title}"`, () => scrapeTitleHistory(workerPage, title));
        console.log(`  found ${comps.length} closed lots (last ${YEARS_BACK}y)`);
        await withRetries(`upsert "${title}"`, () => upsertComps(comps));
        completed.add(title);
        await saveCheckpoint(CHECKPOINT_PATH, completed);
        if (usingWatchlist) await markWatchlistScraped(title);
      } catch (err) {
        if (String(err).includes("BLOCK_PAGE_DETECTED")) {
          console.error(`Block/CAPTCHA page detected on "${title}" — stopping run cleanly.`);
          console.error("Progress so far is checkpointed; re-run later to pick up where this left off.");
          stoppedEarly = true;
          return;
        }
        throw err;
      } finally {
        await workerPage.close();
      }

      await sleepJittered(DELAY_BETWEEN_TITLES_MS_BASE);
    });
  } finally {
    await context.close();
    await browser.close();
  }

  if (stoppedEarly) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
