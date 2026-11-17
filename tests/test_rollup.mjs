// The retention rollup, checked by tripping its guards rather than assuming.
//
// What matters most, in order. The job must never double a count (a cron that
// fires twice, a manual re-run, two runs at once) and never delete a day it has
// not summarised or summarised wrongly, because a deleted row cannot come back.
// Every count must be stored twice, once for everything and once for the visits
// that look human, and a day of nothing but crawlers must come out with no
// people in it. "Everything" has to agree with the full dashboard's arithmetic
// and "human" with the rule the sections page applies, or the long view steps
// at the day the raw rows run out. And nothing that points at a reader may reach
// a summary table.
//
// These tests run the real SQL, against SQLite through node:sqlite, because
// the claims worth testing are about what a database does with a batch, a
// primary key and a DELETE, and a stand-in that merely records calls cannot
// say. The D1 stand-in below is SQLite with D1's batch semantics: one
// transaction, rolled back whole when any statement fails, counted as one
// query. The tables are built from the shipped migration files.
//
// Needs Node 22.13 or newer for node:sqlite. Run: npm test

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  RETENTION_DAYS, MAX_DAYS_PER_RUN, QUERY_BUDGET, SETTLE_SECONDS, FILTER, KINDS,
  looksHuman, visitsOf, summariseDay, writeDay, loadDay, windowsFor, runRollup, problemsOf, startOfDay,
} from '../src/rollup.js';
import { sessionsOf, aggregate, weekGrid, SESSION_GAP } from '../src/report.js';
import worker from '../worker/index.js';

// node:sqlite says it is experimental on some Node versions. Say nothing about it.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => (/sqlite/i.test(String(warning)) ? undefined : emitWarning.call(process, warning, ...rest));
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (file) => readFileSync(join(ROOT, file), 'utf8');

// --- a database, built from the shipped migrations ------------------------------

/** D1 as far as this package uses it, over SQLite: a batch is one transaction and one query. */
function d1(sqlite) {
  const db = { queries: 0, log: [], hook: null, failWhen: null };
  const exec = (sql, args) => {
    if (db.failWhen && db.failWhen(sql, args)) throw new Error('D1 down');
    const statement = sqlite.prepare(sql);
    if (/^\s*select/i.test(sql)) return { success: true, results: statement.all(...args).map((r) => ({ ...r })), meta: {} };
    const info = statement.run(...args);
    return { success: true, results: [], meta: { changes: Number(info.changes) } };
  };
  const statement = (sql, args = []) => ({
    sql,
    args,
    bind: (...next) => statement(sql, next),
    exec: () => exec(sql, args),
    async all() {
      db.queries += 1;
      db.log.push(sql);
      if (db.hook) await db.hook(sql, args);
      return exec(sql, args);
    },
    async run() { return this.all(); },
  });
  db.prepare = (sql) => statement(sql);
  db.batch = async (statements) => {
    db.queries += 1;
    db.log.push(...statements.map((s) => s.sql));
    if (db.hook) await db.hook('BATCH', statements);
    sqlite.exec('BEGIN');
    try {
      const out = statements.map((s) => s.exec());
      sqlite.exec('COMMIT');
      return out;
    } catch (error) {
      sqlite.exec('ROLLBACK');
      throw error;
    }
  };
  return db;
}

function freshDb() {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_analytics.sql', '0002_search_console.sql', '0003_daily_summaries.sql']) sqlite.exec(read(join('migrations', file)));
  return { sqlite, db: d1(sqlite) };
}

const INSERT = `INSERT INTO pageviews (id, ts, visitor, path, status, referrer, referrer_url, utm_source, utm_medium, utm_campaign,
  country, region, city, device, browser, os, lang) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
const COLS = ['id', 'ts', 'visitor', 'path', 'status', 'referrer', 'referrer_url', 'utm_source', 'utm_medium', 'utm_campaign',
  'country', 'region', 'city', 'device', 'browser', 'os', 'lang'];

function load(sqlite, rows) {
  const stmt = sqlite.prepare(INSERT);
  sqlite.exec('BEGIN');
  for (const row of rows) stmt.run(...COLS.map((c) => (row[c] === undefined ? null : row[c])));
  sqlite.exec('COMMIT');
}

const TABLES = ['daily_pages', 'daily_totals', 'daily_breakdown'];
const dump = (sqlite) => Object.fromEntries(TABLES.map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1, 2, 3`).all().map((r) => ({ ...r }))]));
const count = (sqlite, sql, ...args) => Number(Object.values(sqlite.prepare(sql).get(...args))[0]);

// --- rows ------------------------------------------------------------------------

let nextId = 1;
const at = (iso) => Date.parse(iso) / 1000;
const D = '2026-09-10';
const T = at(`${D}T00:00:00Z`);
const hms = (h, m, s) => T + h * 3600 + m * 60 + s;

const view = (over) => ({
  id: nextId++, ts: T, visitor: 'v', path: '/', status: 200, referrer: null, referrer_url: null,
  utm_source: null, utm_medium: null, utm_campaign: null, country: 'GB', region: 'England', city: 'London',
  device: 'desktop', browser: 'Chrome', os: 'macOS', lang: 'en-gb', ...over,
});

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- the rule ---------------------------------------------------------------------

test('a visit looks human if it read more than one page or came by a link, and did not read at a page a second', () => {
  const visit = (gaps, first = {}) => {
    let ts = 1000;
    return [view({ ts, ...first }), ...gaps.map((g) => view({ ts: (ts += g) }))];
  };
  const cases = [
    ['one page and no link is a machine', visit([]), false],
    ['one page and an empty referrer is still no link', visit([], { referrer: '' }), false],
    ['one page that followed a link is a person', visit([], { referrer: 'example.org' }), true],
    ['a utm source is a link', visit([], { utm_source: 'newsletter' }), true],
    ['a utm medium is a link', visit([], { utm_medium: 'email' }), true],
    ['a utm campaign is a link', visit([], { utm_campaign: 'autumn' }), true],
    ['two pages three seconds apart is a person', visit([3]), true],
    ['two pages one second apart is too fast', visit([1]), false],
    ['two pages in the same second is too fast', visit([0]), false],
    ['exactly two seconds is not under the line', visit([2]), true],
    ['a link does not excuse a page a second', visit([1], { referrer: 'example.org' }), false],
    ['two hundred pages in a second is a machine', visit(Array(199).fill(0)), false],
    ['the middle gap decides, not the average: a burst then waiting is still a burst', visit([1, 1, 1, 1000]), false],
    ['and a pause with one quick click is a person', visit([1, 600, 600, 600]), true],
    ['with an even number of gaps the upper middle one decides', visit([1, 2]), true],
  ];
  for (const [name, rows, expected] of cases) assert.equal(looksHuman(rows), expected, name);
});

test('a visit is split on more than half an hour of silence, and never before', () => {
  const two = (gap) => visitsOf([view({ visitor: 'a', ts: 5000 }), view({ visitor: 'a', ts: 5000 + gap })]);
  assert.equal(two(SESSION_GAP).length, 1, 'exactly the gap is still one visit');
  assert.equal(two(SESSION_GAP + 1).length, 2, 'one second more is a new one');
  assert.equal(two(60).length, 1);
  // Two different visitors are never one visit, however close.
  assert.equal(visitsOf([view({ visitor: 'a', ts: 5000 }), view({ visitor: 'b', ts: 5001 })]).length, 2);
});

test('rows come in id order and a visit is put in time order, equal times keeping id order', () => {
  const rows = [
    view({ visitor: 'a', ts: 105, path: '/late' }),
    view({ visitor: 'a', ts: 100, path: '/early', referrer: 'example.org' }),
    view({ visitor: 'b', ts: 100, path: '/first', referrer: 'example.org' }),
    view({ visitor: 'b', ts: 100, path: '/second' }),
  ];
  const [a, b] = visitsOf(rows);
  assert.deepEqual(a.rows.map((r) => r.path), ['/early', '/late'], 'time order within a visit');
  assert.deepEqual(b.rows.map((r) => r.path), ['/first', '/second'], 'a tie keeps the order the rows arrived in');
});

test('the rule and its constants are pinned, so tuning one means bumping the version', () => {
  // If this fails you have changed the session gap, the speed line, or the
  // list of breakdowns kept. Summaries already written keep the rule they were
  // written under, which is what filter_version says. Bump FILTER.version in
  // src/rollup.js, then update this line, and change the first site's
  // analytics_sections.js to match: there must be one rule, not two.
  assert.deepEqual({ ...FILTER }, { version: 1, sessionGap: 1800, tooFastSeconds: 2 });
  assert.equal(FILTER.sessionGap, SESSION_GAP, 'the session gap is the package\'s, imported and not retyped');
  assert.ok(Object.isFrozen(FILTER));
  assert.deepEqual([...KINDS], ['country', 'device', 'browser'], 'city is dropped, and so is everything else about a place');
  assert.equal(RETENTION_DAYS, 90);
});

// --- the schema -------------------------------------------------------------------

test('the migration adds three tables, every count has a human twin and every row a filter version', () => {
  const { sqlite } = freshDb();
  const columns = (table) => sqlite.prepare(`PRAGMA table_info(${table})`).all();
  for (const table of TABLES) {
    const names = columns(table).map((c) => c.name);
    assert.ok(names.includes('filter_version'), `${table} says which version of the rule wrote it`);
    assert.equal(columns(table).find((c) => c.name === 'filter_version').notnull, 1);
    for (const name of names.filter((n) => n.endsWith('_human'))) assert.ok(names.includes(name.replace(/_human$/, '')), `${name} has its twin`);
  }
  const counts = {
    daily_pages: ['views', 'visitors', 'entries', 'exits', 'not_found'],
    daily_totals: ['views', 'visitors', 'sessions', 'bounces', 'seconds', 'hours'],
    daily_breakdown: ['views', 'visitors'],
  };
  for (const [table, list] of Object.entries(counts)) {
    const names = columns(table).map((c) => c.name);
    for (const name of list) {
      assert.ok(names.includes(name), `${table}.${name}`);
      assert.ok(names.includes(`${name}_human`), `${table}.${name}_human`);
    }
  }
  assert.deepEqual(columns('daily_totals').map((c) => c.name).filter((n) => !n.endsWith('_human') && n !== 'filter_version'),
    ['day', 'views', 'visitors', 'sessions', 'bounces', 'seconds', 'hours'], 'exactly the ruled columns, and their twins');
});

test('the schema itself refuses a breakdown the ruling did not allow', () => {
  const { sqlite } = freshDb();
  const put = (kind) => sqlite.prepare('INSERT INTO daily_breakdown VALUES (?, ?, ?, 1, 1, 1, 1, 1)').run(D, kind, 'x');
  for (const kind of KINDS) put(kind);
  for (const kind of ['city', 'region', 'os', 'lang', 'referrer']) assert.throws(() => put(kind), /CHECK/, `${kind} must not be kept`);
});

// --- one day, counted twice ---------------------------------------------------------

/** A day with every shape in it, and every number worked out by hand below. */
function handDay() {
  const crawl = (visitor, path, ts, country = 'ES') => view({ visitor, path, ts, country, region: null, city: null });
  return [
    crawl('crawl-a', '/almanac/a/', hms(2, 0, 0)),
    crawl('crawl-b', '/almanac/b/', hms(2, 0, 5), 'IT'),
    crawl('crawl-c', '/almanac/a/', hms(13, 0, 0)),
    // A burst: five pages in four seconds, one a second. A machine, though it read more than one page.
    ...[1, 2, 3, 4, 5].map((n, i) => crawl('racer', `/almanac/r${n}/`, hms(6, 0, i), 'DE')),
    // A person: came from a search, read three pages over a minute and a half.
    view({ visitor: 'reader', path: '/', ts: hms(9, 0, 0), referrer: 'google.com', browser: 'Firefox' }),
    view({ visitor: 'reader', path: '/books/', ts: hms(9, 0, 30), browser: 'Firefox' }),
    view({ visitor: 'reader', path: '/books/b1/', ts: hms(9, 1, 30), browser: 'Firefox' }),
    // One page, but they followed a link to it.
    view({ visitor: 'linker', path: '/books/b1/', ts: hms(10, 15, 0), referrer: 'example.org', device: 'mobile', browser: 'Safari' }),
    view({ visitor: 'campaign', path: '/', ts: hms(10, 20, 0), utm_source: 'newsletter', country: 'US' }),
    // One label, two visits: a one-page machine visit at ten, a person at noon.
    view({ visitor: 'twice', path: '/map/', ts: hms(10, 0, 0), country: 'CA' }),
    view({ visitor: 'twice', path: '/map/', ts: hms(12, 0, 0), country: 'CA' }),
    view({ visitor: 'twice', path: '/map/x/', ts: hms(12, 0, 40), country: 'CA' }),
    // A broken link somebody followed, and a scanner rattling at one.
    view({ visitor: 'broken', path: '/old-link/', status: 404, ts: hms(14, 0, 0), referrer: 'blog.example', country: 'US' }),
    view({ visitor: 'scanner', path: '/admin-x/', status: 404, ts: hms(14, 0, 5), country: 'RU' }),
    view({ visitor: 'phone', path: '/fun/', ts: hms(16, 0, 0), country: 'US', device: 'mobile', browser: 'Safari' }),
    view({ visitor: 'phone', path: '/fun/c1/', ts: hms(16, 0, 20), country: 'US', device: 'mobile', browser: 'Safari' }),
    // No country and no browser on record: the country is filed as unknown, the browser is left out.
    view({ visitor: 'blank', path: '/', ts: hms(17, 0, 0), country: null, browser: null }),
  ];
}

const hours = (spec) => Array.from({ length: 24 }, (_, h) => spec[h] || 0);

test('every count is stored twice: once for everything, once for the visits that look human', () => {
  const s = summariseDay(handDay(), D);
  const t = s.totals;
  // 21 pageviews by 12 labels in 13 visits; 6 of the visits, 10 of the views and
  // 6 of the labels look human. Nine visits read one page, three of them human.
  assert.deepEqual([t.views, t.viewsHuman, t.visitors, t.visitorsHuman], [21, 10, 12, 6]);
  assert.deepEqual([t.sessions, t.sessionsHuman, t.bounces, t.bouncesHuman], [13, 6, 9, 3]);
  // Visit time: the burst took 4, the reader 90, the noon visit 40, the phone 20.
  assert.deepEqual([t.seconds, t.secondsHuman], [154, 150]);
  assert.deepEqual(t.hours, hours({ 2: 2, 6: 5, 9: 3, 10: 3, 12: 2, 13: 1, 14: 2, 16: 2, 17: 1 }));
  assert.deepEqual(t.hoursHuman, hours({ 9: 3, 10: 2, 12: 2, 14: 1, 16: 2 }));

  // path: [views, views human, visitors, visitors human, entries, entries human, exits, exits human, not found, not found human]
  const PAGES = {
    '/': [3, 2, 3, 2, 3, 2, 2, 1, 0, 0],
    '/almanac/a/': [2, 0, 2, 0, 2, 0, 2, 0, 0, 0],
    '/almanac/b/': [1, 0, 1, 0, 1, 0, 1, 0, 0, 0],
    '/almanac/r1/': [1, 0, 1, 0, 1, 0, 0, 0, 0, 0],
    '/almanac/r2/': [1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    '/almanac/r3/': [1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    '/almanac/r4/': [1, 0, 1, 0, 0, 0, 0, 0, 0, 0],
    '/almanac/r5/': [1, 0, 1, 0, 0, 0, 1, 0, 0, 0],
    '/books/': [1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    '/books/b1/': [2, 2, 2, 2, 1, 1, 2, 2, 0, 0],
    // One label viewed it twice, in a machine visit and then a human one: one visitor, one human visitor.
    '/map/': [2, 1, 1, 1, 2, 1, 1, 0, 0, 0],
    '/map/x/': [1, 1, 1, 1, 0, 0, 1, 1, 0, 0],
    '/old-link/': [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    '/admin-x/': [1, 0, 1, 0, 1, 0, 1, 0, 1, 0],
    '/fun/': [1, 1, 1, 1, 1, 1, 0, 0, 0, 0],
    '/fun/c1/': [1, 1, 1, 1, 0, 0, 1, 1, 0, 0],
  };
  const got = Object.fromEntries(s.pages.map((p) => [p.path, [p.views, p.viewsHuman, p.visitors, p.visitorsHuman, p.entries, p.entriesHuman,
    p.exits, p.exitsHuman, p.notFound, p.notFoundHuman]]));
  assert.deepEqual(got, PAGES);

  // value: [views, views human, visitors, visitors human]
  const kind = (name) => Object.fromEntries(s.breakdown.filter((b) => b.kind === name).map((b) => [b.value, [b.views, b.viewsHuman, b.visitors, b.visitorsHuman]]));
  assert.deepEqual(kind('country'), {
    ES: [2, 0, 2, 0], IT: [1, 0, 1, 0], DE: [5, 0, 1, 0], GB: [4, 4, 2, 2], US: [4, 4, 3, 3], CA: [3, 2, 1, 1], RU: [1, 0, 1, 0], '??': [1, 0, 1, 0],
  });
  assert.deepEqual(kind('device'), { desktop: [18, 7, 10, 4], mobile: [3, 3, 2, 2] });
  assert.deepEqual(kind('browser'), { Chrome: [14, 4, 8, 3], Firefox: [3, 3, 1, 1], Safari: [3, 3, 2, 2] });
  assert.equal(s.filter, FILTER.version);
});

test('what the pages and the breakdowns add up to is what the day adds up to', () => {
  // The invariants that must hold on any day, on a day with every shape in it.
  const s = summariseDay(handDay(), D);
  const sum = (list, key) => list.reduce((n, x) => n + x[key], 0);
  const t = s.totals;
  for (const [all, human] of [['views', 'viewsHuman'], ['entries', 'entriesHuman'], ['exits', 'exitsHuman'], ['notFound', 'notFoundHuman']]) {
    assert.ok(sum(s.pages, human) <= sum(s.pages, all), `${human} is part of ${all}`);
  }
  assert.equal(sum(s.pages, 'views'), t.views);
  assert.equal(sum(s.pages, 'viewsHuman'), t.viewsHuman);
  assert.equal(sum(s.pages, 'entries'), t.sessions, 'every visit begins on exactly one page');
  assert.equal(sum(s.pages, 'exits'), t.sessions, 'and ends on exactly one');
  assert.equal(sum(s.pages, 'entriesHuman'), t.sessionsHuman);
  assert.equal(t.hours.reduce((a, b) => a + b, 0), t.views);
  assert.equal(t.hoursHuman.reduce((a, b) => a + b, 0), t.viewsHuman);
  assert.equal(sum(s.breakdown.filter((b) => b.kind === 'country'), 'views'), t.views, 'every view has a country, or is filed as unknown');
  assert.equal(sum(s.breakdown.filter((b) => b.kind === 'device'), 'views'), t.views);
  assert.equal(sum(s.breakdown.filter((b) => b.kind === 'browser'), 'views'), t.views - 1, 'but a row with no browser is left out, not filed as a browser called null');
  assert.ok(t.visitorsHuman <= t.visitors && t.sessionsHuman <= t.sessions && t.secondsHuman <= t.seconds && t.bouncesHuman <= t.bounces);
});

test('a day of nothing but crawlers keeps its numbers and has no people in it', async () => {
  const { sqlite, db } = freshDb();
  const rows = [];
  const countries = ['ES', 'IT', 'EC', 'BR', 'DE', 'FR', 'MX', 'PL', null];
  // 300 labels, one page each, no link, spread through the day with the batch
  // spikes at 06:00 and 13:00 that no human readership has; a handful of 404s
  // from scanners; and one visitor going a page a second.
  for (let i = 0; i < 300; i += 1) {
    const hour = i % 3 === 0 ? 6 : i % 3 === 1 ? 13 : i % 24;
    rows.push(view({ visitor: `bot-${i}`, path: `/almanac/e${i % 40}/`, ts: hms(hour, i % 60, i % 17), country: countries[i % countries.length], device: i % 5 ? 'desktop' : 'mobile' }));
  }
  for (let i = 0; i < 6; i += 1) rows.push(view({ visitor: `scan-${i}`, path: `/wp-x${i}/`, status: 404, ts: hms(3, 0, i) }));
  for (let i = 0; i < 40; i += 1) rows.push(view({ visitor: 'sweeper', path: `/almanac/s${i}/`, ts: hms(4, 0, i) }));
  load(sqlite, rows);

  const report = await runRollup(db, { now: at('2026-09-11T03:10:00Z') });
  assert.deepEqual(problemsOf(report), []);
  const totals = sqlite.prepare('SELECT * FROM daily_totals').get();
  assert.deepEqual([totals.views, totals.visitors, totals.sessions, totals.bounces], [346, 307, 307, 306]);
  assert.deepEqual([totals.views_human, totals.visitors_human, totals.sessions_human, totals.bounces_human, totals.seconds_human], [0, 0, 0, 0, 0]);
  assert.equal(JSON.stringify(JSON.parse(totals.hours_human)), JSON.stringify(hours({})), 'no hour of the day has a person in it');
  assert.ok(JSON.parse(totals.hours)[6] >= 100 && JSON.parse(totals.hours)[13] >= 100, 'the batch spikes are in the everything column');
  for (const table of ['daily_pages', 'daily_breakdown']) {
    assert.equal(count(sqlite, `SELECT COUNT(*) FROM ${table}`) > 0, true);
    for (const column of ['views_human', 'visitors_human']) assert.equal(count(sqlite, `SELECT SUM(${column}) FROM ${table}`), 0, `${table}.${column}`);
  }
  assert.equal(count(sqlite, 'SELECT SUM(entries_human) + SUM(exits_human) + SUM(not_found_human) FROM daily_pages'), 0);
  assert.equal(count(sqlite, 'SELECT SUM(views) FROM daily_pages'), 346, 'and the robots are still counted, in the first set');
});

// --- the arithmetic, against the dashboard and the sections page --------------------

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A day of random visitors of every shape, with ties, visits split at the gap, and rows whose ids are not in time order. */
function randomDay(seed, day, { notFound = true } = {}) {
  const rand = prng(seed);
  const int = (n) => Math.floor(rand() * n);
  const pick = (list) => list[int(list.length)];
  const start = startOfDay(day);
  const paths = Array.from({ length: 120 }, (_, i) => `/p${i}/`);
  const made = [];
  const add = (visitor, ts, extra = {}) => made.push({ visitor, ts, jitter: int(4), path: pick(paths), ...extra });
  const identity = () => ({
    country: pick(['GB', 'US', 'ES', 'IT', 'DE', null]), device: pick(['desktop', 'desktop', 'mobile', 'tablet', null]), browser: pick(['Chrome', 'Safari', 'Firefox', null]),
  });
  for (let v = 0; v < 260; v += 1) {
    const visitor = `r${seed}-${v}`;
    const who = identity();
    const link = () => (rand() < 0.5 ? { referrer: pick(['google.com', 'bing.com', 'example.org']) } : { utm_source: 'newsletter' });
    const begin = int(86400 - 5000);
    const shape = rand();
    if (shape < 0.62) add(visitor, start + begin, who);
    else if (shape < 0.68) add(visitor, start + begin, { ...who, ...link() });
    else if (shape < 0.80) {
      let ts = start + begin;
      for (let i = 0, n = 2 + int(7); i < n; i += 1, ts += 4 + int(120)) {
        add(visitor, ts, { ...who, ...(i === 0 && rand() < 0.4 ? link() : {}), ...(notFound && i === 1 && rand() < 0.2 ? { status: 404 } : {}) });
      }
    } else if (shape < 0.86) {
      let ts = start + begin;
      for (let i = 0, n = 3 + int(60); i < n; i += 1, ts += int(2)) add(visitor, ts, who);
    } else if (shape < 0.91) {
      let ts = start + begin;
      for (let i = 0, n = 2 + int(4); i < n; i += 1, ts += pick([0, 1, 2, 3])) add(visitor, ts, { ...who, ...(rand() < 0.3 ? link() : {}) });
    } else if (shape < 0.97) {
      // Two visits, the silence between them at, either side of, and beyond the session gap.
      let ts = start + begin;
      for (let i = 0, n = 1 + int(3); i < n; i += 1, ts += 5 + int(60)) add(visitor, ts, who);
      ts += pick([SESSION_GAP - 1, SESSION_GAP, SESSION_GAP + 1, SESSION_GAP + 600]);
      for (let i = 0, n = 1 + int(3); i < n; i += 1, ts += 5 + int(60)) add(visitor, ts, who);
    } else if (notFound) add(visitor, start + begin, { ...who, status: 404, ...(rand() < 0.5 ? link() : {}) });
  }
  // Ids are handed out as rows are written, which is not quite the order of their times.
  made.sort((a, b) => (a.ts + a.jitter) - (b.ts + b.jitter));
  return made.map(({ jitter, ...row }) => view(row)).filter((r) => r.ts < start + 86400);
}

// Transcribed from the first site's analytics_sections.js (visitsOf, arrivalOf, medianGap and the line in
// rollUp that keeps only status 200) as it stood on 2026-11-17, and deliberately not shared with
// src/rollup.js, so that the two can be compared. If that file's rule changes, change this and
// src/rollup.js together and bump FILTER.version. Only whether a visit arrived by a link matters
// here, so the search-host list is not carried over.
function sectionsPageVisits(reads) {
  const medianGap = (rows) => {
    if (rows.length < 2) return null;
    const gaps = rows.slice(1).map((r, i) => r.ts - rows[i].ts).sort((a, b) => a - b);
    return gaps[Math.floor(gaps.length / 2)];
  };
  const byVisitor = new Map();
  for (const row of reads) {
    if (!byVisitor.has(row.visitor)) byVisitor.set(row.visitor, []);
    byVisitor.get(row.visitor).push(row);
  }
  const visits = [];
  for (const list of byVisitor.values()) {
    list.sort((a, b) => a.ts - b.ts);
    let current = null;
    for (const row of list) {
      if (!current || row.ts - current.last > SESSION_GAP) {
        current = { rows: [row], start: row.ts, last: row.ts };
        visits.push(current);
      } else {
        current.rows.push(row);
        current.last = row.ts;
      }
    }
  }
  for (const visit of visits) {
    const first = visit.rows[0];
    const arrival = (first.utm_source || first.utm_medium || first.utm_campaign) ? 'campaign' : !first.referrer ? 'none' : 'site';
    const gap = medianGap(visit.rows);
    const tooFast = gap !== null && gap < 2;
    visit.lookedAround = !tooFast && (visit.rows.length > 1 || arrival !== 'none');
  }
  return visits;
}

test('on rows with no 404 a visit looks human exactly when the sections page says it looked around', () => {
  let visitsSeen = 0;
  let people = 0;
  for (let seed = 1; seed <= 25; seed += 1) {
    const rows = randomDay(seed, D, { notFound: false });
    const theirs = sectionsPageVisits(rows);
    const ours = visitsOf(rows);
    const key = (v) => `${v.rows[0].visitor}@${v.start}`;
    const flags = (list, field) => Object.fromEntries(list.map((v) => [key(v), v[field]]));
    assert.deepEqual(flags(ours, 'human'), flags(theirs, 'lookedAround'), `seed ${seed}`);
    const s = summariseDay(rows, D);
    const humanReads = theirs.filter((v) => v.lookedAround).reduce((n, v) => n + v.rows.length, 0);
    assert.equal(s.totals.sessionsHuman, theirs.filter((v) => v.lookedAround).length, `seed ${seed}: visits that looked around`);
    assert.equal(s.totals.viewsHuman, humanReads, `seed ${seed}: reads in them`);
    visitsSeen += ours.length;
    people += s.totals.sessionsHuman;
  }
  assert.ok(visitsSeen > 5000 && people > 500 && people < visitsSeen, `the random days cover both populations (${people} of ${visitsSeen})`);
});

/** The straightforward way to add a day up, with sets and no tricks: what summariseDay's answers are checked against. */
function reference(visits, day) {
  const start = startOfDay(day);
  const scope = (keep) => {
    const mine = visits.filter(keep);
    const rows = mine.flatMap((v) => v.rows);
    const distinct = (list) => new Set(list.map((r) => r.visitor)).size;
    const by = (list, keyOf) => {
      const groups = new Map();
      for (const item of list) {
        const key = keyOf(item);
        if (key === null || key === undefined) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(item);
      }
      return groups;
    };
    const pages = {};
    for (const [path, list] of by(rows, (r) => r.path)) pages[path] = { views: list.length, visitors: distinct(list), notFound: list.filter((r) => r.status === 404).length, entries: 0, exits: 0 };
    for (const v of mine) {
      pages[v.rows[0].path].entries += 1;
      pages[v.rows[v.rows.length - 1].path].exits += 1;
    }
    const kinds = {};
    for (const kind of KINDS) {
      kinds[kind] = Object.fromEntries([...by(rows, (r) => (kind === 'country' ? (r.country || '??') : (r[kind] || null)))]
        .map(([value, list]) => [value, { views: list.length, visitors: distinct(list) }]));
    }
    const hourly = new Array(24).fill(0);
    for (const r of rows) hourly[Math.floor((r.ts - start) / 3600)] += 1;
    return {
      totals: {
        views: rows.length, visitors: distinct(rows), sessions: mine.length, bounces: mine.filter((v) => v.rows.length === 1).length,
        seconds: mine.reduce((n, v) => n + v.last - v.start, 0),
      },
      pages, kinds, hours: hourly,
    };
  };
  return { all: scope(() => true), human: scope((v) => v.human) };
}

const fromSummary = (s, human) => {
  const w = human ? (name) => `${name}Human` : (name) => name;
  const t = s.totals;
  return {
    totals: { views: t[w('views')], visitors: t[w('visitors')], sessions: t[w('sessions')], bounces: t[w('bounces')], seconds: t[w('seconds')] },
    pages: Object.fromEntries(s.pages.filter((p) => p[w('views')] || p[w('entries')] || p[w('exits')]).map((p) => [p.path, {
      views: p[w('views')], visitors: p[w('visitors')], notFound: p[w('notFound')], entries: p[w('entries')], exits: p[w('exits')],
    }])),
    kinds: Object.fromEntries(KINDS.map((kind) => [kind, Object.fromEntries(s.breakdown.filter((b) => b.kind === kind && b[w('views')])
      .map((b) => [b.value, { views: b[w('views')], visitors: b[w('visitors')] }]))])),
    hours: t[w('hours')],
  };
};

test('on random days, with 404s, the summary equals the straightforward sum of the same visits, twice over', () => {
  for (let seed = 100; seed < 124; seed += 1) {
    const rows = randomDay(seed, D);
    const s = summariseDay(rows, D);
    const expected = reference(visitsOf(rows), D);
    assert.deepEqual(fromSummary(s, false), expected.all, `seed ${seed}: everything`);
    assert.deepEqual(fromSummary(s, true), expected.human, `seed ${seed}: human`);
  }
});

test('the everything columns are the full dashboard\'s own numbers for the same rows', () => {
  // So that a range crossing the day the raw rows run out does not step.
  for (let seed = 200; seed < 216; seed += 1) {
    const rows = randomDay(seed, D);
    const s = summariseDay(rows, D);
    const report = aggregate(rows, { from: T, to: T + 86400, tz: 0 });
    const dash = (list, field = 'views') => Object.fromEntries(list.map((e) => [e.key, e[field]]));
    assert.deepEqual(Object.fromEntries(s.pages.map((p) => [p.path, p.views])), dash(report.pages), `seed ${seed}: views by page`);
    assert.deepEqual(Object.fromEntries(s.pages.map((p) => [p.path, p.visitors])), dash(report.pages, 'visitors'), `seed ${seed}: visitors by page`);
    assert.deepEqual(Object.fromEntries(s.pages.filter((p) => p.notFound).map((p) => [p.path, p.notFound])), dash(report.notFound), `seed ${seed}: 404s`);
    assert.deepEqual(Object.fromEntries(s.pages.filter((p) => p.entries).map((p) => [p.path, p.entries])), dash(report.entries), `seed ${seed}: entries`);
    assert.deepEqual(Object.fromEntries(s.pages.filter((p) => p.exits).map((p) => [p.path, p.exits])), dash(report.exits), `seed ${seed}: exits`);
    const breakdown = (kind) => Object.fromEntries(s.breakdown.filter((b) => b.kind === kind).map((b) => [b.value, [b.views, b.visitors]]));
    const panel = (list) => Object.fromEntries(list.map((e) => [e.key, [e.views, e.visitors]]));
    assert.deepEqual(breakdown('country'), panel(report.countries), `seed ${seed}: countries`);
    assert.deepEqual(breakdown('device'), panel(report.devices), `seed ${seed}: devices`);
    assert.deepEqual(breakdown('browser'), panel(report.browsers), `seed ${seed}: browsers`);
    const sessions = sessionsOf(rows);
    assert.deepEqual(
      [s.totals.views, s.totals.visitors, s.totals.sessions, s.totals.bounces, s.totals.seconds],
      [rows.length, report.totals.visitors, sessions.length, sessions.filter((x) => x.pages === 1).length, sessions.reduce((n, x) => n + x.last - x.start, 0)],
      `seed ${seed}: the KPI row`,
    );
    assert.deepEqual(s.totals.hours, weekGrid(rows, 0)[new Date(T * 1000).getUTCDay()], `seed ${seed}: the heat map`);
  }
});

test('a row that is not on the day it is summarised for is a bug, and says so', () => {
  assert.throws(() => summariseDay([view({ ts: T + 86400 })], D), /not on 2026-09-10/);
  assert.throws(() => summariseDay([view({ ts: T - 1 })], D), /not on 2026-09-10/);
  assert.equal(summariseDay([], D).totals.views, 0);
});

// --- the run: idempotent, and never wrong about what it deletes ----------------------

const NOW = at('2026-09-11T03:10:00Z'); // the night after D

test('running it twice leaves the counts identical, not doubled', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  const first = await runRollup(db, { now: NOW });
  assert.deepEqual(first.summarised.map((d) => d.day), [D]);
  const before = dump(sqlite);
  assert.equal(before.daily_totals.length, 1);
  assert.equal(before.daily_pages.length, 16);

  const second = await runRollup(db, { now: NOW });
  assert.deepEqual(second.summarised, [], 'a day already summarised is left alone');
  assert.deepEqual(dump(sqlite), before, 'the second run changed nothing');
  for (let i = 0; i < 3; i += 1) await runRollup(db, { now: NOW + i * 3600 });
  assert.deepEqual(dump(sqlite), before, 'and neither did five');
  assert.equal(count(sqlite, 'SELECT SUM(views) FROM daily_pages'), 21, 'twenty-one views, not forty-two');
});

test('a cron that fires twice at once, or a manual run beside it, leaves the counts identical', async () => {
  const solo = freshDb();
  load(solo.sqlite, handDay());
  await runRollup(solo.db, { now: NOW });

  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  // Three runs in flight together: each reads the same state, each tries to write.
  const reports = await Promise.all([runRollup(db, { now: NOW }), runRollup(db, { now: NOW }), runRollup(db, { now: NOW })]);
  assert.deepEqual(dump(sqlite), dump(solo.sqlite), 'identical to one run');
  assert.deepEqual(reports.map((r) => problemsOf(r)), [[], [], []], 'and none of them calls losing the race a failure');
  assert.equal(reports.reduce((n, r) => n + r.summarised.length, 0), 1, 'exactly one of them wrote the day');
});

test('a second write of a finished day is refused whatever it carries, and changes nothing', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  await runRollup(db, { now: NOW });
  const before = dump(sqlite);

  const doubled = summariseDay([...handDay(), ...handDay().map((r) => ({ ...r, visitor: `${r.visitor}2` }))], D);
  assert.equal(await writeDay(db, doubled), false, 'a different answer for the same day');
  assert.equal(await writeDay(db, summariseDay([], D)), false, 'and an empty one, which is what a day whose rows are gone would give');
  assert.deepEqual(dump(sqlite), before);
});

test('stray rows from an earlier half-finished attempt are cleared, not added to', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  // What an older, non-atomic writer could have left: pages and a breakdown for a day with no totals row.
  sqlite.prepare("INSERT INTO daily_pages VALUES (?, '/stray/', 99, 99, 99, 99, 99, 99, 99, 99, 99, 99, 0)").run(D);
  sqlite.prepare("INSERT INTO daily_breakdown VALUES (?, 'country', 'ZZ', 99, 99, 99, 99, 0)").run(D);
  await runRollup(db, { now: NOW });
  const solo = freshDb();
  load(solo.sqlite, handDay());
  await runRollup(solo.db, { now: NOW });
  assert.deepEqual(dump(sqlite), dump(solo.sqlite), 'the day is exactly what it would have been');
});

test('a run that went stale between reading a day and writing it cannot overwrite what another run finished', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  const solo = freshDb();
  load(solo.sqlite, handDay());
  await runRollup(solo.db, { now: NOW });

  // Run B reads the day, then is held at the door of its write while run A
  // does everything, deletion included. B then writes from rows that are gone.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  const b = freshDbSharing(db);
  b.hook = async (sql) => {
    if (sql === 'BATCH' && !held) {
      held = true;
      await gate;
    }
  };
  const slow = runRollup(b, { now: NOW, retentionDays: 1 });
  await new Promise((resolve) => setImmediate(resolve));
  await runRollup(db, { now: NOW, retentionDays: 1 });
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 0, 'A deleted the day, being past a one-day limit');
  release();
  const report = await slow;
  assert.deepEqual(problemsOf(report), []);
  assert.deepEqual(dump(sqlite), dump(solo.sqlite), 'B wrote nothing');
});

// A second connection to the same database, with hooks of its own.
function freshDbSharing(db) {
  const copy = { ...db, hook: null };
  copy.prepare = (sql) => {
    const inner = db.prepare(sql);
    const wrap = (st) => ({
      sql: st.sql,
      args: st.args,
      bind: (...next) => wrap(st.bind(...next)),
      exec: () => st.exec(),
      async all() {
        copy.queries += 1;
        if (copy.hook) await copy.hook(st.sql, st.args);
        return st.exec();
      },
      async run() { return this.all(); },
    });
    return wrap(inner);
  };
  copy.batch = async (statements) => {
    copy.queries += 1;
    if (copy.hook) await copy.hook('BATCH', statements);
    return db.batch(statements);
  };
  return copy;
}

test('rows that vanish between counting a day and reading it make that day wait for a person, not get a short summary', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, [...handDay(), view({ visitor: 'next', ts: at('2026-09-11T09:00:00Z') })]);
  db.hook = async (sql) => {
    if (/^SELECT id, ts/.test(sql)) sqlite.exec('DELETE FROM pageviews WHERE id % 2 = 0');
  };
  const report = await runRollup(db, { now: at('2026-09-12T03:10:00Z') });
  assert.equal(report.error.day, D);
  assert.match(report.error.message, /a moment ago/);
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM daily_totals'), 0, 'nothing was written from the half that was left');
  assert.deepEqual(report.deferred, [D, '2026-09-11'], 'and the day after it waits too, so the days stay in order');
  assert.equal(report.deleted.rows, 0);
});

test('a database the migration has not reached fails the first night with a message that says what to do', async () => {
  const sqlite = new DatabaseSync(':memory:');
  for (const file of ['0001_analytics.sql', '0002_search_console.sql']) sqlite.exec(read(join('migrations', file)));
  await assert.rejects(() => runRollup(d1(sqlite), { now: NOW }), /Apply migrations 0001 to 0003.*daily_totals/s);
  const empty = new DatabaseSync(':memory:');
  await assert.rejects(() => runRollup(d1(empty), { now: NOW }), /ANALYTICS_DB binding.*pageviews/s);
});

test('a day with no pageviews gets no summary and does not hold up the next one', async () => {
  const { sqlite, db } = freshDb();
  const next = at('2026-09-12T10:00:00Z');
  load(sqlite, [view({ visitor: 'a', ts: hms(9, 0, 0), referrer: 'x.org' }), view({ visitor: 'b', ts: next })]);
  const report = await runRollup(db, { now: at('2026-09-13T03:10:00Z') });
  assert.deepEqual(report.summarised.map((d) => d.day), [D, '2026-09-12']);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM daily_totals WHERE day = '2026-09-11'"), 0, 'nothing happened on the 11th, and nothing is invented for it');
});

test('a day is settled an hour after it ends, and today is never summarised', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, [...handDay(), view({ visitor: 'today', ts: at('2026-09-11T00:30:00Z') })]);
  const early = await runRollup(db, { now: at('2026-09-11T00:59:59Z') });
  assert.deepEqual(early.summarised, [], 'not yet: a write begun before midnight may still be landing');
  assert.equal(early.settledThrough, '2026-09-09');
  const on = await runRollup(db, { now: at('2026-09-11T01:00:00Z') });
  assert.deepEqual(on.summarised.map((d) => d.day), [D]);
  assert.equal(on.settledThrough, '2026-09-10');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM daily_totals WHERE day = '2026-09-11'"), 0, 'the 11th is today and is not touched');
  assert.equal(SETTLE_SECONDS, 3600);
});

// Days of rows, a few apiece: for the retention boundary.
function days(from, to, perDay = 3) {
  const rows = [];
  for (let t = startOfDay(from); t <= startOfDay(to); t += 86400) {
    for (let i = 0; i < perDay; i += 1) rows.push(view({ visitor: `d${t}-${i}`, ts: t + Math.floor(((i + 1) * 86000) / (perDay + 1)), path: `/d${i % 5}/` }));
  }
  return rows;
}

async function settle(db, options, limit = 40) {
  const reports = [];
  for (let i = 0; i < limit; i += 1) {
    const report = await runRollup(db, options);
    reports.push(report);
    if (!report.deferred.length) return reports;
  }
  throw new Error('the backlog never cleared');
}

test('the deletion takes exactly the days past the limit, and neither of the days beside them', async () => {
  const { sqlite, db } = freshDb();
  const now = at('2026-11-17T03:10:00Z');
  // The last 90 days are 2026-08-20 to today, 2026-11-17. So the 19th goes and the 20th stays.
  const edge = [
    view({ visitor: 'e1', ts: at('2026-08-18T23:59:59Z') }), view({ visitor: 'e2', ts: at('2026-08-19T00:00:00Z') }),
    view({ visitor: 'e3', ts: at('2026-08-19T23:59:59Z') }), view({ visitor: 'e4', ts: at('2026-08-20T00:00:00Z') }),
    view({ visitor: 'e5', ts: at('2026-08-20T12:00:00Z') }), view({ visitor: 'e6', ts: at('2026-11-17T02:00:00Z') }),
  ];
  load(sqlite, [...days('2026-08-10', '2026-11-16'), ...edge]);
  const total = count(sqlite, 'SELECT COUNT(*) FROM pageviews');
  const before = windowsFor(now);
  assert.equal(new Date(before.keepFrom * 1000).toISOString(), '2026-08-20T00:00:00.000Z');

  const reports = await settle(db, { now });
  assert.ok(reports.length > 1, 'a hundred days is more than one run');
  for (const r of reports) assert.deepEqual(problemsOf(r), []);

  assert.equal(count(sqlite, 'SELECT MIN(ts) FROM pageviews'), at('2026-08-20T00:00:00Z'), 'the 20th, from its first second, is kept');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE ts < strftime('%s', '2026-08-20')"), 0, 'nothing older than that is');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE visitor IN ('e1', 'e2', 'e3')"), 0);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE visitor IN ('e4', 'e5', 'e6')"), 3);
  // Ten days went (the 10th to the 19th), each with its three rows and some of the edge rows.
  const gone = total - count(sqlite, 'SELECT COUNT(*) FROM pageviews');
  assert.equal(gone, 10 * 3 + 3, 'thirty rows from the ten days, and the three edge rows');
  assert.equal(reports.reduce((n, r) => n + r.deleted.rows, 0), gone);
  // Everything that went has a summary that says what it was; today has none.
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM daily_totals WHERE day >= '2026-08-10' AND day <= '2026-08-19'"), 10);
  assert.equal(count(sqlite, "SELECT SUM(views) FROM daily_totals WHERE day = '2026-08-19'"), 1 * 3 + 2, 'the 19th: its three rows and two edge rows');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM daily_totals WHERE day = '2026-11-17'"), 0);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM daily_totals WHERE day = '2026-11-16'"), 1, 'yesterday is summarised, and its rows are kept');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE ts >= strftime('%s', '2026-11-16') AND ts < strftime('%s', '2026-11-17')"), 3);
});

test('after the deletion the numbers are still there, and a run on a later night leaves them as they were', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-10', '2026-08-30'));
  const rowsPerDay = new Map(sqlite.prepare("SELECT date(ts, 'unixepoch') AS day, COUNT(*) AS n FROM pageviews GROUP BY day").all().map((r) => [r.day, Number(r.n)]));
  await settle(db, { now: at('2026-12-25T03:10:00Z') });
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 0, 'every one of those days is past the limit by now');
  const kept = dump(sqlite);
  assert.equal(kept.daily_totals.length, 21);
  for (const row of kept.daily_totals) assert.equal(row.views, rowsPerDay.get(row.day), `${row.day} still says how many views it had`);
  // With no rows left the days must not be summarised again, from nothing, over what was kept.
  for (const night of ['2026-12-26T03:10:00Z', '2027-03-01T03:10:00Z']) {
    const report = await runRollup(db, { now: at(night) });
    assert.deepEqual([report.summarised, report.deleted.rows, problemsOf(report)], [[], 0, []]);
  }
  assert.deepEqual(dump(sqlite), kept);
});

test('a day it could not summarise is not deleted, the failure is loud, and the next night puts it right', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-10', '2026-08-12'));
  const now = at('2026-11-17T03:10:00Z');
  // Fail the pages insert, which comes after the claim in the batch: the claim has gone in by then and must come out.
  db.failWhen = (sql, args) => sql.includes('INSERT INTO daily_pages') && args[0] === '2026-08-10';
  const bad = await runRollup(db, { now });
  assert.equal(bad.error.day, '2026-08-10');
  assert.equal(bad.deleted.rows, 0, 'nothing was deleted');
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 9, 'every row is still there');
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM daily_totals'), 0, 'and no half of a day was written either: the claim that went in first came out again');
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM daily_pages') + count(sqlite, 'SELECT COUNT(*) FROM daily_breakdown'), 0, 'the batch rolled back whole');
  assert.ok(problemsOf(bad).length, 'it is reported');

  db.failWhen = null;
  const good = await runRollup(db, { now });
  assert.deepEqual(problemsOf(good), []);
  assert.deepEqual(good.summarised.map((d) => d.day), ['2026-08-10', '2026-08-11', '2026-08-12']);
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 0);
});

test('a summary that does not count every row stops the deletion of that day, loudly', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-10', '2026-08-12'));
  // Somebody's summary of the 11th is a view short.
  sqlite.prepare(`INSERT INTO daily_totals VALUES ('2026-08-11', 2, 0, 2, 0, 2, 0, 2, 0, 0, 0, ?, ?, 1)`).run(JSON.stringify(hours({})), JSON.stringify(hours({})));
  const report = await runRollup(db, { now: at('2026-11-17T03:10:00Z') });
  assert.deepEqual(report.stuck, ['2026-08-11']);
  assert.match(problemsOf(report).join(' '), /2026-08-11/);
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE ts >= strftime('%s', '2026-08-11') AND ts < strftime('%s', '2026-08-12')"), 3, 'its rows are all still there');
  assert.equal(count(sqlite, "SELECT COUNT(*) FROM pageviews WHERE ts < strftime('%s', '2026-08-11') OR ts >= strftime('%s', '2026-08-12')"), 0, 'the days beside it went');
});

test('the DELETE itself refuses a day whose summary changed under the run, whatever the run believed', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-10', '2026-08-10'));
  // The run summarises the day and is about to delete it. In between, the summary is found a view short
  // (another process, a restore, a person). The run's own idea of the day is out of date by then; the
  // statement it sends must not rely on it.
  db.hook = async (sql, statements) => {
    if (sql === 'BATCH' && /^DELETE FROM pageviews/.test(statements[0].sql)) sqlite.exec('UPDATE daily_totals SET views = views - 1');
  };
  const report = await runRollup(db, { now: at('2026-11-17T03:10:00Z') });
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 3, 'nothing was deleted');
  assert.equal(report.deleted.rows, 0);
  db.hook = null;
  const next = await runRollup(db, { now: at('2026-11-17T03:10:00Z') });
  assert.deepEqual(next.stuck, ['2026-08-10'], 'and the next run says so out loud');
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 3);
});

test('history keeps the version of the rule it was written under', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, [...days('2026-08-10', '2026-08-11')]);
  // The 10th was summarised under an older rule, as it would be after the rule is tuned.
  const old = summariseDay(days('2026-08-10', '2026-08-10').map((r, i) => ({ ...r, id: 900 + i })), '2026-08-10');
  old.filter = 0;
  await writeDay(db, old);
  await runRollup(db, { now: at('2026-08-13T03:10:00Z') });
  const versions = (table, day) => sqlite.prepare(`SELECT DISTINCT filter_version AS v FROM ${table} WHERE day = ?`).all(day).map((r) => Number(r.v));
  for (const table of TABLES) {
    assert.deepEqual(versions(table, '2026-08-10'), [0], `${table}: the old day keeps its old version`);
    assert.deepEqual(versions(table, '2026-08-11'), [FILTER.version], `${table}: the new day carries the current one`);
  }
});

test('a backlog clears oldest first, a few days a night, within the Free plan\'s fifty queries a run', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-01', '2026-09-30', 20)); // 61 days
  const now = at('2026-10-01T03:10:00Z');
  const reports = [];
  const before = new Set();
  for (;;) {
    db.queries = 0;
    const report = await runRollup(db, { now });
    reports.push(report);
    assert.ok(db.queries <= 50, `a run used ${db.queries} queries`);
    assert.equal(db.queries, report.queries, 'and the report counts them as D1 does');
    assert.ok(report.summarised.length <= MAX_DAYS_PER_RUN);
    for (const d of report.summarised) {
      assert.equal(before.has(d.day), false, `${d.day} was summarised twice`);
      before.add(d.day);
    }
    if (!report.deferred.length) break;
    assert.ok(reports.length < 20);
  }
  assert.equal(reports.length, 7, 'sixty-one days at ten a run');
  const order = reports.flatMap((r) => r.summarised.map((d) => d.day));
  assert.deepEqual(order, [...order].sort(), 'oldest first, so nothing is deleted before it was summarised');
  assert.equal(order.length, 61);
});

test('a heavy day is read in pages and the run stops before it would run out of queries', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-01', '2026-08-30', 12));
  const report = await runRollup(db, { now: at('2026-10-01T03:10:00Z'), pageSize: 5, queryBudget: 20 });
  assert.ok(report.queries <= 20, `${report.queries} queries against a budget of 20`);
  assert.ok(report.summarised.length >= 1 && report.deferred.length > 0, 'it did some, and left the rest for the next night');
  const one = await loadDay(db, '2026-08-01', { pageSize: 5 });
  assert.equal(one.rows.length, 12);
  assert.equal(one.queries, 3, 'twelve rows in pages of five is two full pages and a short one');
  assert.equal(QUERY_BUDGET <= 50 && QUERY_BUDGET > 0, true, 'the default budget fits the Free plan');
});

// --- what must never reach a summary --------------------------------------------------

test('nothing that points at a reader is read, let alone written', async () => {
  const { sqlite, db } = freshDb();
  const rows = handDay().map((r) => ({ ...r, referrer_url: 'https://tracker.example/secret-path', city: 'Bristol', region: 'Somerset', lang: 'xx-secret', os: 'TempleOS' }));
  load(sqlite, rows);
  await runRollup(db, { now: NOW });
  const reads = db.log.filter((sql) => /FROM pageviews/i.test(sql) && /SELECT id/.test(sql)).join(' ');
  assert.ok(reads.length, 'the rows were read');
  for (const column of ['city', 'region', 'lang', 'os', 'referrer_url']) assert.equal(new RegExp(`\\b${column}\\b`).test(reads), false, `${column} is never selected`);
  const text = JSON.stringify(dump(sqlite));
  for (const secret of ['Bristol', 'Somerset', 'xx-secret', 'TempleOS', 'tracker.example', 'google.com', 'example.org', 'newsletter']) {
    assert.equal(text.includes(secret), false, `${secret} must not be in a summary`);
  }
  for (const visitor of new Set(rows.map((r) => r.visitor))) assert.equal(text.includes(`"${visitor}"`), false, `the label ${visitor} must not be in a summary`);
});

// --- the Worker ------------------------------------------------------------------------

async function capture(fn) {
  const lines = { log: [], error: [] };
  const original = { log: console.log, error: console.error };
  console.log = (line) => lines.log.push(line);
  console.error = (line) => lines.error.push(line);
  try {
    await fn();
    return { lines, error: null };
  } catch (error) {
    return { lines, error };
  } finally {
    console.log = original.log;
    console.error = original.error;
  }
}

test('the scheduled handler runs the rollup for the time it was scheduled, and logs one line', async () => {
  const { sqlite, db } = freshDb();
  load(sqlite, handDay());
  const { lines, error } = await capture(() => worker.scheduled({ scheduledTime: NOW * 1000, cron: '10 3 * * *' }, { ANALYTICS_DB: db }, {}));
  assert.equal(error, null);
  assert.equal(lines.error.length, 0);
  assert.equal(lines.log.length, 1);
  const line = JSON.parse(lines.log[0]);
  assert.equal(line.event, 'analytics-rollup');
  assert.equal(line.ok, true);
  assert.deepEqual(line.summarised, [{ day: D, views: 21, pages: 16 }]);
  assert.equal(line.today, '2026-09-11');
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM daily_totals'), 1);
  assert.equal(typeof worker.fetch, 'undefined', 'it answers no requests: only its schedule starts it');
});

test('the scheduled handler fails loudly: no database, a day it cannot do, a day it must not delete', async () => {
  const none = await capture(() => worker.scheduled({ scheduledTime: NOW * 1000 }, {}, {}));
  assert.match(String(none.error), /ANALYTICS_DB/);

  const { sqlite, db } = freshDb();
  load(sqlite, days('2026-08-10', '2026-08-11'));
  db.failWhen = (sql) => sql.includes('INSERT INTO daily_totals');
  const failed = await capture(() => worker.scheduled({ scheduledTime: at('2026-11-17T03:10:00Z') * 1000 }, { ANALYTICS_DB: db }, {}));
  assert.match(String(failed.error), /2026-08-10/);
  assert.equal(failed.lines.error.length, 1, 'logged as an error, so the dashboard shows it as one');
  assert.equal(JSON.parse(failed.lines.error[0]).ok, false);
  assert.equal(count(sqlite, 'SELECT COUNT(*) FROM pageviews'), 6);

  // A Worker run by hand without a scheduled time still runs, as of now. Rows from 2020 are
  // past the limit whatever day it is, so the test does not depend on the date.
  const old = freshDb();
  load(old.sqlite, days('2020-01-01', '2020-01-02'));
  const manual = await capture(() => worker.scheduled(undefined, { ANALYTICS_DB: old.db }, {}));
  assert.equal(manual.error, null);
  assert.equal(count(old.sqlite, 'SELECT COUNT(*) FROM pageviews'), 0);
  assert.equal(count(old.sqlite, 'SELECT COUNT(*) FROM daily_totals'), 2);
});

test('the wrangler template is a daily cron with no public address, the binding the code reads, and no site\'s ids', () => {
  const jsonc = read('worker/wrangler.jsonc').split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');
  const config = JSON.parse(jsonc);
  assert.ok(existsSync(join(ROOT, 'worker', config.main)), 'main points at a file');
  assert.equal(config.workers_dev, false, 'nothing on the internet can reach it');
  assert.equal(config.triggers.crons.length, 1);
  assert.match(config.triggers.crons[0], /^\d{1,2} \d{1,2} \* \* \*$/, 'once a day');
  assert.equal(config.d1_databases[0].binding, 'ANALYTICS_DB');
  assert.ok(existsSync(join(ROOT, 'worker', config.d1_databases[0].migrations_dir, '0003_daily_summaries.sql')), 'the migrations dir finds the migration');
  assert.match(config.d1_databases[0].database_id, /^</, 'a placeholder, never a real id');
  assert.match(config.d1_databases[0].database_name, /^</, 'and never a real name');
  assert.match(read('.gitignore'), /^worker\/wrangler\.local\.jsonc$/m, 'a site\'s own copy is not committed');
  assert.ok(config.observability.enabled);
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.stack ? error.stack.split('\n').slice(0, 4).join('\n     ') : error.message}`);
  }
}
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
