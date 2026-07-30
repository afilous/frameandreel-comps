-- Migration: current_auction_watch
-- Live/upcoming eMoviePoster auctions — distinct from both poster_auctions
-- (realized sales) and poster_listings (static asking prices), since this
-- data is time-bounded (has a closing time, current bid moves) and its
-- entire purpose is different: deciding whether/how much to bid, not
-- recording a completed transaction or a retail price.

CREATE TABLE IF NOT EXISTS current_auction_watch (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  lot_number TEXT,
  title TEXT NOT NULL,
  film_year INTEGER,
  size TEXT,
  country TEXT,
  condition_raw TEXT,
  extra_info_raw TEXT,
  extra_info_tags TEXT,          -- JSON array, same convention as poster_auctions

  current_bid REAL,
  num_bids INTEGER,
  closing_at INTEGER,            -- epoch ms — when this lot closes

  source_url TEXT NOT NULL,

  -- Decision-support fields — populated by the valuation logic (once built)
  -- comparing this lot against poster_auctions history for the same
  -- title+format+condition, not by the scraper itself.
  suggested_max_bid REAL,
  suggested_max_bid_basis TEXT,  -- e.g. "median of 12 comps, VG-or-better, last 2y"

  watch_status TEXT NOT NULL DEFAULT 'watching', -- 'watching' | 'bid_placed' | 'won' | 'lost' | 'passed'

  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,

  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,

  UNIQUE(source_url)
);

CREATE INDEX IF NOT EXISTS idx_current_auction_watch_title ON current_auction_watch(title);
CREATE INDEX IF NOT EXISTS idx_current_auction_watch_closing_at ON current_auction_watch(closing_at);
CREATE INDEX IF NOT EXISTS idx_current_auction_watch_status ON current_auction_watch(watch_status);
