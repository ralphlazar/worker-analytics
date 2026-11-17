-- Day summaries: what is kept for good once a day's pageview rows are deleted
-- (worker-analytics, src/rollup.js).
--
-- The retention job rolls each settled UTC day of `pageviews` into these three
-- tables and only then deletes pageview rows older than the retention limit, so
-- the long view survives the deletion and only the ability to ask "who" goes
-- away. Nothing here holds a visitor label, a city, a region, a language, an
-- operating system or a referrer, and no count is per page AND per place: no
-- row can be joined back to a reader. The breakdowns are for the site as a
-- whole, never per page, because on a small site most page-and-day pairs have
-- a count of one, and "one visitor, this page, this city, this phone, this
-- browser, this day" is a person with the label taken off.
--
-- EVERY count is stored twice. `views` and its siblings count everything the
-- site served. `views_human` and its siblings count only the visits that look
-- human, by the rule in src/rollup.js. The second set is the point and not an
-- extra: on a site that crawlers have found, most of what is served is an
-- automated reader sending a real browser user agent, which a collector's bot
-- test cannot tell from a person, so a permanent record of the first set alone
-- would be a permanent chart of robots with the few real readers underneath it
-- deleted along with the raw rows. Everything below adds across days, which is
-- what lets a range of any length be answered from it.
--
-- `filter_version` is on every row and says which version of the human rule
-- wrote it (FILTER.version in src/rollup.js). A day is summarised once and is
-- never rewritten, so tuning the rule later changes the days summarised from
-- then on and leaves history alone, and the version says where the change fell.
--
-- A day is written all at once or not at all: its `daily_totals` row is the
-- claim on the day, the first statement of the batch that writes the rest, so a
-- second run of the same day fails that statement and the batch rolls back.
-- A day with no pageviews has no row here, and reads as zero.

-- One row per page per day.
CREATE TABLE daily_pages (
  day TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  path TEXT NOT NULL,
  views INTEGER NOT NULL,           -- pageviews of this path, 404s included
  views_human INTEGER NOT NULL,
  visitors INTEGER NOT NULL,        -- distinct visitor labels that viewed it that day
  visitors_human INTEGER NOT NULL,
  entries INTEGER NOT NULL,         -- visits that began here
  entries_human INTEGER NOT NULL,
  exits INTEGER NOT NULL,           -- visits that ended here
  exits_human INTEGER NOT NULL,
  not_found INTEGER NOT NULL,       -- of the views, those that answered 404
  not_found_human INTEGER NOT NULL,
  filter_version INTEGER NOT NULL,
  PRIMARY KEY (day, path)
);

-- One row per day for the whole site: the figures that cannot be added up from
-- daily_pages, because a visitor who reads three pages is one visitor and a
-- visit is not a pageview.
CREATE TABLE daily_totals (
  day TEXT PRIMARY KEY,             -- YYYY-MM-DD, UTC
  views INTEGER NOT NULL,
  views_human INTEGER NOT NULL,
  visitors INTEGER NOT NULL,        -- distinct visitor labels across the site that day
  visitors_human INTEGER NOT NULL,
  sessions INTEGER NOT NULL,        -- visits: a visitor's views, split on half an hour of silence
  sessions_human INTEGER NOT NULL,
  bounces INTEGER NOT NULL,         -- one-page visits, for the bounce rate
  bounces_human INTEGER NOT NULL,
  seconds INTEGER NOT NULL,         -- visit time summed (last view minus first), for the average
  seconds_human INTEGER NOT NULL,
  hours TEXT NOT NULL,              -- JSON array of 24 view counts, UTC hour 0 to 23, for the weekday heat map
  hours_human TEXT NOT NULL,
  filter_version INTEGER NOT NULL
);

-- One row per day per value, site wide: the day's countries, devices and
-- browsers, never joined to a page. City, region, language and operating system
-- are absent on purpose. The CHECK is the privacy ruling written into the
-- schema, so that no bug and no stray INSERT can put another kind here:
-- widening the list changes what the published privacy notice says the
-- summaries hold, so it takes a new migration that rebuilds this table, on
-- purpose.
CREATE TABLE daily_breakdown (
  day TEXT NOT NULL,                -- YYYY-MM-DD, UTC
  kind TEXT NOT NULL CHECK (kind IN ('country', 'device', 'browser')),
  value TEXT NOT NULL,              -- a country code ('??' when unknown), a device or a browser name
  views INTEGER NOT NULL,
  views_human INTEGER NOT NULL,
  visitors INTEGER NOT NULL,
  visitors_human INTEGER NOT NULL,
  filter_version INTEGER NOT NULL,
  PRIMARY KEY (day, kind, value)
);
