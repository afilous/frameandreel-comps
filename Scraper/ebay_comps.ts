/**
 * eBay comps — active listing prices + sold prices, via eBay's official APIs.
 *
 * This deliberately does NOT scrape ebay.com. Frame & Reel already has an
 * eBay Developer account + API credentials (used for the storefront's own
 * listings). We reuse those same credentials here for market research reads,
 * which keeps this piece fully within eBay's terms — no stealth browser,
 * no fingerprinting, no block risk at all.
 *
 * Two data sources:
 *   1. Browse API — current ACTIVE listing prices (asking prices, not sold).
 *      Available to any registered eBay developer app, works today.
 *   2. Marketplace Insights API — actual SOLD item prices (last ~90 days
 *      of transaction history). This is what you actually want for "what
 *      does this typically sell for," but it requires eBay to grant your
 *      app a separate approved scope (not automatic) — see:
 *      https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html
 *      TODO: confirm whether your existing eBay app already has this scope,
 *      or apply for it. Until then, sold-price history falls back to a
 *      manual note ("apply for Marketplace Insights access") rather than
 *      guessing from active-listing data.
 */

interface EbayComp {
  title: string;
  price: number;
  currency: string;
  condition?: string;
  listingType: "active" | "sold";
  itemUrl: string;
  soldDate?: string; // only present for sold items, from Marketplace Insights
}

// ── Auth — reuses the same client-credentials flow as the storefront's
//    existing eBay Inventory API integration ───────────────────────────
async function getEbayAccessToken(): Promise<string> {
  const clientId = process.env.EBAY_APP_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Missing EBAY_APP_ID / EBAY_CLIENT_SECRET env vars");
  }

  const credentials = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const res = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${credentials}`,
    },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      // Browse API scope; add the Marketplace Insights scope here too once granted:
      // "https://api.ebay.com/oauth/api_scope/buy.marketplace.insights"
      scope: "https://api.ebay.com/oauth/api_scope",
    }),
  });

  if (!res.ok) {
    throw new Error(`eBay token request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ── Active listings (asking prices) via Browse API ──────────────────────
async function fetchActiveListings(token: string, title: string, limit = 25): Promise<EbayComp[]> {
  const url = new URL("https://api.ebay.com/buy/browse/v1/item_summary/search");
  url.searchParams.set("q", title);
  url.searchParams.set("category_ids", "550"); // Movie posters category — TODO verify ID
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (!res.ok) {
    throw new Error(`Browse API failed for "${title}": ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    itemSummaries?: Array<{
      title: string;
      price?: { value: string; currency: string };
      condition?: string;
      itemWebUrl: string;
    }>;
  };

  return (data.itemSummaries ?? []).map((item) => ({
    title: item.title,
    price: parseFloat(item.price?.value ?? "0"),
    currency: item.price?.currency ?? "USD",
    condition: item.condition,
    listingType: "active" as const,
    itemUrl: item.itemWebUrl,
  }));
}

// ── Sold items via Marketplace Insights API (requires approved scope) ───
async function fetchSoldItems(token: string, title: string, limit = 25): Promise<EbayComp[]> {
  const url = new URL("https://api.ebay.com/buy/marketplace_insights/v1_beta/item_sales/search");
  url.searchParams.set("q", title);
  url.searchParams.set("limit", String(limit));

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-EBAY-C-MARKETPLACE-ID": "EBAY_US",
    },
  });

  if (res.status === 403) {
    console.warn(
      "  Marketplace Insights API returned 403 — your app likely doesn't have this scope yet. " +
        "Apply at https://developer.ebay.com/api-docs/buy/marketplace-insights/overview.html. " +
        "Skipping sold-item data for now."
    );
    return [];
  }

  if (!res.ok) {
    throw new Error(`Marketplace Insights failed for "${title}": ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    itemSales?: Array<{
      title: string;
      lastSoldPrice?: { value: string; currency: string };
      condition?: string;
      itemWebUrl: string;
      lastSoldDate?: string;
    }>;
  };

  return (data.itemSales ?? []).map((item) => ({
    title: item.title,
    price: parseFloat(item.lastSoldPrice?.value ?? "0"),
    currency: item.lastSoldPrice?.currency ?? "USD",
    condition: item.condition,
    listingType: "sold" as const,
    itemUrl: item.itemWebUrl,
    soldDate: item.lastSoldDate,
  }));
}

// ── Entry point ──────────────────────────────────────────────────────────
async function main() {
  const titlesArg = process.env.TITLES;
  const titles = titlesArg ? titlesArg.split(",").map((t) => t.trim()) : [];
  if (titles.length === 0) {
    console.log("No titles provided (set TITLES env var). Exiting.");
    return;
  }

  const token = await getEbayAccessToken();
  const allComps: EbayComp[] = [];

  for (const title of titles) {
    console.log(`Fetching eBay comps: ${title}`);
    const [active, sold] = await Promise.all([
      fetchActiveListings(token, title),
      fetchSoldItems(token, title),
    ]);
    console.log(`  ${active.length} active listings, ${sold.length} sold items`);
    allComps.push(...active, ...sold);
  }

  // Push into the same backend ingest endpoint as the eMoviePoster scraper,
  // tagged with source='ebay' so poster_auctions / poster_listings can
  // distinguish it. Sold items -> poster_auctions, active -> poster_listings.
  const endpoint = process.env.FRAMEANDREEL_INGEST_URL;
  const apiKey = process.env.FRAMEANDREEL_INGEST_KEY;
  if (!endpoint || !apiKey) {
    console.log("No ingest endpoint configured — printing results instead:");
    console.log(JSON.stringify(allComps, null, 2));
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ source: "ebay", captureMethod: "api", comps: allComps }),
  });

  if (!res.ok) {
    throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  }

  console.log(`Ingested ${allComps.length} eBay comps.`);
}

main().catch((err) => {
  console.error("eBay comps fetch failed:", err);
  process.exit(1);
});
