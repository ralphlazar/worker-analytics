-- Google Search Console data (worker-analytics, src/search-console.js): the
-- words people typed into Google to reach the site, and the pages they landed
-- on. The only source for this exists: Google stopped sending search terms in
-- the referrer in 2013. Pulled on demand when the dashboard is opened (Pages
-- has no cron), two to three days behind, and trimmed by Google, which
-- withholds rare searches, so query totals run below the real click count.
-- Rows are upserted by day, so a refresh never duplicates a day.
CREATE TABLE search_queries (
  day TEXT NOT NULL,            -- YYYY-MM-DD
  query TEXT NOT NULL,          -- what was typed into Google
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL,                -- average position in the results that day
  PRIMARY KEY (day, query)
);

CREATE TABLE search_pages (
  day TEXT NOT NULL,
  page TEXT NOT NULL,           -- the landing page as Google reports it, a full URL
  clicks INTEGER NOT NULL DEFAULT 0,
  impressions INTEGER NOT NULL DEFAULT 0,
  position REAL,
  PRIMARY KEY (day, page)
);

-- Sync state, one row per key: property, last_refresh, last_attempt, lock,
-- backfill_next, backfill_until, backfill_done, last_error.
CREATE TABLE search_sync (
  key TEXT PRIMARY KEY,
  value TEXT
);
