// The dashboard and its data, behind one password. Paths below assume the
// default prefix; `prefix` in the options moves all of them.
//
//   GET  /analytics/            the dashboard, or the login page
//   POST /analytics/login       password in, session cookie out
//   POST /analytics/logout
//   GET  /analytics/api         the report as JSON (?from=&to=&tz=)
//   GET  /analytics/api/live    just who is on the site now
//   GET  /analytics/export.csv  the raw rows for a range
//
// The cookie is an expiry and an HMAC of it under ANALYTICS_PASSWORD, so a
// session survives a Worker redeploy and cannot be forged without the secret.
// The dashboard HTML is a JS module (generated from dashboard.html) served from
// here rather than shipped as a static asset, so nothing about it is public.
// Per-site configuration is injected into it at serve time.
//
// Fails closed: with no ANALYTICS_PASSWORD every route answers 503, the same
// rule as /api/digest. An unset secret must never mean "no password required".

import { hmac, hex } from './collect.js';
import { buildReport, buildCsv, loadLive, SESSION_GAP } from './report.js';
import { resolveOptions, slug } from './config.js';
import dashboardHtml from './dashboard.js';

const SESSION_SECONDS = 30 * 24 * 3600;
const MAX_RANGE_SECONDS = 5 * 366 * 86400;

// Per-isolate throttle on the login form: five wrong passwords and that
// address waits fifteen minutes. Isolates are short-lived so this is a
// speed bump rather than a wall; the wall is a long password.
const FAILURES = new Map();
const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 15 * 60;

const encoder = new TextEncoder();
const sha256 = async (text) => hex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

// Compares hashes of equal length in constant time, so neither the length
// nor the first differing character of the secret leaks through timing.
async function secretsMatch(given, expected) {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const signSession = (secret, expires) => hmac(secret, `session|${expires}`);

async function isAuthed(request, secret, cookieName) {
  const header = request.headers.get('cookie') || '';
  const match = header.match(new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`));
  if (!match) return false;
  const [expires, signature] = match[1].split('.');
  if (!/^\d+$/.test(expires || '') || Number(expires) < Date.now() / 1000) return false;
  return secretsMatch(signature || '', await signSession(secret, expires));
}

const cookie = (name, prefix, value, maxAge) =>
  `${name}=${value}; Path=${prefix}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };
const html = (status, body, extra = {}) =>
  new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...NO_STORE, ...extra } });
const json = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE } });
const redirect = (location, extra = {}) =>
  new Response(null, { status: 303, headers: { location, ...NO_STORE, ...extra } });

const escape = (text) => String(text).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const loginPage = (site, prefix, message = '') => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Traffic · ${escape(site)}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#faf8f4;color:#1c1a17;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  form{width:min(90vw,22rem);display:grid;gap:.75rem}
  h1{font-weight:500;font-size:1.25rem;margin:0 0 .25rem}
  p{margin:0;color:#5a544c;font-size:.9rem}
  input,button{font:inherit;padding:.6rem .75rem;border:1px solid #e3ddd0;border-radius:4px;background:#fff}
  button{background:#1c1a17;color:#faf8f4;border-color:#1c1a17;cursor:pointer}
  .error{color:#c1272d}
</style></head><body>
<form method="post" action="${prefix}/login">
  <h1>${escape(site)} traffic</h1>
  <p>${message ? `<span class="error">${escape(message)}</span>` : 'Private. Enter the analytics password.'}</p>
  <input type="password" name="password" autocomplete="current-password" autofocus required aria-label="Password">
  <button type="submit">Sign in</button>
</form></body></html>`;

function throttled(ip, now) {
  const record = FAILURES.get(ip);
  return Boolean(record && record.count >= MAX_FAILURES && now < record.until);
}
function noteFailure(ip, now) {
  const record = FAILURES.get(ip) || { count: 0, until: 0 };
  if (now > record.until) Object.assign(record, { count: 0 });
  record.count += 1;
  record.until = now + LOCKOUT_SECONDS;
  FAILURES.set(ip, record);
}

const integer = (value) => (/^-?\d+$/.test(value || '') ? Number(value) : null);

/** Parse ?from=&to=&tz=, or explain what is wrong with them. */
export function parseRange(url, now = Math.floor(Date.now() / 1000)) {
  const from = integer(url.searchParams.get('from'));
  const to = integer(url.searchParams.get('to'));
  const tz = integer(url.searchParams.get('tz') ?? '0');
  if (from === null || to === null) return { error: 'from and to must be unix seconds' };
  if (to <= from) return { error: 'to must be after from' };
  if (to - from > MAX_RANGE_SECONDS) return { error: 'range too long' };
  if (tz === null || Math.abs(tz) > 14 * 60) return { error: 'tz must be minutes east of UTC' };
  return { from, to, tz, now };
}

/**
 * The dashboard with this site's configuration in it. Three placeholders:
 * the site name and the prefix in the static HTML, and a JSON config block
 * the page's script reads. `<` is escaped in the JSON so nothing a site name
 * or title could contain can close the script tag.
 */
export function renderDashboard(config, site, template = dashboardHtml) {
  const client = {
    siteName: site,
    prefix: config.prefix,
    launchDate: config.launchDate,
    titlesUrl: config.titlesUrl,
    panels: config.panels,
    events: config.events,
  };
  return template
    .replaceAll('__SITE_NAME__', escape(site))
    .replaceAll('__PREFIX__', escape(config.prefix))
    .replace('__ANALYTICS_CONFIG__', JSON.stringify(client).replace(/</g, '\\u003c'));
}

export function createAnalyticsHandler(options = {}) {
  const config = resolveOptions(options);
  const PREFIX = config.prefix;
  const COOKIE = config.cookieName;
  const template = options.dashboard ?? dashboardHtml;
  // Rendered once per site name (usually one), not once per request.
  const rendered = new Map();
  const dashboardFor = (site) => {
    if (!rendered.has(site)) rendered.set(site, renderDashboard(config, site, template));
    return rendered.get(site);
  };

  return async function handleAnalytics(request, env) {
    const url = new URL(request.url);
    const route = url.pathname.replace(/\/+$/, '');
    const now = Math.floor(Date.now() / 1000);
    const secret = env.ANALYTICS_PASSWORD;
    const site = config.siteName || url.hostname;

    if (!secret) {
      console.error('analytics: ANALYTICS_PASSWORD is not set, refusing every request');
      return html(503, '<p>Analytics is not configured: set ANALYTICS_PASSWORD.</p>');
    }
    if (!env.ANALYTICS_DB) {
      return html(503, '<p>Analytics is not configured: no ANALYTICS_DB binding.</p>');
    }

    if (route === `${PREFIX}/login`) {
      if (request.method !== 'POST') return redirect(`${PREFIX}/`);
      const ip = request.headers.get('cf-connecting-ip') || 'unknown';
      if (throttled(ip, now)) return html(429, loginPage(site, PREFIX, 'Too many attempts. Try again in fifteen minutes.'));
      let given = '';
      try {
        given = String((await request.formData()).get('password') || '');
      } catch {
        return html(400, loginPage(site, PREFIX, 'Bad request.'));
      }
      if (!(await secretsMatch(given, secret))) {
        noteFailure(ip, now);
        return html(401, loginPage(site, PREFIX, 'Wrong password.'));
      }
      FAILURES.delete(ip);
      const expires = now + SESSION_SECONDS;
      const value = `${expires}.${await signSession(secret, expires)}`;
      return redirect(`${PREFIX}/`, { 'set-cookie': cookie(COOKIE, PREFIX, value, SESSION_SECONDS) });
    }

    if (route === `${PREFIX}/logout`) {
      return redirect(`${PREFIX}/`, { 'set-cookie': cookie(COOKIE, PREFIX, '', 0) });
    }

    const authed = await isAuthed(request, secret, COOKIE);

    if (route === PREFIX) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
      return authed ? html(200, dashboardFor(site)) : html(401, loginPage(site, PREFIX));
    }
    if (!authed) return json(401, { ok: false, error: 'Unauthorized.' });
    if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    if (route === `${PREFIX}/api/live`) {
      return json(200, await loadLive(env.ANALYTICS_DB, now - SESSION_GAP));
    }

    if (route === `${PREFIX}/api` || route === `${PREFIX}/export.csv`) {
      const range = parseRange(url, now);
      if (range.error) return json(400, { ok: false, error: range.error });
      if (route === `${PREFIX}/api`) return json(200, await buildReport(env.ANALYTICS_DB, range, config));
      const name = `${slug(site.split('.')[0])}-traffic-${new Date(range.from * 1000).toISOString().slice(0, 10)}-to-${new Date(range.to * 1000).toISOString().slice(0, 10)}.csv`;
      return new Response(await buildCsv(env.ANALYTICS_DB, range), {
        headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, ...NO_STORE },
      });
    }

    return html(404, '<p>Not found.</p>');
  };
}
