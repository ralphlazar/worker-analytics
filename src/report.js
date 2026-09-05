// Turning rows into the report the dashboard shows.
//
// The range is pulled from D1 once and everything is aggregated here in
// JavaScript. The alternative, one SQL query per panel, reads the same rows
// twenty times over, and D1's free tier meters rows read. It also makes the
// arithmetic testable on plain arrays with no database in the test at all.
//
// Visitors rotate daily (see collect.js), so "visitors" over a range is the
// sum of each day's unique visitors, not people. That is the honest number a
// cookieless count can give and the dashboard says so.

export const SESSION_GAP = 30 * 60; // seconds of silence that ends a session
const PAGE_SIZE = 5000;
const LIST_LIMIT = 200;

const COLUMNS =
  'id, ts, visitor, path, status, referrer, referrer_url, utm_source, utm_medium, utm_campaign, ' +
  'country, region, city, device, browser, os, lang';

/** Every non-bot pageview in [from, to), paged by id so no single reply is huge. */
export async function loadRows(db, from, to) {
  const rows = [];
  let cursor = 0;
  for (;;) {
    const { results } = await db
      .prepare(`SELECT ${COLUMNS} FROM pageviews WHERE ts >= ? AND ts < ? AND id > ? ORDER BY id LIMIT ?`)
      .bind(from, to, cursor, PAGE_SIZE)
      .all();
    rows.push(...results);
    if (results.length < PAGE_SIZE) return rows;
    cursor = results[results.length - 1].id;
  }
}

export async function loadBots(db, fromDay, toDay) {
  const { results } = await db
    .prepare('SELECT name, SUM(hits) AS hits FROM bot_hits WHERE day >= ? AND day <= ? GROUP BY name ORDER BY hits DESC LIMIT 50')
    .bind(fromDay, toDay)
    .all();
  return results;
}

export async function loadEvents(db, from, to) {
  const { results } = await db
    .prepare('SELECT ts, type, detail, path FROM events WHERE ts >= ? AND ts < ? ORDER BY ts DESC LIMIT 500')
    .bind(from, to)
    .all();
  return results;
}

/** Who is on the site right now: distinct visitors and their pages since `since`. */
export async function loadLive(db, since) {
  const { results } = await db
    .prepare('SELECT visitor, path, country, city, ts FROM pageviews WHERE ts >= ? ORDER BY ts DESC LIMIT 500')
    .bind(since)
    .all();
  const visitors = new Set(results.map((r) => r.visitor)).size;
  const pages = top(tally(results, (r) => r.path), 10);
  return { visitors, pages, recent: results.slice(0, 20) };
}

/** Count rows per key, with distinct visitors per key. */
function tally(rows, keyOf) {
  const map = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (key === null || key === undefined) continue;
    let entry = map.get(key);
    if (!entry) {
      entry = { key, views: 0, visitors: new Set() };
      map.set(key, entry);
    }
    entry.views += 1;
    entry.visitors.add(row.visitor);
  }
  return map;
}

function top(map, limit = LIST_LIMIT) {
  return [...map.values()]
    .sort((a, b) => b.views - a.views || String(a.key).localeCompare(String(b.key)))
    .slice(0, limit)
    .map((e) => ({ key: e.key, views: e.views, visitors: e.visitors.size }));
}

/** Split each visitor's pageviews into sessions on a 30-minute gap. */
export function sessionsOf(rows) {
  const byVisitor = new Map();
  for (const row of rows) {
    if (!byVisitor.has(row.visitor)) byVisitor.set(row.visitor, []);
    byVisitor.get(row.visitor).push(row);
  }
  const sessions = [];
  for (const [visitor, list] of byVisitor) {
    list.sort((a, b) => a.ts - b.ts);
    let current = null;
    for (const row of list) {
      if (!current || row.ts - current.last > SESSION_GAP) {
        current = { visitor, entry: row.path, exit: row.path, start: row.ts, last: row.ts, pages: 1, country: row.country, referrer: row.referrer };
        sessions.push(current);
      } else {
        current.exit = row.path;
        current.last = row.ts;
        current.pages += 1;
      }
    }
  }
  return sessions;
}

/** How many of each configured event type happened. Unconfigured types are not counted. */
function countEvents(events, types = []) {
  const counts = {};
  for (const { type } of types) counts[type] = 0;
  for (const event of events) if (Object.hasOwn(counts, event.type)) counts[event.type] += 1;
  return counts;
}

/** The headline numbers for a set of rows. Used for the range and the one before it. */
export function totalsOf(rows, events = [], config = {}) {
  const sessions = sessionsOf(rows);
  const bounces = sessions.filter((s) => s.pages === 1).length;
  const duration = sessions.reduce((sum, s) => sum + (s.last - s.start), 0);
  return {
    pageviews: rows.length,
    visitors: new Set(rows.map((r) => r.visitor)).size,
    sessions: sessions.length,
    bounceRate: sessions.length ? bounces / sessions.length : 0,
    pagesPerSession: sessions.length ? rows.length / sessions.length : 0,
    avgSessionSeconds: sessions.length ? duration / sessions.length : 0,
    notFound: rows.filter((r) => r.status === 404).length,
    eventCounts: countEvents(events, config.events),
  };
}

const HOUR = 3600;
const DAY = 86400;

/** Hourly buckets for a short range, daily otherwise. */
export const bucketFor = (from, to) => (to - from <= 3 * DAY ? 'hour' : 'day');

// Times are shifted by the viewer's offset before bucketing, so "today" and
// "Tuesday at 9" mean the viewer's today and Tuesday, not UTC's.
const label = (localTs, bucket) =>
  new Date(localTs * 1000).toISOString().slice(0, bucket === 'hour' ? 13 : 10);

export function series(rows, { from, to, tz = 0, bucket }) {
  const step = bucket === 'hour' ? HOUR : DAY;
  const shift = tz * 60;
  const counts = new Map();
  for (const row of rows) {
    const key = label(row.ts + shift, bucket);
    const entry = counts.get(key) || { pageviews: 0, visitors: new Set() };
    entry.pageviews += 1;
    entry.visitors.add(row.visitor);
    counts.set(key, entry);
  }
  const out = [];
  const end = to + shift;
  for (let t = Math.floor((from + shift) / step) * step; t < end; t += step) {
    const key = label(t, bucket);
    const entry = counts.get(key);
    out.push({ t: key, pageviews: entry ? entry.pageviews : 0, visitors: entry ? entry.visitors.size : 0 });
  }
  return out;
}

/** A 7 x 24 grid of pageviews, Sunday first, in the viewer's time. */
export function weekGrid(rows, tz = 0) {
  const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const row of rows) {
    const d = new Date((row.ts + tz * 60) * 1000);
    grid[d.getUTCDay()][d.getUTCHours()] += 1;
  }
  return grid;
}

const place = (row, field) => (row[field] ? `${row.country || '??'}|${row[field]}` : null);

/** The whole report for one range of rows. */
export function aggregate(rows, { from, to, tz = 0 }, events = [], config = {}) {
  const bucket = bucketFor(from, to);
  const sessions = sessionsOf(rows);
  const bySession = (field) => {
    const map = new Map();
    for (const s of sessions) {
      const entry = map.get(s[field]) || { key: s[field], views: 0, visitors: new Set() };
      entry.views += 1;
      entry.visitors.add(s.visitor);
      map.set(s[field], entry);
    }
    return top(map);
  };
  const split = (list) => list.map((e) => {
    const [country, name] = e.key.split('|');
    return { ...e, country, name };
  });

  return {
    range: { from, to, tz, bucket },
    totals: totalsOf(rows, events, config),
    series: series(rows, { from, to, tz, bucket }),
    week: weekGrid(rows, tz),
    pages: top(tally(rows, (r) => r.path)),
    // One panel per configured path prefix, e.g. every /art/ page on an
    // artist's site, so the report can single out the pages a site is about.
    prefixPanels: (config.panels || []).map((panel) => ({
      ...panel,
      list: top(tally(rows, (r) => (r.path.startsWith(panel.prefix) ? r.path : null))),
    })),
    entries: bySession('entry'),
    exits: bySession('exit'),
    countries: top(tally(rows, (r) => r.country || '??')),
    regions: split(top(tally(rows, (r) => place(r, 'region')))),
    cities: split(top(tally(rows, (r) => place(r, 'city')))),
    referrers: top(tally(rows, (r) => r.referrer)),
    referrerUrls: top(tally(rows, (r) => r.referrer_url)),
    sources: top(tally(rows, (r) => r.utm_source)),
    mediums: top(tally(rows, (r) => r.utm_medium)),
    campaigns: top(tally(rows, (r) => r.utm_campaign)),
    devices: top(tally(rows, (r) => r.device)),
    browsers: top(tally(rows, (r) => r.browser)),
    oses: top(tally(rows, (r) => r.os)),
    languages: top(tally(rows, (r) => r.lang)),
    notFound: top(tally(rows.filter((r) => r.status === 404), (r) => r.path)),
    events: events.slice(0, 100),
  };
}

export const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** Everything the dashboard asks for in one call. */
export async function buildReport(db, { from, to, tz = 0, now = Math.floor(Date.now() / 1000) }, config = {}) {
  const length = to - from;
  const [rows, events, bots, live] = await Promise.all([
    loadRows(db, from - length, to),
    loadEvents(db, from - length, to),
    loadBots(db, dayOf(from), dayOf(to)),
    loadLive(db, now - SESSION_GAP),
  ]);
  const current = rows.filter((r) => r.ts >= from);
  const previous = rows.filter((r) => r.ts < from);
  const report = aggregate(current, { from, to, tz }, events.filter((e) => e.ts >= from), config);
  report.previous = totalsOf(previous, events.filter((e) => e.ts < from), config);
  report.bots = { total: bots.reduce((sum, b) => sum + b.hits, 0), list: bots };
  report.live = live;
  report.generatedAt = now;
  return report;
}

const CSV_COLUMNS = ['ts', 'visitor', 'path', 'status', 'referrer', 'referrer_url', 'utm_source', 'utm_medium', 'utm_campaign', 'country', 'region', 'city', 'device', 'browser', 'os', 'lang'];
const csvCell = (value) => {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/** The raw rows for a range as CSV, with a readable time column first. */
export async function buildCsv(db, { from, to }) {
  const rows = await loadRows(db, from, to);
  const lines = [['time', ...CSV_COLUMNS].join(',')];
  for (const row of rows) {
    lines.push([new Date(row.ts * 1000).toISOString(), ...CSV_COLUMNS.map((c) => csvCell(row[c]))].join(','));
  }
  return `${lines.join('\n')}\n`;
}
