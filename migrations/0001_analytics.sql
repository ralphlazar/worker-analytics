-- Traffic analytics, recorded by the Worker itself (worker-analytics, src/collect.js).
--
-- One row per page a person is served. No cookies and no script on the page:
-- the Worker already sees every request, so it writes down what it has.
-- `visitor` is a one-way hash keyed on the day, so the same person counts once
-- per day and nothing here can be turned back into an address.
CREATE TABLE pageviews (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,          -- unix seconds
  visitor TEXT NOT NULL,        -- daily hash, never an IP
  path TEXT NOT NULL,
  status INTEGER NOT NULL,      -- 200 or 404
  referrer TEXT,                -- external host only, "www." stripped
  referrer_url TEXT,            -- the full external referrer, capped
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  country TEXT,                 -- ISO 3166-1 alpha-2
  region TEXT,
  city TEXT,
  device TEXT,                  -- desktop, mobile, tablet
  browser TEXT,
  os TEXT,
  lang TEXT                     -- first Accept-Language tag
);
CREATE INDEX pageviews_ts ON pageviews (ts);

-- Crawlers are counted, not logged: one row per bot per day rather than a
-- row per hit, so a busy crawler cannot fill the table.
CREATE TABLE bot_hits (
  day TEXT NOT NULL,            -- YYYY-MM-DD, UTC
  name TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, name)
);

-- Things a visitor did rather than pages they saw. Today: an enquiry sent
-- through the contact form, with the work it was about.
CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  visitor TEXT,
  type TEXT NOT NULL,
  detail TEXT,
  path TEXT
);
CREATE INDEX events_ts ON events (ts);
