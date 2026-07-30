-- Watchlist of titles Aaron wants historical comps for — this is how the
-- eMoviePoster historical scraper gets "directed" instead of running wide
-- open against the full ~2M-result archive. Add a row here (via Supabase's
-- Table Editor, or later a YouWare UI), and the next scraper run picks it
-- up automatically.
--
-- NOTE: this table was created directly in Supabase via SQL earlier in the
-- project (before this migrations/ folder convention was being kept in
-- sync with every change) — this file exists so the repo's migration
-- history matches what's actually live, not because it still needs running.

CREATE TABLE IF NOT EXISTS bid_watchlist (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,

  title TEXT NOT NULL,
  notes TEXT,                     -- e.g. "looking for French Petite, VG+"

  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'archived' — archived rows are skipped by the scraper

  last_scraped_at TIMESTAMPTZ,    -- set by the scraper after a successful run, so you can see what's stale

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(title)
);

CREATE INDEX IF NOT EXISTS idx_bid_watchlist_status ON bid_watchlist(status);
