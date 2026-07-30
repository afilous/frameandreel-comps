-- Migration: poster_auctions
-- Historical auction-comps table for poster valuation.
-- Lives in the same YouBase (EdgeSpark) database as `inventory`, so comp
-- lookups are straight joins, not cross-database fuzzy matching.

CREATE TABLE IF NOT EXISTS poster_auctions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Identity / matching fields — mirror the confirmed eMoviePoster archive
  -- columns directly (Title | Film Year | Size | Country | Condition |
  -- Extra Info | Date Sold | Final Price).
  title TEXT NOT NULL,
  title_original TEXT,          -- matches inventory.original_title
  title_local TEXT,             -- matches master_inventory.title_local
  film_year INTEGER,
  size TEXT,                    -- raw size/format string as scraped, e.g. "1sh", "40x60", "Japanese B1"
  country TEXT,                 -- e.g. "U.S.", "Japanese", "French"
  condition_raw TEXT,            -- exact text as scraped, e.g. "very good to fine"
  condition_normalized TEXT,     -- normalized to your inventory.condition_grade scale
  extra_info_raw TEXT,           -- verbatim scraped text (fold state, reissue code, edition, etc. concatenated)
  extra_info_tags TEXT,          -- JSON array of tag strings, e.g. ["unfolded","R08","Variant Edition"]

  -- Sale data — the actual comp
  sale_price REAL NOT NULL,
  sale_date INTEGER NOT NULL,   -- epoch ms, consistent with inventory.created_at style
  auction_house TEXT NOT NULL DEFAULT 'eMoviePoster',
  lot_number TEXT,
  source_url TEXT NOT NULL,

  -- Provenance / risk tracking — lets you distinguish automated-scrape rows
  -- from any manually-captured rows if you add that path later, and
  -- distinguishes 'emovieposter' (precise per-title) from
  -- 'emovieposter_tag_discovery' (broader context)
  capture_method TEXT NOT NULL DEFAULT 'automated_scrape',
  source TEXT NOT NULL DEFAULT 'emovieposter',

  -- Matching to live inventory, once/if resolved
  matched_inventory_id INTEGER REFERENCES inventory(id),
  match_confidence REAL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  -- Natural-key uniqueness up front — prevents duplicate rows on re-scrapes
  UNIQUE(source_url, title, sale_date, sale_price)
);

CREATE INDEX IF NOT EXISTS idx_poster_auctions_title ON poster_auctions(title);
CREATE INDEX IF NOT EXISTS idx_poster_auctions_size ON poster_auctions(size);
CREATE INDEX IF NOT EXISTS idx_poster_auctions_source ON poster_auctions(source);
CREATE INDEX IF NOT EXISTS idx_poster_auctions_sale_date ON poster_auctions(sale_date);
CREATE INDEX IF NOT EXISTS idx_poster_auctions_matched_inventory ON poster_auctions(matched_inventory_id);
