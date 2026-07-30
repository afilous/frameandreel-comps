-- Migration: ai_price_estimates
-- Gemini-based ballpark valuation estimates. Deliberately kept in a SEPARATE
-- table from poster_auctions (realized sales) and poster_listings (asking
-- prices) — this is a model's recollection of general price patterns, not
-- an observed data point, and averaging it in with real comps would quietly
-- launder a guess into what looks like evidence.

CREATE TABLE IF NOT EXISTS ai_price_estimates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  title TEXT NOT NULL,
  film_year INTEGER,
  size TEXT,
  country TEXT,
  condition_raw TEXT,
  style TEXT,

  -- Estimated ranges per tier — nullable individually, since the model may
  -- only be confident about one tier for a given item
  ebay_low REAL,
  ebay_high REAL,
  gallery_low REAL,
  gallery_high REAL,

  -- Provenance / staleness tracking — critical given this is knowledge-cutoff
  -- bound and not live data
  model_used TEXT NOT NULL,          -- e.g. 'gemini-2.5-flash'
  model_notes TEXT,                  -- any caveats/reasoning the model gave
  queried_at INTEGER NOT NULL,

  -- Explicit confidence flag AND human-readable label — never let this get
  -- treated as equal-weight to a real observed sale. Both are stored so any
  -- downstream query/display can't drop the caveat by only checking one.
  confidence_tier TEXT NOT NULL DEFAULT 'low_ai_estimate',
  source_label TEXT NOT NULL DEFAULT 'Gemini assumption — not verified sale data',

  created_at INTEGER NOT NULL,

  UNIQUE(title, film_year, size, country, condition_raw, style, queried_at)
);

CREATE INDEX IF NOT EXISTS idx_ai_price_estimates_title ON ai_price_estimates(title);
