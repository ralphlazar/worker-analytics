// The Search Console module, with Google mocked and a D1 stand-in that keeps
// the three tables in memory. What matters: the JWT is one Google would
// accept (verified here with the matching public key), rows are upserted by
// day and paged the way the API pages them, the refresh throttles itself and
// backfills before it settles into the hourly rhythm, and nothing here can
// take the dashboard down: a missing secret, a missing table or a Google
// error all come back as text.
//
// Run: npm test

import assert from 'node:assert/strict';
import {
  createSearchConsole, parseCredentials, signJwt, fetchAccessToken, findProperty, fetchRows, upsertRows,
  monthRange, previousMonth, monthsAgo, ROW_LIMIT, REFRESH_SECONDS, RETRY_SECONDS, MONTHS_PER_RUN, BACKFILL_MONTHS,
} from '../src/search-console.js';
import { createAnalyticsHandler } from '../src/routes.js';
import dashboardHtml from '../src/dashboard.js';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0) / 1000; // 2026-09-05 12:00 UTC

// --- a service account, minted here -----------------------------------------------

const pair = await crypto.subtle.generateKey(
  { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'],
);
const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey)).toString('base64');
const PEM = `-----BEGIN PRIVATE KEY-----\n${der.match(/.{1,64}/g).join('\n')}\n-----END PRIVATE KEY-----\n`;
const CREDS = { type: 'service_account', client_email: 'analytics@project.iam.gserviceaccount.com', private_key: PEM };
const SECRET = JSON.stringify(CREDS);

const fromB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** Google, as far as this module can tell. `rows[dimension](body)` supplies the query rows. */
function google({ sites = ['sc-domain:example.com'], rows = {}, fail = null } = {}) {
  const log = [];
  const fetch = async (url, init = {}) => {
    log.push({ url, init });
    if (fail && url !== TOKEN_URL) return Response.json({ error: { message: fail } }, { status: 500 });
    if (url === TOKEN_URL) {
      const params = new URLSearchParams(init.body);
      const [h, c, s] = params.get('assertion').split('.');
      const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', pair.publicKey, fromB64url(s), new TextEncoder().encode(`${h}.${c}`));
      log[log.length - 1].jwt = { ok, header: JSON.parse(fromB64url(h)), claims: JSON.parse(fromB64url(c)), grant: params.get('grant_type') };
      return Response.json({ access_token: 'tok-1', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url === SITES_URL) return Response.json({ siteEntry: sites.map((siteUrl) => ({ siteUrl, permissionLevel: 'siteFullUser' })) });
    if (url.includes('/searchAnalytics/query')) {
      const body = JSON.parse(init.body);
      const all = (rows[body.dimensions[1]] || (() => []))(body);
      return Response.json({ rows: all.slice(body.startRow, body.startRow + body.rowLimit) });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetch, log };
}

/** D1 with the three search tables in memory. */
function fakeSearchDb({ failing = false, missing = false } = {}) {
  const sync = new Map();
  const tables = { search_queries: new Map(), search_pages: new Map() };
  const calls = [];
  const exec = (sql, args) => {
    calls.push({ sql, args });
    if (failing) throw new Error('D1 down');
    if (missing) throw new Error('D1_ERROR: no such table: search_sync');
    if (sql.startsWith('INSERT INTO search_sync')) { sync.set(args[0], args[1]); return { results: [] }; }
    if (sql.startsWith('SELECT key, value FROM search_sync')) return { results: [...sync].map(([key, value]) => ({ key, value })) };
    const ins = sql.match(/INSERT INTO (search_\w+) \(day, (\w+)/);
    if (ins) {
      for (let i = 0; i < args.length; i += 5) {
        tables[ins[1]].set(`${args[i]}|${args[i + 1]}`, { day: args[i], key: args[i + 1], clicks: args[i + 2], impressions: args[i + 3], position: args[i + 4] });
      }
      return { results: [] };
    }
    const sel = sql.match(/FROM (search_\w+) WHERE day >= \? AND day <= \?/);
    if (sel) {
      const [fromDay, toDay] = args;
      const rows = [...tables[sel[1]].values()].filter((r) => r.day >= fromDay && r.day <= toDay);
      if (!sql.includes('GROUP BY')) {
        return { results: [{ clicks: rows.reduce((s, r) => s + r.clicks, 0), impressions: rows.reduce((s, r) => s + r.impressions, 0) }] };
      }
      const byKey = new Map();
      for (const r of rows) {
        const e = byKey.get(r.key) || { key: r.key, clicks: 0, impressions: 0, weighted: 0 };
        e.clicks += r.clicks; e.impressions += r.impressions; e.weighted += (r.position || 0) * r.impressions;
        byKey.set(r.key, e);
      }
      const out = [...byKey.values()].map((e) => ({ key: e.key, clicks: e.clicks, impressions: e.impressions, position: e.impressions ? e.weighted / e.impressions : null }));
      out.sort((a, b) => b.clicks - a.clicks || b.impressions - a.impressions || a.key.localeCompare(b.key));
      return { results: out.slice(0, args[2]) };
    }
    return { results: [] };
  };
  return {
    calls, sync, tables,
    prepare(sql) {
      return { bind(...args) { return { run: async () => exec(sql, args), all: async () => exec(sql, args) }; } };
    },
    async batch(statements) { const out = []; for (const s of statements) out.push(await s.run()); return out; },
  };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('signs a JWT Google would accept and exchanges it for a token', async () => {
  const g = google();
  const token = await fetchAccessToken(parseCredentials(SECRET, 'GSC'), g.fetch, NOW);
  assert.equal(token, 'tok-1');
  const { jwt, init } = g.log[0];
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(jwt.grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  assert.equal(jwt.ok, true, 'the signature must verify under the account public key');
  assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT' });
  assert.equal(jwt.claims.iss, CREDS.client_email);
  assert.equal(jwt.claims.scope, 'https://www.googleapis.com/auth/webmasters.readonly');
  assert.equal(jwt.claims.aud, TOKEN_URL);
  assert.equal(jwt.claims.exp - jwt.claims.iat, 3600);
  assert.equal(jwt.claims.iat, NOW);
  assert.throws(() => parseCredentials('', 'GSC'), /GSC is not set/);
  assert.throws(() => parseCredentials('{not json', 'GSC'), /not valid JSON/);
  assert.throws(() => parseCredentials('{"client_email":"x"}', 'GSC'), /private_key/);
  const same = await signJwt(CREDS, NOW);
  assert.equal(same.split('.').length, 3);
});

test('finds the property, preferring the domain property, and says so when there is none', async () => {
  const both = google({ sites: ['https://example.com/', 'sc-domain:example.com', 'https://other.example/'] });
  assert.equal(await findProperty('tok', 'www.example.com', both.fetch), 'sc-domain:example.com');
  assert.equal(both.log[0].init.headers.authorization, 'Bearer tok');
  const prefix = google({ sites: ['https://example.com/'] });
  assert.equal(await findProperty('tok', 'example.com', prefix.fetch), 'https://example.com/');
  const configured = google({ sites: ['https://example.com/', 'sc-domain:example.com'] });
  assert.equal(await findProperty('tok', 'example.com', configured.fetch, 'https://example.com/'), 'https://example.com/', 'a configured property wins when it is shared');
  const none = google({ sites: ['https://other.example/'] });
  await assert.rejects(() => findProperty('tok', 'example.com', none.fetch), /No Search Console property for example\.com is shared.*other\.example/);
});

test('pages through rows the way Google pages them, and upserts them by day', async () => {
  const many = Array.from({ length: ROW_LIMIT + 3 }, (_, i) => ({ keys: ['2026-09-01', `query ${i}`], clicks: 1, impressions: 2, position: 3.5 }));
  const g = google({ rows: { query: () => many } });
  const rows = await fetchRows('tok', 'sc-domain:example.com', 'query', '2026-09-01', '2026-09-30', g.fetch);
  assert.equal(rows.length, ROW_LIMIT + 3);
  assert.equal(g.log.length, 2, 'a full page means one more request');
  const bodies = g.log.map((l) => JSON.parse(l.init.body));
  assert.deepEqual(bodies.map((b) => b.startRow), [0, ROW_LIMIT]);
  assert.deepEqual(bodies[0].dimensions, ['date', 'query']);
  assert.equal(bodies[0].dataState, 'final');
  assert.equal(bodies[0].rowLimit, ROW_LIMIT);
  assert.match(g.log[0].url, /sites\/sc-domain%3Aexample\.com\/searchAnalytics\/query$/);
  assert.deepEqual(rows[0], { day: '2026-09-01', key: 'query 0', clicks: 1, impressions: 2, position: 3.5 });

  const db = fakeSearchDb();
  const n = await upsertRows(db, 'query', [
    { day: '2026-09-01', key: 'dash', clicks: 5, impressions: 50, position: 2 },
    { day: '2026-09-01', key: 'dash', clicks: 5, impressions: 50, position: 2 }, // a repeat must not break the statement
    { day: '2026-09-02', key: 'dash', clicks: 1, impressions: 10, position: 4 },
  ]);
  assert.equal(n, 2);
  assert.match(db.calls[0].sql, /INSERT INTO search_queries \(day, query, clicks, impressions, position\)/);
  assert.match(db.calls[0].sql, /ON CONFLICT \(day, query\) DO UPDATE SET clicks = excluded\.clicks/);
  assert.equal(db.tables.search_queries.get('2026-09-01|dash').clicks, 5);
  await upsertRows(db, 'query', [{ day: '2026-09-01', key: 'dash', clicks: 7, impressions: 70, position: 1.5 }]);
  assert.equal(db.tables.search_queries.get('2026-09-01|dash').clicks, 7, 'a revised day replaces itself');
  assert.equal(db.tables.search_queries.size, 2, 'and is not duplicated');
  const big = Array.from({ length: 1234 }, (_, i) => ({ day: '2026-09-03', key: `q${i}`, clicks: 0, impressions: 1, position: null }));
  const before = db.calls.length;
  await upsertRows(db, 'page', big.map((r) => ({ ...r, key: `https://example.com/${r.key}/` })));
  assert.equal(db.calls.length - before, Math.ceil(1234 / 20), 'twenty rows a statement, so no statement binds more than a hundred values');
  assert.equal(db.tables.search_pages.size, 1234);
});

test('month arithmetic, in UTC, clipped to today', () => {
  assert.deepEqual(monthRange('2026-09', '2026-09-05'), ['2026-09-01', '2026-09-05']);
  assert.deepEqual(monthRange('2026-02', '2026-09-05'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(monthRange('2024-02', '2026-09-05'), ['2024-02-01', '2024-02-29']);
  assert.equal(previousMonth('2026-01'), '2025-12');
  assert.equal(monthsAgo('2026-09-05', BACKFILL_MONTHS), '2025-05');
});

test('the first refresh backfills sixteen months newest first, then settles into once an hour', async () => {
  const seen = [];
  const g = google({ rows: {
    query: (b) => { seen.push(['query', b.startDate, b.endDate]); return [{ keys: [b.startDate, 'dash candoo'], clicks: 3, impressions: 30, position: 1.2 }]; },
    page: (b) => [{ keys: [b.startDate, 'https://example.com/'], clicks: 4, impressions: 40, position: 1.1 }],
  } });
  const sc = createSearchConsole({ secret: 'GSC', site: 'example.com' }, { fetch: g.fetch });
  const db = fakeSearchDb();
  const env = { ANALYTICS_DB: db, GSC: SECRET };

  const first = await sc.refresh(env, { now: NOW });
  assert.equal(first.months.length, MONTHS_PER_RUN);
  assert.equal(first.months[0], '2026-09');
  assert.equal(first.months[MONTHS_PER_RUN - 1], '2026-04');
  assert.deepEqual(seen[0], ['query', '2026-09-01', '2026-09-05'], 'the current month stops at today');
  assert.deepEqual(seen[1], ['query', '2026-08-01', '2026-08-31']);
  assert.equal(db.sync.get('property'), 'sc-domain:example.com');
  assert.equal(db.sync.get('backfill_next'), '2026-03');
  assert.equal(db.sync.get('backfill_until'), '2025-05');
  assert.equal(db.sync.get('lock'), null, 'the lock is released');
  assert.equal(db.sync.get('last_error'), null);
  const tokenCalls = () => g.log.filter((l) => l.url === TOKEN_URL).length;
  const sitesCalls = () => g.log.filter((l) => l.url === SITES_URL).length;
  assert.equal(sitesCalls(), 1);

  // A backfill in progress continues on the very next call, without waiting an hour.
  const second = await sc.refresh(env, { now: NOW + 5 });
  assert.equal(second.months.length, MONTHS_PER_RUN);
  assert.equal(second.months[0], '2026-03');
  assert.equal(sitesCalls(), 1, 'the property is remembered, not looked up again');
  const third = await sc.refresh(env, { now: NOW + 10 });
  assert.equal(third.months.length, BACKFILL_MONTHS + 1 - 2 * MONTHS_PER_RUN, 'the rest, seventeen calendar months in all');
  assert.equal(third.months[third.months.length - 1], '2025-05');
  assert.equal(db.sync.get('backfill_next'), null);
  assert.equal(db.sync.get('backfill_done'), '1');
  assert.equal(db.tables.search_queries.size, BACKFILL_MONTHS + 1);

  // Now the hourly rhythm: nothing within the hour, the last seven days after it.
  const tokensBefore = tokenCalls();
  assert.deepEqual(await sc.refresh(env, { now: NOW + 20 }), { skipped: 'fresh' });
  assert.equal(tokenCalls(), tokensBefore, 'no request to Google inside the hour');
  const later = await sc.refresh(env, { now: NOW + 10 + REFRESH_SECONDS });
  assert.equal(later.days, 7);
  assert.deepEqual(later.months, []);
  assert.deepEqual(seen[seen.length - 1], ['query', '2026-08-29', '2026-09-05']);
  assert.equal(db.sync.get('last_refresh'), String(NOW + 10 + REFRESH_SECONDS));

  // A running refresh is not started twice, but a lock left by a dead run
  // expires, so a crash can never wedge the module.
  const t = NOW + 10 + 2 * REFRESH_SECONDS;
  db.sync.set('lock', String(t - 10));
  assert.deepEqual(await sc.refresh(env, { now: t }), { skipped: 'a refresh is running' });
  db.sync.set('lock', String(t - 3600));
  assert.equal((await sc.refresh(env, { now: t })).days, 7, 'a stale lock is ignored');
});

test('a Google error is written down, retried later, and never thrown', async () => {
  const g = google({ fail: 'quota exceeded' });
  const sc = createSearchConsole({ secret: 'GSC' }, { fetch: g.fetch });
  const db = fakeSearchDb();
  const env = { ANALYTICS_DB: db, GSC: SECRET };
  const quiet = console.error;
  console.error = () => {};
  try {
    const out = await sc.refresh(env, { now: NOW, host: 'example.com' });
    assert.match(out.error, /Google sites list failed: 500 quota exceeded/);
    assert.match(db.sync.get('last_error'), /quota exceeded/);
    assert.equal(db.sync.get('lock'), null);
    assert.deepEqual(await sc.refresh(env, { now: NOW + 60 }), { skipped: 'failed recently' });
    const retried = await sc.refresh(env, { now: NOW + RETRY_SECONDS });
    assert.ok(retried.error, 'after the retry interval Google is asked again');
    // Without the secret, or without the tables, nothing is attempted and nothing throws.
    assert.deepEqual(await sc.refresh({ ANALYTICS_DB: db }, { now: NOW }), { skipped: 'not connected' });
    assert.ok((await sc.refresh({ ANALYTICS_DB: fakeSearchDb({ missing: true }), GSC: SECRET }, { now: NOW })).error);
    // maybeRefresh needs somewhere to run.
    assert.equal(sc.maybeRefresh(env, null), false);
    const waited = [];
    assert.equal(sc.maybeRefresh(env, { waitUntil: (p) => waited.push(p) }, { now: NOW + 2 * RETRY_SECONDS }), true);
    await Promise.all(waited);
  } finally {
    console.error = quiet;
  }
});

test('the report aggregates the range and survives a missing secret, a missing table and a dead database', async () => {
  const sc = createSearchConsole({ secret: 'GSC' });
  const db = fakeSearchDb();
  await upsertRows(db, 'query', [
    { day: '2026-09-01', key: 'dash candoo', clicks: 5, impressions: 100, position: 2 },
    { day: '2026-09-02', key: 'dash candoo', clicks: 5, impressions: 100, position: 4 },
    { day: '2026-09-02', key: 'total mayhem books', clicks: 7, impressions: 10, position: 1 },
    { day: '2026-08-01', key: 'old', clicks: 99, impressions: 99, position: 1 },
  ]);
  await upsertRows(db, 'page', [
    { day: '2026-09-01', key: 'https://example.com/', clicks: 20, impressions: 300, position: 1.5 },
    { day: '2026-09-02', key: 'https://example.com/books/', clicks: 1, impressions: 5, position: 9 },
  ]);
  await db.batch([db.prepare('INSERT INTO search_sync (key, value) VALUES (?, ?)').bind('last_refresh', String(NOW)), db.prepare('INSERT INTO search_sync (key, value) VALUES (?, ?)').bind('property', 'sc-domain:example.com')]);
  const from = Date.UTC(2026, 8, 1) / 1000, to = Date.UTC(2026, 8, 3) / 1000;
  const r = await sc.report({ ANALYTICS_DB: db, GSC: SECRET }, { from, to });
  assert.equal(r.status, 'ok');
  assert.deepEqual(r.queries.map((q) => [q.key, q.clicks, q.impressions, q.position]), [['dash candoo', 10, 200, 3], ['total mayhem books', 7, 10, 1]]);
  assert.deepEqual(r.pages.map((p) => p.key), ['https://example.com/', 'https://example.com/books/']);
  assert.deepEqual(r.totals, { clicks: 21, impressions: 305 }, 'totals come from the page rows, which include the withheld queries');
  assert.equal(r.lastRefresh, NOW);
  assert.equal(r.property, 'sc-domain:example.com');

  const notConnected = await sc.report({ ANALYTICS_DB: db }, { from, to });
  assert.equal(notConnected.status, 'not-connected');
  assert.match(notConnected.message, /GSC is not set/);
  assert.equal(notConnected.queries.length, 2, 'stored rows still show');

  const missing = await sc.report({ ANALYTICS_DB: fakeSearchDb({ missing: true }), GSC: SECRET }, { from, to });
  assert.equal(missing.status, 'error');
  assert.match(missing.message, /no such table/);
  assert.deepEqual(missing.queries, []);

  const dead = await sc.report({ ANALYTICS_DB: fakeSearchDb({ failing: true }), GSC: SECRET }, { from, to });
  assert.equal(dead.status, 'error');
  assert.equal((await sc.report({ GSC: SECRET }, { from, to })).status, 'error');

  db.sync.set('last_error', 'Google token request failed: 401');
  const failed = await sc.report({ ANALYTICS_DB: db, GSC: SECRET }, { from, to });
  assert.equal(failed.status, 'error');
  assert.match(failed.message, /401/);
  assert.equal(failed.queries.length, 2, 'the rows already pulled are still shown under the error');
});

test('the dashboard API carries the search report and schedules the refresh, and the rest is untouched by it', async () => {
  const PASSWORD = 'correct-horse-battery-staple';
  const g = google({ rows: { query: () => [], page: () => [] } });
  const handler = createAnalyticsHandler({ siteName: 'example.com', searchConsole: { secret: 'GSC' }, dashboard: '<html>D</html>', fetch: g.fetch });
  // A pageviews database that knows nothing about search tables: the report must still come back whole.
  const pageviewsDb = {
    prepare(sql) { return { bind() { return { async all() { if (/search_/.test(sql)) throw new Error('no such table'); return { results: [] }; }, async run() { return {}; } }; } }; },
    async batch() { return []; },
  };
  const login = await handler(new Request('https://example.com/analytics/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.77' },
    body: new URLSearchParams({ password: PASSWORD }),
  }), { ANALYTICS_PASSWORD: PASSWORD, ANALYTICS_DB: pageviewsDb });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const quiet = console.error; // the missing search tables are logged, on purpose; not needed in the test output
  console.error = () => {};
  const res = await handler(new Request(`https://example.com/analytics/api?from=${NOW - 86400}&to=${NOW}`, { headers: { cookie } }),
    { ANALYTICS_PASSWORD: PASSWORD, ANALYTICS_DB: pageviewsDb, GSC: SECRET }, ctx).finally(() => { console.error = quiet; });
  assert.equal(res.status, 200);
  const report = await res.json();
  assert.equal(report.totals.pageviews, 0, 'the traffic report is intact');
  assert.equal(report.search.status, 'error');
  assert.match(report.search.message, /no such table/);
  assert.equal(waited.length, 1, 'the refresh was handed to waitUntil');
  await Promise.all(waited);

  const unset = await handler(new Request(`https://example.com/analytics/api?from=${NOW - 86400}&to=${NOW}`, { headers: { cookie } }),
    { ANALYTICS_PASSWORD: PASSWORD, ANALYTICS_DB: fakeSearchDb() }, ctx);
  assert.equal((await unset.json()).search.status, 'not-connected');

  const plain = createAnalyticsHandler({ siteName: 'example.com', dashboard: '<html>D</html>' });
  const without = await plain(new Request(`https://example.com/analytics/api?from=${NOW - 86400}&to=${NOW}`, { headers: { cookie } }),
    { ANALYTICS_PASSWORD: PASSWORD, ANALYTICS_DB: fakeSearchDb() }, ctx);
  assert.equal(Object.hasOwn(await without.json(), 'search'), false, 'a site without the option gets no search key at all');

  assert.ok(dashboardHtml.includes('Google searches'));
  assert.ok(dashboardHtml.includes('Search landing pages'));
  assert.ok(dashboardHtml.includes('From Google Search Console. Final figures arrive two to three days late and rare searches are withheld.'));
  assert.ok(dashboardHtml.includes('Not connected'));
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.stack || error.message}`);
  }
}
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
