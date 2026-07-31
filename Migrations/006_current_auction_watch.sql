-- Current/upcoming eMoviePoster auctions — append-only log, NOT upserted.
-- Every scraper run inserts fresh rows, so running this repeatedly as an
-- auction approaches builds a natural time series per item (distinguished
-- by scraped_at) rather than overwriting — that's the whole point: seeing
-- how price and bidder activity move as the close date approaches.
--
-- NOTE: this replaces an earlier speculative version of this table (which
-- was designed before the scraper's real output shape was confirmed, and
-- was never actually applied to the live database). Column names/shapes
-- here match exactly what emovieposter_current_auctions.ts actually
-- outputs, confirmed against a real full run (2,790 items across all 3
-- auction days).

CREATE TABLE IF NOT EXISTS current_auction_watch (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  item_code TEXT,                  -- e.g. "2f0102" — usually present, opportunistically extracted, not guaranteed
  title_raw TEXT NOT NULL,
  condition_grade TEXT,
  price_type TEXT NOT NULL,        -- 'starting' (no bids yet) | 'current' (has a high bidder)
  price NUMERIC,
  high_bidder TEXT,
  time_left_raw TEXT,              -- e.g. "4 days 2 hours" — relative to scraped_at, not yet converted to absolute
  auction_day TEXT NOT NULL,       -- 'tuesday' | 'thursday' | 'sunday' | 'custom' (when LISTING_URL overrides the default 3-day scrape)

  scraped_at TIMESTAMPTZ NOT NULL, -- when THIS particular page load happened — the time-series key
  source_url TEXT NOT NULL,        -- the listing page URL (shared across all items from one page load, not per-item)

  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_current_auction_watch_item_code ON current_auction_watch(item_code);
CREATE INDEX IF NOT EXISTS idx_current_auction_watch_scraped_at ON current_auction_watch(scraped_at);
CREATE INDEX IF NOT EXISTS idx_current_auction_watch_auction_day ON current_auction_watch(auction_day);
