-- Migration: poster_listings
-- Current asking-price data (Posterarti, Film Art Gallery, active eBay
-- listings). Kept separate from poster_auctions because asking price and
-- realized sale price are different signals for a valuation model.

CREATE TABLE IF NOT EXISTS poster_listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  title TEXT NOT NULL,
  format TEXT,
  asking_price REAL NOT NULL,
  currency TEXT NOT NULL DEFAULT 'USD',

  source TEXT NOT NULL,              -- 'posterarti' | 'filmartgallery' | 'ebay_active' | ...
  source_url TEXT NOT NULL,

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  still_listed INTEGER NOT NULL DEFAULT 1,  -- 0/1 — set to 0 once a re-scrape no longer finds it

  matched_inventory_id INTEGER REFERENCES inventory(id),
  match_confidence REAL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(source_url)
);

CREATE INDEX IF NOT EXISTS idx_poster_listings_title ON poster_listings(title);
CREATE INDEX IF NOT EXISTS idx_poster_listings_source ON poster_listings(source);
CREATE INDEX IF NOT EXISTS idx_poster_listings_matched_inventory ON poster_listings(matched_inventory_id);
