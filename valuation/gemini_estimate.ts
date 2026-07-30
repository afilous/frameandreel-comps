/**
 * AI ballpark valuation estimate — queries Gemini for a rough eBay/gallery
 * price range given poster parameters (title, year, format, country,
 * condition, style). This is NOT a substitute for real comps: it's a
 * knowledge-cutoff-bound recollection of general price patterns, useful as
 * a quick sanity check or fallback when poster_auctions/poster_listings are
 * thin, not as evidence in its own right.
 *
 * Reuses the same Gemini API credentials already in backend/server/src/index.ts
 * (the two-stage identification pipeline). No new API keys needed.
 */

export interface PosterQueryParams {
  title: string;
  filmYear?: number;
  size?: string;         // e.g. "1sh", "French Grande", "Japanese B2"
  country?: string;      // e.g. "U.S.", "French", "Italian"
  condition?: string;    // e.g. "very good to fine"
  style?: string;        // e.g. "advance", "teaser", "style B"
}

export interface AiPriceEstimate {
  ebayLow: number | null;
  ebayHigh: number | null;
  galleryLow: number | null;
  galleryHigh: number | null;
  modelUsed: string;
  modelNotes: string;
  confidenceTier: "low_ai_estimate";
  sourceLabel: string; // always present on the object itself, not just the DB row —
                        // so any UI/log/print that touches this data carries the caveat
                        // even if someone forgets to check confidenceTier separately
  queriedAt: string;
}

const SOURCE_LABEL = "Gemini assumption — not verified sale data";

const GEMINI_MODEL = "gemini-2.5-flash";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    ebay_low: { type: "number", nullable: true },
    ebay_high: { type: "number", nullable: true },
    gallery_low: { type: "number", nullable: true },
    gallery_high: { type: "number", nullable: true },
    notes: { type: "string" }, // model's own caveats — surfaced, not hidden
  },
  required: ["notes"],
};

function buildPrompt(params: PosterQueryParams): string {
  const parts = [
    `Title: ${params.title}`,
    params.filmYear ? `Release year: ${params.filmYear}` : null,
    params.size ? `Format/size: ${params.size}` : null,
    params.country ? `Country/region: ${params.country}` : null,
    params.condition ? `Condition: ${params.condition}` : null,
    params.style ? `Style: ${params.style}` : null,
  ].filter(Boolean);

  return `You are estimating resale value ranges for an original vintage movie poster based on general market knowledge, NOT live data.

Poster details:
${parts.join("\n")}

Give your best ballpark estimate for:
1. Typical eBay SOLD (realized) price range for this exact item in this condition
2. Typical price range at premium poster galleries/retailers (e.g. Posterati, Film Art Gallery) for this exact item in this condition

Be explicit in "notes" about:
- Your confidence level and why (common vs. obscure title, well-documented format, etc.)
- Anything that could make your estimate stale or unreliable (recent reissues, sudden demand shifts, condition-grading ambiguity)
- If you don't have reliable knowledge of this specific title/format combination, say so plainly and leave price fields null rather than guessing.

Return ONLY the JSON object, no other text.`;
}

export async function getAiPriceEstimate(params: PosterQueryParams): Promise<AiPriceEstimate> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing GEMINI_API_KEY env var");
  }

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: buildPrompt(params) }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Gemini estimate request failed: ${res.status} ${await res.text()}`);
  }

  const data = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };

  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!rawText) {
    throw new Error("Gemini response had no content to parse");
  }

  const parsed = JSON.parse(rawText) as {
    ebay_low?: number | null;
    ebay_high?: number | null;
    gallery_low?: number | null;
    gallery_high?: number | null;
    notes: string;
  };

  return {
    ebayLow: parsed.ebay_low ?? null,
    ebayHigh: parsed.ebay_high ?? null,
    galleryLow: parsed.gallery_low ?? null,
    galleryHigh: parsed.gallery_high ?? null,
    modelUsed: GEMINI_MODEL,
    modelNotes: parsed.notes,
    confidenceTier: "low_ai_estimate",
    sourceLabel: SOURCE_LABEL,
    queriedAt: new Date().toISOString(),
  };
}

// ── Persist to ai_price_estimates (via the same EdgeSpark ingest pattern
//    as the scrapers) ──
export async function saveAiPriceEstimate(
  params: PosterQueryParams,
  estimate: AiPriceEstimate
): Promise<void> {
  const endpoint = process.env.FRAMEANDREEL_INGEST_URL_AI_ESTIMATES; // e.g. .../api/ai-price-estimates
  const apiKey = process.env.FRAMEANDREEL_INGEST_KEY;
  if (!endpoint || !apiKey) {
    console.log("No AI-estimate ingest endpoint configured — printing instead:");
    console.log(JSON.stringify({ params, estimate }, null, 2));
    return;
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ params, estimate }),
  });

  if (!res.ok) {
    throw new Error(`Ingest failed: ${res.status} ${await res.text()}`);
  }
}

// Reusable formatter — anywhere this estimate gets displayed (CLI, a future
// dashboard, a Slack message, whatever) should go through this so the
// "Gemini assumption" caveat travels with the numbers instead of getting
// silently dropped when someone just picks off .ebayLow/.ebayHigh directly.
export function formatEstimateSummary(estimate: AiPriceEstimate): string {
  const ebayRange =
    estimate.ebayLow != null && estimate.ebayHigh != null
      ? `$${estimate.ebayLow} – $${estimate.ebayHigh}`
      : "no estimate given";
  const galleryRange =
    estimate.galleryLow != null && estimate.galleryHigh != null
      ? `$${estimate.galleryLow} – $${estimate.galleryHigh}`
      : "no estimate given";

  return [
    `Source: ${estimate.sourceLabel} (${estimate.modelUsed}, queried ${estimate.queriedAt})`,
    `eBay price range (Gemini assumption):    ${ebayRange}`,
    `Gallery price range (Gemini assumption): ${galleryRange}`,
    `Model notes: ${estimate.modelNotes}`,
  ].join("\n");
}

// ── CLI entry point for one-off lookups ──
async function main() {
  const title = process.env.TITLE;
  if (!title) {
    console.log("Set TITLE (and optionally YEAR, SIZE, COUNTRY, CONDITION, STYLE) env vars.");
    return;
  }

  const params: PosterQueryParams = {
    title,
    filmYear: process.env.YEAR ? parseInt(process.env.YEAR, 10) : undefined,
    size: process.env.SIZE,
    country: process.env.COUNTRY,
    condition: process.env.CONDITION,
    style: process.env.STYLE,
  };

  console.log(`Querying Gemini for: ${JSON.stringify(params)}`);
  const estimate = await getAiPriceEstimate(params);
  console.log("\n=== AI Ballpark Estimate ===");
  console.log(formatEstimateSummary(estimate));

  await saveAiPriceEstimate(params, estimate);
}

if (require.main === module) {
  main().catch((err) => {
    console.error("AI estimate failed:", err);
    process.exit(1);
  });
}
