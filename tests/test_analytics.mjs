// The traffic analytics, checked by tripping its guards rather than assuming.
//
// Three things matter most. Collection must never write an address (only the
// daily hash), must leave images, API calls and crawlers out of the visitor
// count, and must fail silently rather than take the page down. The report
// arithmetic (sessions, bounces, buckets in the viewer's time zone) has to be
// right on hand-built rows. And the dashboard must fail CLOSED with no
// password set, and refuse a wrong one.
//
// Run: npm test (which first checks the generated dashboard module is current)

import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isBot, botName, isProbe, isFakeBrowser, deviceOf, browserOf, osOf, languageOf, referrerOf, shouldRecord,
  visitorHash, describe, writePageview, recordPageview, recordEvent,
} from '../src/collect.js';
import { sessionsOf, totalsOf, series, weekGrid, aggregate, buildReport, buildCsv, bucketFor } from '../src/report.js';
import { createAnalyticsHandler, parseRange, renderDashboard } from '../src/routes.js';
import { resolveOptions } from '../src/config.js';
import { createAnalytics } from '../src/analytics.js';
import dashboardHtml from '../src/dashboard.js';

const CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const IPAD = 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36';
const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:129.0) Gecko/20100101 Firefox/129.0';
const OLD_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:89.0) Gecko/20100101 Firefox/89.0';
const OLD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Safari/605.1.15';
const OLD_IPAD = 'Mozilla/5.0 (iPad; CPU OS 15_8 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1';
// What a real browser sends on a page navigation, beside its user agent.
const NAVIGATION = { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };

const page = (path, over = {}) => new Request(`https://example.com${path}`, {
  method: over.method || 'GET',
  headers: {
    'user-agent': CHROME, 'cf-connecting-ip': '203.0.113.7', 'accept-language': 'en-GB,en;q=0.9',
    ...NAVIGATION,
    ...(over.headers || {}),
  },
});
const htmlResponse = (status = 200) => new Response('<html>', { status, headers: { 'content-type': 'text/html; charset=utf-8' } });

/** A D1 stand-in that records what it was asked and answers from canned rows. */
function fakeDb(rows = [], { failing = false } = {}) {
  const calls = [];
  const db = {
    calls,
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async run() {
              calls.push({ sql, args });
              if (failing) throw new Error('D1 down');
              return { success: true };
            },
            async all() {
              calls.push({ sql, args });
              if (failing) throw new Error('D1 down');
              if (sql.includes('FROM pageviews') && sql.includes('id >')) {
                const [from, to, cursor, limit] = args;
                return { results: rows.filter((r) => r.ts >= from && r.ts < to && r.id > cursor).slice(0, limit) };
              }
              if (sql.includes('FROM pageviews')) return { results: rows }; // the live query
              if (sql.includes('FROM bot_hits')) return { results: [{ name: 'googlebot', hits: 12 }] };
              if (sql.includes('FROM events')) return { results: [{ ts: args[1] - 10, type: 'enquiry', detail: '[5] Reconstitution', path: '/contact/' }] };
              return { results: [] };
            },
          };
        },
      };
    },
  };
  return db;
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

// --- collection -----------------------------------------------------------

test('recognises crawlers and names them', () => {
  assert.equal(isBot(GOOGLEBOT), true);
  assert.equal(botName(GOOGLEBOT), 'googlebot');
  assert.equal(isBot('curl/8.4.0'), true);
  assert.equal(botName('curl/8.4.0'), 'curl');
  assert.equal(isBot(''), true, 'no user agent at all is not a person');
  assert.equal(isBot(CHROME), false);
  assert.equal(isBot(IPHONE), false);
  assert.equal(botName(CHROME, 'Search Engine Crawler'), 'search engine crawler');
});

test('reads device, browser and system off the user agent', () => {
  assert.deepEqual([deviceOf(CHROME), browserOf(CHROME), osOf(CHROME)], ['desktop', 'Chrome', 'macOS']);
  assert.deepEqual([deviceOf(IPHONE), browserOf(IPHONE), osOf(IPHONE)], ['mobile', 'Safari', 'iOS']);
  assert.deepEqual([deviceOf(IPAD), browserOf(IPAD), osOf(IPAD)], ['tablet', 'Safari', 'iOS']);
  assert.deepEqual([deviceOf(ANDROID), browserOf(ANDROID), osOf(ANDROID)], ['mobile', 'Chrome', 'Android']);
  assert.deepEqual([deviceOf(EDGE), browserOf(EDGE), osOf(EDGE)], ['desktop', 'Edge', 'Windows']);
  assert.equal(languageOf('fr-CH, fr;q=0.9, en;q=0.8'), 'fr-ch');
  assert.equal(languageOf(''), null);
});

test('keeps external referrers and drops its own', () => {
  assert.deepEqual(referrerOf('https://www.example.com/browse/', 'example.com'), { referrer: null, referrerUrl: null });
  assert.deepEqual(referrerOf('https://www.instagram.com/p/abc/?igsh=xyz', 'example.com'),
    { referrer: 'instagram.com', referrerUrl: 'https://www.instagram.com/p/abc/' });
  assert.deepEqual(referrerOf('not a url', 'example.com'), { referrer: null, referrerUrl: null });
  assert.deepEqual(referrerOf(null, 'example.com'), { referrer: null, referrerUrl: null });
});

test('records pages and 404s, not images, APIs, redirects, prefetches or the dashboard', () => {
  const SKIP = ['/images/', '/api/', '/analytics'];
  const record = (request, response) => shouldRecord(request, response, SKIP);
  assert.equal(record(page('/work/reconstitution/'), htmlResponse()), true);
  assert.equal(record(page('/nope/'), htmlResponse(404)), true, 'a broken link is worth seeing');
  assert.equal(record(page('/images/display/abc.jpg'), new Response('', { headers: { 'content-type': 'image/jpeg' } })), false);
  assert.equal(record(page('/api/contact', { method: 'POST' }), htmlResponse()), false);
  assert.equal(record(page('/analytics/'), htmlResponse()), false, 'looking at the dashboard is not a visit');
  assert.equal(record(page('/crazytown/x/'), new Response(null, { status: 301, headers: { 'content-type': 'text/html' } })), false);
  assert.equal(record(page('/titles.json'), new Response('[]', { headers: { 'content-type': 'application/json' } })), false);
  assert.equal(record(page('/about/', { headers: { 'sec-purpose': 'prefetch' } }), htmlResponse()), false);
  assert.equal(record(page('/about/', { headers: { 'sec-fetch-dest': 'empty' } }), htmlResponse()), false);
  assert.equal(record(page('/about/', { headers: { 'sec-fetch-dest': 'document' } }), htmlResponse()), true);
});

test('hashes a visitor per day and never keeps the address', async () => {
  const a = await visitorHash('secret', '2026-09-04', '203.0.113.7', CHROME);
  const same = await visitorHash('secret', '2026-09-04', '203.0.113.7', CHROME);
  const nextDay = await visitorHash('secret', '2026-09-05', '203.0.113.7', CHROME);
  const other = await visitorHash('secret', '2026-09-04', '203.0.113.8', CHROME);
  assert.equal(a, same);
  assert.notEqual(a, nextDay, 'the same person is a new visitor tomorrow');
  assert.notEqual(a, other);
  assert.match(a, /^[0-9a-f]{16}$/);
  assert.notEqual(await visitorHash('other-secret', '2026-09-04', '203.0.113.7', CHROME), a, 'the hash depends on the secret');
});

test('describes a request fully, with the geography Cloudflare attaches', async () => {
  const request = page('/work/reconstitution/?utm_source=newsletter&utm_campaign=sept', {
    headers: { referer: 'https://t.co/abc' },
  });
  request.cf = { country: 'ZA', region: 'Western Cape', city: 'Cape Town' };
  const row = await describe(request, htmlResponse(), { ANALYTICS_PASSWORD: 's' }, Date.UTC(2026, 8, 4, 10, 0, 0));
  assert.equal(row.bot, false);
  assert.equal(row.path, '/work/reconstitution/');
  assert.deepEqual([row.country, row.region, row.city], ['ZA', 'Western Cape', 'Cape Town']);
  assert.deepEqual([row.referrer, row.utmSource, row.utmCampaign, row.utmMedium], ['t.co', 'newsletter', 'sept', null]);
  assert.equal(row.day, '2026-09-04');
  assert.equal(JSON.stringify(row).includes('203.0.113.7'), false, 'the address must not appear anywhere in the row');
});

test('counts a crawler per day instead of logging it', async () => {
  const db = fakeDb();
  const row = await writePageview(page('/about/', { headers: { 'user-agent': GOOGLEBOT } }), htmlResponse(), { ANALYTICS_DB: db });
  assert.equal(row.bot, true);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /INSERT INTO bot_hits/);
  assert.deepEqual(db.calls[0].args, ['2026-09-04'.slice(0, 0) + row.day, 'googlebot']);
});

test('treats a request for a file that never existed as a scanner, not a visitor', async () => {
  // One of each family production had seen by 2026-09-05, at the depths the
  // sweeps actually try them.
  const probes = [
    '/.env', '/.env.local', '/.env.production', '/config/.env', '/wp/.env', '/%2Eenv',
    '/.aws/credentials', '/.git/config', '/.ssh/id_rsa', '/id_rsa', '/private.key',
    '/settings.py', '/application.properties', '/config.yml', '/config.json',
    '/credentials.yml', '/appsettings.json', '/web.config',
    '/dist/manifest.json', '/build/manifest.json', '/dist/.vite/manifest.json',
    '/.vite/manifest.json', '/.astro/manifest.json',
    '/wp-login.php', '/xmlrpc.php', '/test.php', '/phpinfo', '/_profiler/phpinfo',
    '/wp-content/plugins/plugins/cache.php', '/wp-content/uploads/json.php',
    '/wp-content/uploads/2024/index.php', '/wp-content/themes/', '/wp-content/',
    '/wp-includes/wlwmanifest.xml', '/wp2/wp-includes/wlwmanifest.xml',
    '/wp/wp-admin/includes/', '/wp-json/acf/v3/options/a', '/wp-sitemap-users-1.xml',
    // Seen slipping through on 2026-09-05, after the first day of the rule.
    '/.env~', '/.env_copy', '/.env1', '/.env2', '/.environment', '/_environment',
    '/webroot/index.php/_environment', '/phpinfo.php~', '/phpinfo.php.bak', '/phpinfo.php.save',
    '/info.php.old', '/index.asp', '/cgi-bin/', '/cgi-bin/test.cgi', '/readme.html',
    '/composer.json', '/package.json', '/yarn.lock', '/Dockerfile', '/docker-compose.yml',
    '/.htaccess', '/.htpasswd', '/.DS_Store', '/.vscode/sftp.json', '/.idea/workspace.xml',
    '/karma.conf.json', '/.gitlab-ci.yml', '/wp-content/uploads/x.php.bak',
  ];
  for (const path of probes) assert.equal(isProbe(path), true, `${path} should be a probe`);

  // Real pages, real broken links, and files another site might legitimately serve.
  const genuine = [
    '/', '/about/', '/work/213-populism/', '/work/guilty-feet-have-got-no-rhythm/',
    '/wp-content/uploads/beatles-pygmy.jpg', '/wp-content/uploads/2019/03/x-1024x768.jpg',
    '/manifest.json', '/.well-known/security.txt', '/titles.json', '/version.json',
    '/feed', '/feed/atom/', '/robots.txt', '/sitemap.xml',
    // Automated but not scanners, or too generic for a rule every site shares.
    '/ip', '/date-enquiry/', '/.well-known/traffic-advice', '/admin/', '/home', '/info',
    '/environment/',
  ];
  for (const path of genuine) assert.equal(isProbe(path), false, `${path} is not a probe`);

  const db = fakeDb();
  const row = await writePageview(page('/.env'), htmlResponse(404), { ANALYTICS_DB: db, ANALYTICS_PASSWORD: 's' });
  assert.equal(row.bot, true, 'a browser user agent does not make a probe a person');
  assert.equal(row.botName, 'scanner');
  assert.equal(row.visitor, null);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /INSERT INTO bot_hits/);
  assert.deepEqual(db.calls[0].args, [row.day, 'scanner']);

  // A crawler that only claims to be Googlebot is a scanner on a probe path;
  // one Cloudflare has verified keeps its own name wherever it goes.
  const claimed = await describe(page('/.env', { headers: { 'user-agent': GOOGLEBOT } }), htmlResponse(404), {});
  assert.equal(claimed.botName, 'scanner');
  const verified = page('/.env', { headers: { 'user-agent': GOOGLEBOT } });
  verified.cf = { verifiedBotCategory: 'Search Engine Crawler' };
  assert.equal((await describe(verified, htmlResponse(404), {})).botName, 'search engine crawler');
});

test('a browser user agent with no browser behind it is a fake browser, not a visitor', async () => {
  const req = (headers) => new Request('https://example.com/about/', { headers });
  const LANG = { 'accept-language': 'en-GB,en;q=0.9' };
  // No Accept-Language is enough on its own, whatever the user agent claims.
  assert.equal(isFakeBrowser(req({ 'user-agent': CHROME, ...NAVIGATION })), true);
  assert.equal(isFakeBrowser(req({ 'user-agent': OLD_SAFARI })), true);
  // A version that always sends the Sec-Fetch headers, and does not, is a library.
  assert.equal(isFakeBrowser(req({ 'user-agent': CHROME, ...LANG })), true);
  assert.equal(isFakeBrowser(req({ 'user-agent': EDGE, ...LANG })), true);
  assert.equal(isFakeBrowser(req({ 'user-agent': ANDROID, ...LANG })), true);
  assert.equal(isFakeBrowser(req({ 'user-agent': IPHONE, ...LANG })), true, 'iOS 17 sends them');
  assert.equal(isFakeBrowser(req({ 'user-agent': FIREFOX, ...LANG })), true);
  // The real thing.
  assert.equal(isFakeBrowser(req({ 'user-agent': CHROME, ...LANG, ...NAVIGATION })), false);
  assert.equal(isFakeBrowser(req({ 'user-agent': IPHONE, ...LANG, ...NAVIGATION })), false);
  assert.equal(isFakeBrowser(req({ 'user-agent': FIREFOX, ...LANG, 'sec-fetch-mode': 'navigate' })), false);
  // Browsers that never sent them are judged on Accept-Language alone.
  assert.equal(isFakeBrowser(req({ 'user-agent': OLD_SAFARI, ...LANG })), false);
  assert.equal(isFakeBrowser(req({ 'user-agent': OLD_IPAD, ...LANG })), false, 'iOS 15 never sent them');
  assert.equal(isFakeBrowser(req({ 'user-agent': OLD_FIREFOX, ...LANG })), false);
  assert.equal(isFakeBrowser(req({ 'user-agent': 'Mozilla/5.0 (compatible; SomethingElse/1.0)', ...LANG })), false);

  // Counted as a crawler named "fake browser", never written as a visitor.
  const db = fakeDb();
  const row = await writePageview(req({ 'user-agent': CHROME, ...LANG, 'cf-connecting-ip': '203.0.113.7' }), htmlResponse(), { ANALYTICS_DB: db, ANALYTICS_PASSWORD: 's' });
  assert.equal(row.bot, true);
  assert.equal(row.botName, 'fake browser');
  assert.equal(row.visitor, null);
  assert.match(db.calls[0].sql, /INSERT INTO bot_hits/);
  assert.deepEqual(db.calls[0].args, [row.day, 'fake browser']);
  // A named crawler keeps its name, and a probe is a scanner first.
  assert.equal((await describe(req({ 'user-agent': GOOGLEBOT }), htmlResponse(), {})).botName, 'googlebot');
  assert.equal((await describe(new Request('https://example.com/.env', { headers: { 'user-agent': CHROME } }), htmlResponse(404), {})).botName, 'scanner');
  // A site can switch it off.
  const lenient = await describe(req({ 'user-agent': CHROME, ...LANG }), htmlResponse(), {}, Date.now(), { fakeBrowsers: false });
  assert.equal(lenient.bot, false);
  assert.equal(resolveOptions({}).fakeBrowsers, true);
  assert.equal(resolveOptions({ fakeBrowsers: false }).fakeBrowsers, false);
});

test('writes a person as one pageview row', async () => {
  const db = fakeDb();
  await writePageview(page('/about/'), htmlResponse(), { ANALYTICS_DB: db, ANALYTICS_PASSWORD: 's' });
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].sql, /INSERT INTO pageviews/);
  assert.equal(db.calls[0].args.length, 16);
  assert.equal(db.calls[0].args[2], '/about/');
});

test('a failing database never reaches the visitor', async () => {
  const db = fakeDb([], { failing: true });
  const row = await writePageview(page('/about/'), htmlResponse(), { ANALYTICS_DB: db });
  assert.equal(row, null);
  const waited = [];
  recordPageview(page('/about/'), htmlResponse(), { ANALYTICS_DB: db }, { waitUntil: (p) => waited.push(p) });
  assert.equal(waited.length, 1);
  await waited[0];
});

test('without a database everything is a no-op', async () => {
  const waited = [];
  recordPageview(page('/about/'), htmlResponse(), {}, { waitUntil: (p) => waited.push(p) });
  recordEvent(page('/contact/'), {}, { waitUntil: (p) => waited.push(p) }, 'enquiry', 'x');
  assert.equal(waited.length, 0);
});

test('an enquiry becomes an event carrying the work, not the message', async () => {
  const db = fakeDb();
  const waited = [];
  recordEvent(page('/api/contact', { headers: { referer: 'https://example.com/contact/?work=5' } }), { ANALYTICS_DB: db }, { waitUntil: (p) => waited.push(p) }, 'enquiry', '[5] Reconstitution');
  await Promise.all(waited);
  assert.match(db.calls[0].sql, /INSERT INTO events/);
  assert.equal(db.calls[0].args[2], 'enquiry');
  assert.equal(db.calls[0].args[3], '[5] Reconstitution');
  assert.equal(db.calls[0].args[4], '/contact/');
});

// --- report ---------------------------------------------------------------

const T0 = Date.UTC(2026, 8, 1, 9, 0, 0) / 1000; // 2026-09-01 09:00 UTC
const row = (over) => ({ id: 1, ts: T0, visitor: 'a', path: '/', status: 200, referrer: null, referrer_url: null,
  utm_source: null, utm_medium: null, utm_campaign: null, country: 'GB', region: 'England', city: 'London',
  device: 'desktop', browser: 'Chrome', os: 'macOS', lang: 'en-gb', ...over });

const ROWS = [
  row({ id: 1, ts: T0, path: '/' }),
  row({ id: 2, ts: T0 + 60, path: '/browse/' }),
  row({ id: 3, ts: T0 + 120, path: '/work/reconstitution/' }),
  row({ id: 4, ts: T0 + 4000, path: '/about/' }),                       // same visitor, new session after the gap
  row({ id: 5, ts: T0 + 100, visitor: 'b', path: '/work/5th-amendment/', country: 'ZA', city: 'Cape Town', region: 'Western Cape', device: 'mobile', referrer: 'instagram.com', referrer_url: 'https://instagram.com/p/x' }),
  row({ id: 6, ts: T0 + 200, visitor: 'c', path: '/nope/', status: 404, country: 'US', city: null, region: null }),
];

test('splits pageviews into sessions on a thirty-minute gap', () => {
  const sessions = sessionsOf(ROWS);
  assert.equal(sessions.length, 4);
  const a = sessions.filter((s) => s.visitor === 'a');
  assert.deepEqual(a.map((s) => s.pages), [3, 1]);
  assert.deepEqual([a[0].entry, a[0].exit], ['/', '/work/reconstitution/']);
});

test('totals: visitors, sessions, bounces, duration, 404s', () => {
  const t = totalsOf(ROWS, [{ ts: T0, type: 'enquiry' }, { ts: T0, type: 'unconfigured' }], { events: [{ type: 'enquiry' }] });
  assert.equal(t.pageviews, 6);
  assert.equal(t.visitors, 3);
  assert.equal(t.sessions, 4);
  assert.equal(t.bounceRate, 0.75);
  assert.equal(t.pagesPerSession, 1.5);
  assert.equal(t.avgSessionSeconds, 30);
  assert.equal(t.notFound, 1);
  assert.deepEqual(t.eventCounts, { enquiry: 1 }, 'only configured event types are counted');
});

test('buckets in the viewer’s time zone and fills empty buckets', () => {
  const from = T0 - 3600, to = T0 + 7200;
  assert.equal(bucketFor(from, to), 'hour');
  const utc = series(ROWS, { from, to, tz: 0, bucket: 'hour' });
  assert.deepEqual(utc.map((s) => s.t), ['2026-09-01T08', '2026-09-01T09', '2026-09-01T10']);
  assert.deepEqual(utc.map((s) => s.pageviews), [0, 5, 1]);
  assert.deepEqual(utc.map((s) => s.visitors), [0, 3, 1]);
  const capeTown = series(ROWS, { from, to, tz: 120, bucket: 'hour' });
  assert.deepEqual(capeTown.map((s) => s.t), ['2026-09-01T10', '2026-09-01T11', '2026-09-01T12']);
  // 09:00 three days back to 09:00 tomorrow spans five calendar days; the
  // partial last day is shown rather than dropped, since that is "today".
  const day = series(ROWS, { from: T0 - 86400 * 3, to: T0 + 86400, tz: 0, bucket: 'day' });
  assert.equal(day.length, 5);
  assert.deepEqual(day.map((d) => d.pageviews), [0, 0, 0, 6, 0]);
});

test('the week grid follows the viewer’s clock', () => {
  const grid = weekGrid([row({ ts: Date.UTC(2026, 8, 1, 23, 30) / 1000 })], 120); // Tuesday 23:30 UTC is Wednesday 01:30 in Cape Town
  assert.equal(grid[3][1], 1);
  assert.equal(grid[2][23], 0);
});

test('aggregate produces every panel with visitors per key', () => {
  const r = aggregate(ROWS, { from: T0 - 3600, to: T0 + 7200, tz: 0 }, [], { panels: [{ key: 'works', title: 'Works', prefix: '/work/' }] });
  assert.equal(r.pages[0].key, '/');
  assert.equal(r.prefixPanels.length, 1);
  assert.equal(r.prefixPanels[0].title, 'Works');
  assert.deepEqual(r.prefixPanels[0].list.map((a) => a.key).sort(), ['/work/5th-amendment/', '/work/reconstitution/']);
  assert.deepEqual(aggregate(ROWS, { from: T0 - 3600, to: T0 + 7200, tz: 0 }).prefixPanels, [], 'no panels unless configured');
  assert.deepEqual(r.countries.map((c) => [c.key, c.views]), [['GB', 4], ['US', 1], ['ZA', 1]]);
  assert.deepEqual(r.cities.find((c) => c.name === 'Cape Town').country, 'ZA');
  assert.equal(r.cities.some((c) => c.name === 'null'), false, 'a row with no city is not a city called null');
  assert.deepEqual(r.referrers, [{ key: 'instagram.com', views: 1, visitors: 1 }]);
  assert.deepEqual(r.entries.map((e) => e.key).sort(), ['/', '/about/', '/nope/', '/work/5th-amendment/']);
  assert.deepEqual(r.notFound, [{ key: '/nope/', views: 1, visitors: 1 }]);
  assert.deepEqual(r.devices.map((d) => d.key), ['desktop', 'mobile']);
});

test('buildReport pulls one range, splits off the previous period, and pages through rows', async () => {
  const many = Array.from({ length: 12000 }, (_, i) => row({ id: i + 1, ts: T0 + i, visitor: `v${i % 700}` }));
  const before = Array.from({ length: 5 }, (_, i) => row({ id: 20000 + i, ts: T0 - 86400 + i, visitor: 'old' }));
  const db = fakeDb([...many, ...before]);
  const r = await buildReport(db, { from: T0 - 3600, to: T0 + 86400, tz: 0, now: T0 + 86400 }, { events: [{ type: 'enquiry' }] });
  assert.equal(r.totals.pageviews, 12000);
  assert.equal(r.previous.pageviews, 5, 'the window before the range feeds the comparison');
  assert.equal(r.bots.total, 12);
  assert.equal(r.totals.eventCounts.enquiry, 1);
  assert.equal(r.previous.eventCounts.enquiry, 0);
  const pageQueries = db.calls.filter((c) => c.sql.includes('id >'));
  assert.equal(pageQueries.length, 3, '12005 rows in pages of 5000 is two full pages and a short one');
});

test('the CSV export has a header, a readable time, and quotes what needs it', async () => {
  const db = fakeDb([row({ id: 1, ts: T0, city: 'St. John\'s, "The Rock"' })]);
  const csv = await buildCsv(db, { from: T0 - 1, to: T0 + 1 });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^time,ts,visitor,path/);
  assert.match(lines[1], /^2026-09-01T09:00:00.000Z,/);
  assert.match(lines[1], /"St\. John's, ""The Rock"""/);
});

// --- routes ---------------------------------------------------------------

const PASSWORD = 'correct-horse-battery-staple';
const handler = createAnalyticsHandler({ siteName: 'example.com', dashboard: '<html>DASHBOARD</html>' });
const env = (over = {}) => ({ ANALYTICS_PASSWORD: PASSWORD, ANALYTICS_DB: fakeDb([]), ...over });
const get = (path, headers = {}) => new Request(`https://example.com${path}`, { headers });
const login = (password) => new Request('https://example.com/analytics/login', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': `198.51.100.${Math.floor(Math.random() * 250)}` },
  body: new URLSearchParams({ password }),
});

async function signIn() {
  const res = await handler(login(PASSWORD), env());
  assert.equal(res.status, 303);
  const set = res.headers.get('set-cookie');
  assert.match(set, /HttpOnly/);
  assert.match(set, /Secure/);
  assert.match(set, /Path=\/analytics/);
  return set.split(';')[0];
}

test('fails closed with no password set', async () => {
  for (const path of ['/analytics/', '/analytics/api?from=1&to=2', '/analytics/export.csv?from=1&to=2']) {
    const res = await handler(get(path), env({ ANALYTICS_PASSWORD: undefined }));
    assert.equal(res.status, 503, `${path} must not open up when the secret is missing`);
  }
});

test('shows the login page, not the dashboard, to a stranger', async () => {
  const res = await handler(get('/analytics/'), env());
  assert.equal(res.status, 401);
  const body = await res.text();
  assert.match(body, /password/i);
  assert.doesNotMatch(body, /DASHBOARD/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

test('refuses the data to a stranger', async () => {
  assert.equal((await handler(get('/analytics/api?from=1&to=2'), env())).status, 401);
  assert.equal((await handler(get('/analytics/api/live'), env())).status, 401);
  assert.equal((await handler(get('/analytics/export.csv?from=1&to=2'), env())).status, 401);
});

test('refuses a wrong password and a forged cookie', async () => {
  const res = await handler(login('wrong'), env());
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('set-cookie'), null);
  const forged = await handler(get('/analytics/', { cookie: 'analytics_session=9999999999.deadbeef' }), env());
  assert.equal(forged.status, 401);
  const expired = await handler(get('/analytics/', { cookie: 'analytics_session=1.deadbeef' }), env());
  assert.equal(expired.status, 401);
});

test('a cookie signed under one password is worthless under another', async () => {
  const cookie = await signIn();
  const res = await handler(get('/analytics/', { cookie }), env({ ANALYTICS_PASSWORD: 'rotated' }));
  assert.equal(res.status, 401);
});

test('locks an address out after five wrong passwords', async () => {
  const ip = '198.51.100.251';
  const attempt = () => handler(new Request('https://example.com/analytics/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': ip },
    body: new URLSearchParams({ password: 'wrong' }),
  }), env());
  for (let i = 0; i < 5; i += 1) assert.equal((await attempt()).status, 401);
  assert.equal((await attempt()).status, 429);
});

test('the right password opens the dashboard, the data and the export', async () => {
  const cookie = await signIn();
  const page = await handler(get('/analytics/', { cookie }), env());
  assert.equal(page.status, 200);
  assert.match(await page.text(), /DASHBOARD/);
  const api = await handler(get(`/analytics/api?from=${T0}&to=${T0 + 86400}&tz=120`, { cookie }), env({ ANALYTICS_DB: fakeDb(ROWS) }));
  assert.equal(api.status, 200);
  const report = await api.json();
  assert.equal(report.totals.pageviews, 6);
  assert.equal(report.range.tz, 120);
  assert.equal(report.live.visitors, 3);
  const csv = await handler(get(`/analytics/export.csv?from=${T0}&to=${T0 + 86400}`, { cookie }), env({ ANALYTICS_DB: fakeDb(ROWS) }));
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-disposition'), /example-traffic-2026-09-01-to-2026-09-02\.csv/);
  assert.equal((await csv.text()).trim().split('\n').length, 7);
});

test('rejects a nonsense range', () => {
  const url = (q) => new URL(`https://example.com/analytics/api?${q}`);
  assert.ok(parseRange(url('from=abc&to=2')).error);
  assert.ok(parseRange(url('from=5&to=2')).error);
  assert.ok(parseRange(url('from=0&to=999999999')).error, 'thirty years is not a range');
  assert.ok(parseRange(url('from=1&to=2&tz=9999')).error);
  assert.deepEqual(parseRange(url('from=1&to=2&tz=-300'), 7), { from: 1, to: 2, tz: -300, now: 7 });
});

test('logging out clears the cookie', async () => {
  const res = await handler(new Request('https://example.com/analytics/logout', { method: 'POST' }), env());
  assert.equal(res.status, 303);
  assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
});

// --- the package: options, the factory, the dashboard ------------------------

test('options are checked once, loudly, and defaults are sensible', () => {
  const c = resolveOptions({});
  assert.equal(c.prefix, '/analytics');
  assert.equal(c.cookieName, 'analytics_session');
  assert.deepEqual(c.skipPrefixes, ['/analytics'], 'the dashboard is always skipped');
  assert.deepEqual([c.panels, c.events, c.launchDate, c.titlesUrl, c.probes], [[], [], null, null, true]);
  const site = resolveOptions({
    siteName: 'example.com', prefix: '/stats/', skipPrefixes: ['/images/', '/stats/'],
    panels: [{ title: 'Posts', prefix: '/posts/' }], events: ['signup'], launchDate: '2026-01-01', probes: false,
  });
  assert.equal(site.prefix, '/stats', 'a trailing slash is dropped');
  assert.deepEqual(site.skipPrefixes, ['/stats', '/images/', '/stats/']);
  assert.deepEqual(site.panels, [{ key: 'posts', title: 'Posts', prefix: '/posts/', description: '' }]);
  assert.deepEqual(site.events, [{ type: 'signup', label: 'signup', description: '' }]);
  assert.equal(site.probes, false);
  assert.throws(() => resolveOptions({ prefix: 'analytics' }), /prefix/);
  assert.throws(() => resolveOptions({ panels: [{ title: 'Posts' }] }), /panels\[0\]/);
  assert.throws(() => resolveOptions({ panels: [{ prefix: '/x/' }] }), /title/);
  assert.throws(() => resolveOptions({ events: [{}] }), /events\[0\]/);
  assert.throws(() => resolveOptions({ launchDate: 'yesterday' }), /launchDate/);
  assert.throws(() => resolveOptions('nope'), /object/);
});

test('the generated dashboard module matches the html it was built from', () => {
  const html = readFileSync(fileURLToPath(new URL('../src/dashboard.html', import.meta.url)), 'utf8');
  assert.equal(dashboardHtml, html, 'run `npm run build` after editing dashboard.html');
  assert.match(html, /<style>\s*\[hidden\]\{display:none!important\}/,
    'the [hidden] rule must be the first in the stylesheet or every panel shows all its rows');
  for (const placeholder of ['__SITE_NAME__', '__PREFIX__', '__ANALYTICS_CONFIG__']) {
    assert.ok(html.includes(placeholder), `${placeholder} is where the site configuration goes`);
  }
});

test('the dashboard is served with the site configuration in it, safely escaped', () => {
  const config = resolveOptions({
    prefix: '/stats', launchDate: '2026-08-27', titlesUrl: '/titles.json',
    panels: [{ title: 'Works', prefix: '/work/' }], events: [{ type: 'enquiry', label: 'Enquiries', description: 'sent through the form' }],
  });
  const html = renderDashboard(config, '</script><b>evil</b>.example');
  assert.equal(html.includes('__SITE_NAME__') || html.includes('__PREFIX__') || html.includes('__ANALYTICS_CONFIG__'), false);
  assert.ok(html.includes('<title>Traffic · &lt;/script&gt;&lt;b&gt;evil&lt;/b&gt;.example</title>'));
  assert.ok(html.includes('action="/stats/logout"'));
  const block = html.match(/<script id="analytics-config" type="application\/json">(.*?)<\/script>/s)[1];
  assert.equal(block.includes('</script>'), false, 'nothing in the JSON may close the script tag');
  const client = JSON.parse(block);
  assert.equal(client.siteName, '</script><b>evil</b>.example');
  assert.deepEqual([client.prefix, client.launchDate, client.titlesUrl], ['/stats', '2026-08-27', '/titles.json']);
  assert.deepEqual(client.panels.map((p) => p.prefix), ['/work/']);
  assert.deepEqual(client.events.map((e) => e.label), ['Enquiries']);
});

test('the factory wires a site up under its own prefix and skips what it is told to', async () => {
  const analytics = createAnalytics({ prefix: '/stats', skipPrefixes: ['/static/'], siteName: '' });
  assert.equal(analytics.matches('/stats'), true);
  assert.equal(analytics.matches('/stats/api'), true);
  assert.equal(analytics.matches('/statistics/'), false);
  assert.equal(analytics.matches('/analytics/'), false, 'the default prefix means nothing to a site that moved it');

  // Without a site name the hostname stands in, on the login page and the dashboard.
  const stranger = await analytics.handle(new Request('https://example.org/stats/'), env());
  assert.equal(stranger.status, 401);
  assert.match(await stranger.text(), /example\.org traffic/);
  const res = await analytics.handle(new Request('https://example.org/stats/login', {
    method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'cf-connecting-ip': '198.51.100.9' },
    body: new URLSearchParams({ password: PASSWORD }),
  }), env());
  assert.equal(res.status, 303);
  const set = res.headers.get('set-cookie');
  assert.match(set, /^analytics_session=/);
  assert.match(set, /Path=\/stats;/);
  const dash = await analytics.handle(new Request('https://example.org/stats/', { headers: { cookie: set.split(';')[0] } }), env());
  assert.equal(dash.status, 200);
  const body = await dash.text();
  assert.ok(body.includes('<title>Traffic · example.org</title>'));
  assert.ok(body.includes('"prefix":"/stats"'));

  // Recording honours the skip list and the prefix; everything else is a page.
  const db = fakeDb();
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const visit = (path) => analytics.recordPageview(page(path), htmlResponse(), { ANALYTICS_DB: db, ANALYTICS_PASSWORD: 's' }, ctx);
  visit('/static/app.css');
  visit('/stats/');
  visit('/analytics/');
  visit('/hello/');
  await Promise.all(waited);
  // Sorted: the two writes race each other through the daily key derivation.
  assert.deepEqual(db.calls.map((c) => c.args[2]).sort(), ['/analytics/', '/hello/'], 'only the configured prefixes are skipped');

  // A probe is a scanner by default and a visitor only when a site opts out.
  const counted = fakeDb();
  const quiet = createAnalytics({ probes: false });
  const waited2 = [];
  quiet.recordPageview(page('/.env'), htmlResponse(404), { ANALYTICS_DB: counted, ANALYTICS_PASSWORD: 's' }, { waitUntil: (p) => waited2.push(p) });
  await Promise.all(waited2);
  assert.match(counted.calls[0].sql, /INSERT INTO pageviews/);
});

// --- the package's own hygiene ----------------------------------------------

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const filesIn = (dir) => readdirSync(join(ROOT, dir)).map((f) => join(dir, f)).filter((f) => statSync(join(ROOT, f)).isFile());
const PACKAGE_FILES = ['index.js', 'package.json', 'README.md', 'LICENSE', ...filesIn('src'), ...filesIn('tests'), ...filesIn('migrations'), ...filesIn('scripts')];

test('the stylesheet keeps [hidden]{display:none!important} as its first rule', () => {
  const css = dashboardHtml.match(/<style>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.ok(css.startsWith('[hidden]{display:none!important}'), `the first rule is ${css.slice(0, 40)}`);
  assert.match(css, /\.row\{display:grid/, 'the author display rule the guard exists for is still there');
});

test('nothing site-specific remains in the package', () => {
  // Built from halves so this file does not itself match a grep for them. The
  // GitHub owner has to appear in the README install line and in package.json.
  const banned = ['ralph' + 'lazar', '/ar' + 't/', 'search-' + 'corpus'];
  for (const file of PACKAGE_FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const word of banned) {
      if (word === banned[0] && (file === 'README.md' || file === 'package.json')) continue;
      assert.equal(text.includes(word), false, `${file} still mentions ${word}`);
    }
  }
});

test('no em or en dashes anywhere in the package', () => {
  // Written as escapes so this file does not carry the characters itself. A
  // consumer's verifier may reject either, and a hyphen offends nobody.
  for (const file of PACKAGE_FILES) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    assert.equal(text.includes('\u2014'), false, `${file} contains an em dash`);
    assert.equal(text.includes('\u2013'), false, `${file} contains an en dash`);
  }
});

test('the package is licensed, and LICENSE agrees with package.json', () => {
  const license = readFileSync(join(ROOT, 'LICENSE'), 'utf8');
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.license, 'MIT');
  assert.match(license, /^MIT License\n/);
  assert.match(license, /^Copyright \(c\) \d{4} \S/m);
  assert.ok(pkg.files.includes('LICENSE'), 'LICENSE ships with the package');
});

let failed = 0;
for (const [name, fn] of tests) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
console.log(`\n${tests.length - failed} of ${tests.length} passed`);
process.exit(failed ? 1 : 0);
