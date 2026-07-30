/**
 * Retail listing-price scraper — for sites like Posterarti and Film Art
 * Gallery where you just want "what are these currently listed for,"
 * not a login-gated auction archive. Public product pages, no account
 * needed, which is a meaningfully lower-friction target than eMoviePoster.
 *
 * Add new sites by adding an entry to SITE_CONFIGS below — everything else
 * (browser, jitter, retries, checkpointing, block detection) is shared via
 * lib/scrape-core.ts.
 *
 * TODO: fill in real selectors per site once you inspect the live DOM —
 * placeholders below are guesses at typical e-commerce markup, not verified.
 */

import {
  launchStealthBrowser,
  createSpoofedContext,
  warmUp,
  isBlockPage,
  withRetries,
  loadCheckpoint,
  saveCheckpoint,
  runInBatches,
  sleepJittered,
  stateDir,
  ingestToBackend,
} from "./lib/scrape-core";
import path from "path";

interface SiteConfig {
  name: string;
  searchUrl: (title: string) => string;
  selectors: {
    resultRow: string;
    title: string;
    price: string;
    format?: string;
    itemLink?: string;
  };
}

const SITE_CONFIGS: SiteConfig[] = [
  {
    name: "posterarti",
    searchUrl: (title) => `https://www.posterarti.com/search?q=${encodeURIComponent(title)}`,
    selectors: {
      resultRow: ".TODO_posterarti_product_card",
      title: ".TODO_posterarti_title",
      price: ".TODO_posterarti_price",
      format: ".TODO_posterarti_format",
      itemLink: "a.TODO_posterarti_link",
    },
  },
  {
    name: "filmartgallery",
    searchUrl: (title) => `https://www.filmartgallery.com/search?q=${encodeURIComponent(title)}`,
    selectors: {
      resultRow: ".TODO_fag_product_card",
      title: ".TODO_fag_title",
      price: ".TODO_fag_price",
      format: ".TODO_fag_format",
      itemLink: "a.TODO_fag_link",
    },
  },
];

const CONCURRENCY = 2;
const DELAY_BETWEEN_BATCHES_MS = 3500;
const DELAY_BETWEEN_TITLES_MS = 1200;
const WARM_UP_SITES = ["https://www.google.com", "https://www.wikipedia.org"];

interface ScrapedListing {
  site: string;
  title: string;
  askingPrice: number;
  format?: string;
  sourceUrl: string;
}

async function scrapeSiteForTitle(
  page: import("playwright").Page,
  site: SiteConfig,
  title: string
): Promise<ScrapedListing[]> {
  const searchUrl = site.searchUrl(title);
  await page.goto(searchUrl, { waitUntil: "domcontentloaded" });

  if (await isBlockPage(page)) {
    throw new Error(`BLOCK_PAGE_DETECTED on ${site.name} for "${title}"`);
  }

  const rows = await page.$$(site.selectors.resultRow);
  const results: ScrapedListing[] = [];

  for (const row of rows) {
    const [rTitle, rPrice, rFormat, rLink] = await Promise.all([
      row.$eval(site.selectors.title, (el) => el.textContent?.trim() ?? "").catch(() => ""),
      row.$eval(site.selectors.price, (el) => el.textContent?.trim() ?? "").catch(() => ""),
      site.selectors.format
        ? row.$eval(site.selectors.format!, (el) => el.textContent?.trim() ?? "").catch(() => "")
        : Promise.resolve(""),
      site.selectors.itemLink
        ? row.$eval(site.selectors.itemLink!, (el) => (el as HTMLAnchorElement).href).catch(() => "")
        : Promise.resolve(""),
    ]);

    const priceNum = parseFloat(rPrice.replace(/[^0-9.]/g, ""));
    if (!rTitle || Number.isNaN(priceNum)) continue;

    results.push({
      site: site.name,
      title: rTitle,
      askingPrice: priceNum,
      format: rFormat || undefined,
      sourceUrl: rLink || searchUrl,
    });
  }

  return results;
}

async function main() {
  const titlesArg = process.env.TITLES;
  const titles = titlesArg ? titlesArg.split(",").map((t) => t.trim()) : [];
  if (titles.length === 0) {
    console.log("No titles provided (set TITLES env var). Exiting.");
    return;
  }

  const dir = stateDir("retail-listings");
  const checkpointPath = path.join(dir, "completed.json");
  const completed = await loadCheckpoint(checkpointPath);

  // Checkpoint key is "site::title" so progress tracks per-site, not just per-title
  const workItems: Array<{ site: SiteConfig; title: string }> = [];
  for (const site of SITE_CONFIGS) {
    for (const title of titles) {
      const key = `${site.name}::${title}`;
      if (!completed.has(key)) workItems.push({ site, title });
    }
  }

  if (workItems.length === 0) {
    console.log("Nothing left to scrape — all site/title pairs already checkpointed.");
    return;
  }

  const browser = await launchStealthBrowser();
  const context = await createSpoofedContext(browser);
  const page = await context.newPage();

  const allListings: ScrapedListing[] = [];
  let stoppedEarly = false;

  try {
    await warmUp(page, WARM_UP_SITES);

    await runInBatches(workItems, CONCURRENCY, DELAY_BETWEEN_BATCHES_MS, async ({ site, title }) => {
      if (stoppedEarly) return;

      const key = `${site.name}::${title}`;
      console.log(`Scraping ${site.name}: ${title}`);
      try {
        const listings = await withRetries(`${site.name}/${title}`, () =>
          scrapeSiteForTitle(page, site, title)
        );
        console.log(`  found ${listings.length} listing(s)`);
        allListings.push(...listings);
        completed.add(key);
        await saveCheckpoint(checkpointPath, completed);
      } catch (err) {
        if (String(err).includes("BLOCK_PAGE_DETECTED")) {
          console.error(`Block page detected on ${site.name} for "${title}" — stopping cleanly.`);
          stoppedEarly = true;
          return;
        }
        throw err;
      }

      await sleepJittered(DELAY_BETWEEN_TITLES_MS);
    });
  } finally {
    await context.close();
    await browser.close();
  }

  if (allListings.length > 0) {
    await ingestToBackend("FRAMEANDREEL_INGEST_URL", "FRAMEANDREEL_INGEST_KEY", {
      source: "retail_listings",
      captureMethod: "automated_scrape",
      listings: allListings,
    });
    console.log(`Ingested ${allListings.length} retail listings.`);
  }

  if (stoppedEarly) process.exitCode = 1;
}

main().catch((err) => {
  console.error("Retail listings scraper failed:", err);
  process.exit(1);
});
