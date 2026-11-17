// The daily rollup and delete: the job that makes a retention limit true.
//
// Raw pageview rows are kept for RETENTION_DAYS and then deleted. What outlives
// them is three tables of day summaries (migrations/0003_daily_summaries.sql),
// written HERE, BEFORE a day's rows go, so the long view survives the deletion
// and only the ability to ask "who" goes away. Each run, oldest day first:
//
//   1. rolls up every settled UTC day that has no summary yet, one atomic
//      batch per day, and
//   2. deletes the pageview rows of days older than the retention limit, but
//      only those whose summary exists and accounts for every row.
//
// worker/index.js is the Worker that calls this on a daily Cron Trigger. It is a
// separate Worker because a Pages Function has no scheduled handler.
//
// EVERYTHING IS COUNTED TWICE. Every count in the summaries is stored once for
// everything the site served and once for the visits that look human, because
// on a site crawlers have found most of what is served is an automated reader
// sending a real browser user agent, which the collector's bot test cannot tell
// from a person. Summarised as they stand, the rows that survive the deletion
// would be a permanent chart of robots, and the few real readers underneath
// would be deleted with the raw rows.
//
// WHAT "LOOKS HUMAN" MEANS, and why it is not a second definition. It is the
// rule the first site's own sections page applies (its analytics_sections.js,
// visitsOf and rollUp), restated here so a Worker can run it, with the same
// session gap imported from report.js rather than retyped (a consumer writes
// `worker-analytics/report`). A visit is one visitor's pageviews on one UTC day,
// split wherever they went quiet for SESSION_GAP, so a visit never crosses
// midnight: the visitor label is rekeyed then. A visit looks human if it read
// more than one page or arrived by a link (a referrer or a utm tag on its first
// view), AND did not read at a page a second (its median gap between views is
// not under TOO_FAST_SECONDS). The sections page measured on the live data that
// these are two populations with nothing in between, which is why the line is
// defensible. It remains a reading of the rows and not a verdict: a crawler
// that goes slowly and follows a link counts as a person here.
//
// One difference, on purpose. Visits are built from every row, 404s included,
// as report.js sessionsOf builds them, so the "everything" columns agree with
// the full dashboard's KPIs and the human columns are those same visits with the
// filter on top. The sections page drops 404s before it forms visits. The two
// agree on every visit that holds no 404 and can differ on one that mixes a
// read with a broken link, which is the rare case.
//
// THE RULE IS VERSIONED. FILTER.version is written on every summary row. The
// rule's constants are pinned beside it in the tests, so changing the session
// gap, the speed line or the shape of the rule fails a test until the version is
// bumped. A day is summarised once and never rewritten, so a tuned rule applies
// from the days summarised after it and history keeps the rule it was written
// under.
//
// WHAT THIS NEVER DOES, each guarded where the damage would be done:
//   - It never writes a day twice. The day's daily_totals row is the claim on
//     it, the first statement of the batch that writes the rest, so a cron that
//     fires twice, a manual re-run or two runs at once make the second claim
//     fail and the batch roll back. Counts never double.
//   - It never writes a summary from zero rows, so a day whose rows are gone
//     cannot be overwritten with zeros.
//   - It never deletes an unsummarised day, or one whose summary does not count
//     every row it is about to delete. The DELETE itself carries the check.
//   - It never touches a day that has not settled (ended an hour ago).
//
// WHAT IT COSTS, for a plan that matters. A scheduled Worker on the Free plan
// has 50 D1 queries and 10 ms of CPU per run, and a db.batch() counts as one
// query. A run stays inside 50 queries: it does at most MAX_DAYS_PER_RUN days
// and stops early when the query budget runs out, so the backlog from a first
// run clears over a few nights, and nothing is lost meanwhile because deletion
// waits for summaries. It does not stay inside 10 ms. Measured on Node 24, a
// 2,500-row day took about 12 ms from a cold start, and a 10,000-row day about
// 35 ms. On the Free plan a run is therefore killed, which leaves nothing half
// written and deletes nothing, so it fails safe and does not keep the limit.
// The Paid plan lifts both limits and is what this job needs.

import { SESSION_GAP, dayOf } from './report.js';

// How long raw pageview rows are kept: the last RETENTION_DAYS UTC days,
// counting today, so a row is deleted in the early hours of its 91st day. It
// lives here and nowhere else in the job. RULED 2026-11-17 for the first site.
// The published privacy notice states this number, so changing it means
// changing the notice first.
export const RETENTION_DAYS = 90;

// A day is settled once it ended this long ago, so a row still being written as
// midnight passes cannot be missed by a run that starts just after it.
export const SETTLE_SECONDS = 3600;

// Per run: days summarised, and D1 queries (the Free plan allows 50, and the
// headroom is for the deletion and a heavy day).
export const MAX_DAYS_PER_RUN = 10;
export const QUERY_BUDGET = 40;

// Rows per read, and summary rows per INSERT statement.
export const PAGE_SIZE = 5000;
const ROWS_PER_INSERT = 250;

// The filter, versioned. See the top of this file.
export const FILTER = Object.freeze({ version: 1, sessionGap: SESSION_GAP, tooFastSeconds: 2 });

// The breakdowns kept, site wide. This list is the privacy ruling in code, and
// the CHECK on daily_breakdown.kind is the same ruling in the schema.
export const KINDS = Object.freeze(['country', 'device', 'browser']);

const DAY = 86400;
const HOUR = 3600;

/** Unix seconds at 00:00 UTC of a YYYY-MM-DD day. */
export const startOfDay = (day) => Date.parse(`${day}T00:00:00Z`) / 1000;

// ---------------------------------------------------------------- the rule

// Seconds between one view and the next, at the middle of a visit.
function medianGap(rows) {
  if (rows.length < 2) return null;
  const gaps = rows.slice(1).map((r, i) => r.ts - rows[i].ts).sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)];
}

/**
 * Whether one visit looks human: it read more than one page or arrived by a
 * link, and did not read at a page a second. `rows` are the visit's views in
 * order.
 */
export function looksHuman(rows) {
  const first = rows[0];
  const followedLink = Boolean(first.utm_source || first.utm_medium || first.utm_campaign || first.referrer);
  const gap = medianGap(rows);
  const tooFast = gap !== null && gap < FILTER.tooFastSeconds;
  return !tooFast && (rows.length > 1 || followedLink);
}

/**
 * Split rows into visits: one visitor's views, broken wherever they went quiet
 * for more than SESSION_GAP, each judged by looksHuman. `rows` is in id order,
 * as loadDay returns it; equal times keep that order. A visitor's visits come
 * out together, in time order.
 */
export function visitsOf(rows) {
  const byVisitor = new Map();
  for (const row of rows) {
    const list = byVisitor.get(row.visitor);
    if (list) list.push(row);
    else byVisitor.set(row.visitor, [row]);
  }
  const visits = [];
  for (const [visitor, list] of byVisitor) {
    if (list.length > 1) list.sort((a, b) => a.ts - b.ts);
    let current = null;
    for (const row of list) {
      if (!current || row.ts - current.last > FILTER.sessionGap) {
        current = { visitor, rows: [row], start: row.ts, last: row.ts, human: false };
        visits.push(current);
      } else {
        current.rows.push(row);
        current.last = row.ts;
      }
    }
  }
  for (const visit of visits) visit.human = looksHuman(visit.rows);
  return visits;
}

// ------------------------------------------------------------ one day's sums

// Slots in a page's counters, and in a breakdown value's. Each count and then
// its human twin.
const V = 0; const VH = 1; const VIS = 2; const VISH = 3;
const ENT = 4; const ENTH = 5; const EXT = 6; const EXTH = 7; const NF = 8; const NFH = 9;

const counters = (map, key, width) => {
  let entry = map.get(key);
  if (!entry) {
    entry = new Array(width).fill(0);
    map.set(key, entry);
  }
  return entry;
};

const byText = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

/** The value a row files under in a breakdown, or null when there is none. */
function valueOf(row, kind) {
  const value = kind === 'country' ? (row.country || '??') : row[kind];
  return value === null || value === undefined || value === '' ? null : String(value);
}

/**
 * Everything one day's rows add up to, for the three tables. Pure: no database
 * and no clock, so it is tested on plain arrays. `rows` is every pageview of the
 * UTC `day`, 404s included, in id order.
 */
export function summariseDay(rows, day) {
  const start = startOfDay(day);
  const pages = new Map();
  const breakdown = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
  const hours = new Array(24).fill(0);
  const hoursHuman = new Array(24).fill(0);
  const totals = {
    views: 0, viewsHuman: 0, visitors: 0, visitorsHuman: 0, sessions: 0, sessionsHuman: 0,
    bounces: 0, bouncesHuman: 0, seconds: 0, secondsHuman: 0,
  };

  // Per visitor: which paths and values this visitor has already been counted
  // for, so a visitor who reads a page twice, or ten pages, is one visitor.
  // Bit 1 is counted among everyone, bit 2 among the human visits.
  const seenPath = new Map();
  const seenValue = Object.fromEntries(KINDS.map((kind) => [kind, new Map()]));
  let visitor;
  let started = false;
  let anyHuman = false;

  const closeVisitor = () => {
    totals.visitors += 1;
    if (anyHuman) totals.visitorsHuman += 1;
  };

  for (const visit of visitsOf(rows)) {
    if (!started || visit.visitor !== visitor) {
      if (started) closeVisitor();
      started = true;
      visitor = visit.visitor;
      anyHuman = false;
      seenPath.clear();
      for (const kind of KINDS) seenValue[kind].clear();
    }
    const human = visit.human;
    if (human) anyHuman = true;
    const n = visit.rows.length;

    totals.views += n;
    totals.sessions += 1;
    totals.seconds += visit.last - visit.start;
    if (n === 1) totals.bounces += 1;
    if (human) {
      totals.viewsHuman += n;
      totals.sessionsHuman += 1;
      totals.secondsHuman += visit.last - visit.start;
      if (n === 1) totals.bouncesHuman += 1;
    }

    const entry = counters(pages, visit.rows[0].path, 10);
    const exit = counters(pages, visit.rows[n - 1].path, 10);
    entry[ENT] += 1;
    exit[EXT] += 1;
    if (human) {
      entry[ENTH] += 1;
      exit[EXTH] += 1;
    }

    for (const row of visit.rows) {
      const missing = row.status === 404 ? 1 : 0;
      const page = counters(pages, row.path, 10);
      page[V] += 1;
      page[NF] += missing;
      let mark = seenPath.get(row.path) || 0;
      if (!(mark & 1)) {
        page[VIS] += 1;
        mark |= 1;
      }
      if (human) {
        page[VH] += 1;
        page[NFH] += missing;
        if (!(mark & 2)) {
          page[VISH] += 1;
          mark |= 2;
        }
      }
      seenPath.set(row.path, mark);

      const hour = Math.floor((row.ts - start) / HOUR);
      if (!(hour >= 0 && hour < 24)) throw new Error(`rollup: a row at ${row.ts} is not on ${day}`);
      hours[hour] += 1;
      if (human) hoursHuman[hour] += 1;

      for (const kind of KINDS) {
        const value = valueOf(row, kind);
        if (value === null) continue;
        const entryFor = counters(breakdown[kind], value, 4);
        entryFor[V] += 1;
        let seen = seenValue[kind].get(value) || 0;
        if (!(seen & 1)) {
          entryFor[VIS] += 1;
          seen |= 1;
        }
        if (human) {
          entryFor[VH] += 1;
          if (!(seen & 2)) {
            entryFor[VISH] += 1;
            seen |= 2;
          }
        }
        seenValue[kind].set(value, seen);
      }
    }
  }
  if (started) closeVisitor();

  return {
    day,
    filter: FILTER.version,
    totals: { ...totals, hours, hoursHuman },
    pages: [...pages].sort(byText).map(([path, c]) => ({
      path, views: c[V], viewsHuman: c[VH], visitors: c[VIS], visitorsHuman: c[VISH],
      entries: c[ENT], entriesHuman: c[ENTH], exits: c[EXT], exitsHuman: c[EXTH],
      notFound: c[NF], notFoundHuman: c[NFH],
    })),
    breakdown: KINDS.flatMap((kind) => [...breakdown[kind]].sort(byText).map(([value, c]) => ({
      kind, value, views: c[V], viewsHuman: c[VH], visitors: c[VIS], visitorsHuman: c[VISH],
    }))),
  };
}

// ------------------------------------------------------------------ the data

const COLUMNS = 'id, ts, visitor, path, status, referrer, utm_source, utm_medium, utm_campaign, country, device, browser';

/**
 * Every pageview of one UTC day, in id order, paged by id so no single reply
 * from D1 is huge. Eleven columns, not the table's seventeen: nothing here
 * needs the referring URL, the region, the city, the system or the language.
 */
export async function loadDay(db, day, { pageSize = PAGE_SIZE } = {}) {
  const from = startOfDay(day);
  const rows = [];
  let cursor = 0;
  let queries = 0;
  for (;;) {
    const { results } = await db
      .prepare(`SELECT ${COLUMNS} FROM pageviews WHERE ts >= ? AND ts < ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(from, from + DAY, cursor, pageSize)
      .all();
    queries += 1;
    for (const row of results) rows.push(row);
    if (results.length < pageSize) return { rows, queries };
    cursor = results[results.length - 1].id;
  }
}

const INSERT_TOTALS = `INSERT INTO daily_totals
  (day, views, views_human, visitors, visitors_human, sessions, sessions_human, bounces, bounces_human,
   seconds, seconds_human, hours, hours_human, filter_version)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

// Summary rows go in as JSON arrays through json_each, a few hundred to a
// statement: one bound parameter instead of a hundred, and one JSON.stringify
// instead of thousands of prepared statements, which is what a Worker's CPU
// budget wants. The day and the filter version are bound beside it.
const element = (n) => Array.from({ length: n }, (_, i) => `json_extract(j.value, '$[${i}]')`).join(', ');

const INSERT_PAGES = `INSERT INTO daily_pages
  (day, path, views, views_human, visitors, visitors_human, entries, entries_human, exits, exits_human,
   not_found, not_found_human, filter_version)
  SELECT ?, ${element(11)}, ? FROM json_each(?) AS j`;

const INSERT_BREAKDOWN = `INSERT INTO daily_breakdown
  (day, kind, value, views, views_human, visitors, visitors_human, filter_version)
  SELECT ?, ${element(6)}, ? FROM json_each(?) AS j`;

const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));

/**
 * Write one day's summary, all of it or none. The daily_totals insert comes
 * first and is a plain INSERT: if the day already has a summary it fails on the
 * primary key and D1 rolls the whole batch back, so a second run, or two at
 * once, cannot double a count or overwrite a finished day. The deletes after it
 * only run once the claim has succeeded, and clear any stray rows from an
 * earlier half-finished attempt. Returns false when the day was already
 * summarised, which is not a failure.
 */
export async function writeDay(db, summary) {
  const { day, filter, totals: t } = summary;
  const statements = [
    db.prepare(INSERT_TOTALS).bind(
      day, t.views, t.viewsHuman, t.visitors, t.visitorsHuman, t.sessions, t.sessionsHuman,
      t.bounces, t.bouncesHuman, t.seconds, t.secondsHuman,
      JSON.stringify(t.hours), JSON.stringify(t.hoursHuman), filter,
    ),
    db.prepare('DELETE FROM daily_pages WHERE day = ?').bind(day),
    db.prepare('DELETE FROM daily_breakdown WHERE day = ?').bind(day),
  ];
  for (const part of chunks(summary.pages, ROWS_PER_INSERT)) {
    statements.push(db.prepare(INSERT_PAGES).bind(day, filter, JSON.stringify(part.map((p) => [
      p.path, p.views, p.viewsHuman, p.visitors, p.visitorsHuman, p.entries, p.entriesHuman,
      p.exits, p.exitsHuman, p.notFound, p.notFoundHuman,
    ]))));
  }
  for (const part of chunks(summary.breakdown, ROWS_PER_INSERT)) {
    statements.push(db.prepare(INSERT_BREAKDOWN).bind(day, filter, JSON.stringify(part.map((b) => [
      b.kind, b.value, b.views, b.viewsHuman, b.visitors, b.visitorsHuman,
    ]))));
  }
  try {
    await db.batch(statements);
    return true;
  } catch (error) {
    // The usual cause is the claim failing because the day is already done. Ask
    // rather than read the message, which is D1's to word.
    const { results } = await db.prepare('SELECT day FROM daily_totals WHERE day = ?').bind(day).all();
    if (results.length) return false;
    throw error;
  }
}

// ----------------------------------------------------------------- the run

/**
 * What a run at `now` (unix seconds) may touch. `keepFrom` is the first second
 * of the oldest day still kept: rows before it are over the limit. `boundary` is
 * the end of the newest settled day: rows at or after it are not summarised.
 */
export function windowsFor(now, retentionDays = RETENTION_DAYS) {
  const today = dayOf(now);
  return {
    today,
    keepFrom: startOfDay(today) - (retentionDays - 1) * DAY,
    boundary: Math.floor((now - SETTLE_SECONDS) / DAY) * DAY,
  };
}

// A day's rows go only if its summary counts every one of them: the SQL says so
// itself, whatever the code that called it believed.
const DELETE_DAY = `DELETE FROM pageviews WHERE ts >= ? AND ts < ?
  AND EXISTS (SELECT 1 FROM daily_totals WHERE day = ? AND views = ?)`;

/**
 * Roll up every settled day that has no summary, oldest first and a few at a
 * time, then delete the rows of days past the retention limit. Safe to run any
 * number of times, together or apart. Returns a report and never throws for a
 * problem it can describe: see problemsOf. Only a failure of the first reads,
 * before anything has been done, escapes as an exception.
 */
export async function runRollup(db, {
  now = Math.floor(Date.now() / 1000), retentionDays = RETENTION_DAYS, maxDays = MAX_DAYS_PER_RUN,
  queryBudget = QUERY_BUDGET, pageSize = PAGE_SIZE,
} = {}) {
  const { today, keepFrom, boundary } = windowsFor(now, retentionDays);
  const report = {
    now, today, retentionDays, keepFrom: dayOf(keepFrom), settledThrough: dayOf(boundary - 1),
    summarised: [], deferred: [], deleted: { days: [], rows: 0 }, stuck: [], error: null, queries: 0,
  };

  // Which days have rows, and which have summaries. Two reads, and from them
  // everything below. A missing table is the likeliest thing to be wrong on the
  // first night (the migration not applied, or the binding on another database),
  // so it gets a message that says what to do.
  let grouped;
  let summaries;
  try {
    grouped = await db
      .prepare('SELECT CAST(ts AS INTEGER) / 86400 AS d, COUNT(*) AS n FROM pageviews WHERE ts < ? GROUP BY d ORDER BY d')
      .bind(boundary).all();
    summaries = await db.prepare('SELECT day, views FROM daily_totals').bind().all();
  } catch (error) {
    if (/no such table/i.test(String(error && error.message))) {
      throw new Error('rollup: a table is missing. Apply migrations 0001 to 0003 to this database, and check that '
        + `the ANALYTICS_DB binding is the site's analytics database (${error.message})`);
    }
    throw error;
  }
  report.queries += 2;
  const days = grouped.results.map(({ d, n }) => ({ day: dayOf(d * DAY), start: d * DAY, rows: n }));
  const done = new Map(summaries.results.map((r) => [r.day, r.views]));

  let attempted = 0;
  for (const item of days) {
    if (done.has(item.day)) continue;
    if (report.error) {
      report.deferred.push(item.day);
      continue;
    }
    // The first day of a run is always attempted. After that the run stops at
    // its day limit, or when it could not afford this day and the deletion.
    const needed = Math.ceil(item.rows / pageSize) + 2;
    if (attempted && (attempted >= maxDays || report.queries + needed > queryBudget)) {
      report.deferred.push(item.day);
      continue;
    }
    attempted += 1;
    try {
      const { rows, queries } = await loadDay(db, item.day, { pageSize });
      report.queries += queries;
      // Fewer rows than were counted a moment ago means rows went missing in
      // between. Summarising what is left would be a wrong summary, and
      // deleting after it a loss, so this day waits for a person.
      if (rows.length < item.rows) throw new Error(`${item.day} had ${item.rows} pageviews a moment ago and has ${rows.length} now`);
      const summary = summariseDay(rows, item.day);
      const written = await writeDay(db, summary);
      report.queries += 1;
      if (written) report.summarised.push({ day: item.day, views: summary.totals.views, pages: summary.pages.length });
      // Whoever wrote it, the summary stands and counts what this run saw.
      done.set(item.day, summary.totals.views);
      item.rows = summary.totals.views;
    } catch (error) {
      report.error = { day: item.day, message: String(error && error.message ? error.message : error) };
      report.deferred.push(item.day);
    }
  }

  // The deletion. Days over the limit whose summary counts every row go. Any
  // other day over the limit stays, because it is the one thing here that
  // cannot be undone, and is reported as stuck unless it is only waiting its
  // turn (a backlog bigger than one run, or the day a failure stopped at,
  // which report.error already says).
  const over = days.filter((item) => item.start < keepFrom);
  const eligible = over.filter((item) => done.get(item.day) === item.rows);
  const waiting = new Set(report.deferred);
  report.stuck = over.filter((item) => done.get(item.day) !== item.rows && !waiting.has(item.day)).map((item) => item.day);
  if (eligible.length) {
    try {
      const results = await db.batch(eligible.map((item) => db.prepare(DELETE_DAY).bind(item.start, item.start + DAY, item.day, item.rows)));
      report.queries += 1;
      eligible.forEach((item, i) => {
        const changed = results[i] && results[i].meta ? results[i].meta.changes || 0 : 0;
        if (changed) report.deleted.days.push(item.day);
        report.deleted.rows += changed;
      });
    } catch (error) {
      report.error = report.error || { day: null, message: `the deletion failed: ${String(error && error.message ? error.message : error)}` };
    }
  }
  return report;
}

/** What is wrong with a run, in words, or an empty list when nothing is. */
export function problemsOf(report) {
  const problems = [];
  if (report.error) problems.push(`${report.error.day ? `${report.error.day}: ` : ''}${report.error.message}`);
  if (report.stuck.length) {
    problems.push(`${report.stuck.length} day(s) are past the ${report.retentionDays}-day limit and still have rows, `
      + `because their summary is missing or does not count every row: ${report.stuck.join(', ')}`);
  }
  return problems;
}
