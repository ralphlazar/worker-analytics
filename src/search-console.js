// Google Search Console: the words people typed into Google to reach the site.
//
// There is exactly one source for this. Google stopped sending search terms
// in the referrer in 2013, so a visitor from Google arrives carrying
// google.com and nothing else, on every site in the world. Search Console's
// Performance data has the terms, published two to three days late, kept for
// sixteen months, and trimmed: rare searches are withheld, so its totals run
// below the real click count. The dashboard says so under the panels.
//
// Optional. A site switches it on with the `searchConsole` option, naming the
// secret that holds a Google service-account JSON with read access to the
// property (README, "Google searches"). Without the secret the panel says
// "Not connected" and nothing else on the dashboard is affected: every path
// through this module catches its own failures and reports them as text.
//
// Refresh is on demand, since Pages has no cron. When the dashboard API is
// called and the last refresh is over an hour old, the last seven days are
// pulled again inside ctx.waitUntil (final figures lag and get revised). On
// the very first run the sixteen months Google keeps are backfilled in
// monthly chunks, newest first, a few months per call so no single call
// outlives the runtime's budget for background work; the dashboard's own
// polling brings the next chunk in. Rows are upserted by day, so a refresh
// never duplicates and a revised day replaces itself.
//
// Talking to Google: a JWT signed RS256 with the service account's private
// key (a PEM, imported as PKCS8) is exchanged for an hour's access token; the
// sites list finds the property (a domain property, sc-domain:example.com,
// is preferred to the URL-prefix form); searchAnalytics/query is paged
// 25,000 rows at a time with dataState "final", once by date and query and
// once by date and page.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SITES_URL = 'https://www.googleapis.com/webmasters/v3/sites';
const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const queryUrl = (siteUrl) =>
  `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;

export const ROW_LIMIT = 25000;
export const REFRESH_SECONDS = 3600;     // how old the data may get before a dashboard call refreshes it
export const RETRY_SECONDS = 300;        // after a failure, wait this long before asking Google again
export const LOCK_SECONDS = 180;         // a run that has not cleared its lock in this long is presumed dead
export const RECENT_DAYS = 7;            // the routine refresh re-pulls this many days
export const BACKFILL_MONTHS = 16;       // what Google keeps
export const MONTHS_PER_RUN = 6;         // backfill chunks per call
const RUN_BUDGET_MS = 15000;             // start no new chunk after this; waitUntil allows about thirty seconds
const LIST_LIMIT = 200;
const LIMITS = { key: 500, error: 500 };

const cut = (value, limit) => (value == null ? null : String(value).slice(0, limit));
const messageOf = (error) => (error && error.message) || String(error);

// --- Google ------------------------------------------------------------------

const encoder = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function pemToDer(pem) {
  const body = String(pem).replace(/-----[A-Z ]+-----/g, '').replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** The service-account JSON, checked for the two fields the exchange needs. */
export function parseCredentials(raw, name = 'the service-account secret') {
  if (!raw) throw new Error(`${name} is not set`);
  let creds;
  try {
    creds = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error(`${name} is not valid JSON`);
  }
  if (!creds || !creds.client_email || !creds.private_key) {
    throw new Error(`${name} is not a service-account key (client_email and private_key expected)`);
  }
  return creds;
}

/** A one-hour JWT for the read-only Search Console scope, RS256 under the account's key. */
export async function signJwt(creds, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = b64url(encoder.encode(JSON.stringify({
    iss: creds.client_email, scope: SCOPE, aud: TOKEN_URL, iat: now, exp: now + 3600,
  })));
  const key = await crypto.subtle.importKey(
    'pkcs8', pemToDer(creds.private_key), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(new Uint8Array(signature))}`;
}

export async function fetchAccessToken(creds, fetch = globalThis.fetch, now) {
  const assertion = await signJwt(creds, now);
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    throw new Error(`Google token request failed: ${res.status} ${body.error_description || body.error || ''}`.trim());
  }
  return body.access_token;
}

const authed = (token) => ({ authorization: `Bearer ${token}` });
const googleError = (body) => (body && body.error && body.error.message) || '';

/**
 * The property to read: the configured one if it is shared with the account,
 * else the domain property for the host, else its URL-prefix property.
 */
export async function findProperty(token, host, fetch = globalThis.fetch, preferred = null) {
  const res = await fetch(SITES_URL, { headers: authed(token) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Google sites list failed: ${res.status} ${googleError(body)}`.trim());
  const urls = (body.siteEntry || []).map((s) => s.siteUrl);
  const bare = String(host || '').toLowerCase().replace(/^www\./, '');
  const candidates = [
    preferred, `sc-domain:${bare}`, `https://${bare}/`, `https://www.${bare}/`, `http://${bare}/`, `http://www.${bare}/`,
  ].filter(Boolean);
  const found = candidates.find((c) => urls.includes(c));
  if (!found) {
    throw new Error(`No Search Console property for ${bare} is shared with the service account (it sees: ${urls.join(', ') || 'nothing'})`);
  }
  return found;
}

/** Every row of one dimension over [startDate, endDate], paged. Final figures only. */
export async function fetchRows(token, siteUrl, dimension, startDate, endDate, fetch = globalThis.fetch) {
  const rows = [];
  for (let startRow = 0; ; startRow += ROW_LIMIT) {
    const res = await fetch(queryUrl(siteUrl), {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ startDate, endDate, dimensions: ['date', dimension], rowLimit: ROW_LIMIT, startRow, dataState: 'final' }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Google search analytics failed: ${res.status} ${googleError(body)}`.trim());
    const page = body.rows || [];
    for (const r of page) {
      rows.push({ day: r.keys[0], key: r.keys[1], clicks: r.clicks || 0, impressions: r.impressions || 0, position: r.position ?? null });
    }
    if (page.length < ROW_LIMIT) return rows;
  }
}

// --- the database --------------------------------------------------------------

const TABLES = { query: { table: 'search_queries', column: 'query' }, page: { table: 'search_pages', column: 'page' } };
const ROWS_PER_STATEMENT = 20;   // five bound values a row; D1 allows a hundred a statement
const STATEMENTS_PER_BATCH = 50;

/** Upsert rows by (day, key). A revised day replaces itself; nothing is ever duplicated. */
export async function upsertRows(db, dimension, rows) {
  const { table, column } = TABLES[dimension];
  // Google does not repeat a (day, key) pair, but one statement may not touch
  // the same row twice, so the pairs are made unique before they are bound.
  const unique = [...new Map(rows.map((r) => [`${r.day}|${r.key}`, r])).values()];
  const statements = [];
  for (let i = 0; i < unique.length; i += ROWS_PER_STATEMENT) {
    const chunk = unique.slice(i, i + ROWS_PER_STATEMENT);
    const sql = `INSERT INTO ${table} (day, ${column}, clicks, impressions, position) VALUES ${chunk.map(() => '(?, ?, ?, ?, ?)').join(', ')}
      ON CONFLICT (day, ${column}) DO UPDATE SET clicks = excluded.clicks, impressions = excluded.impressions, position = excluded.position`;
    statements.push(db.prepare(sql).bind(...chunk.flatMap((r) => [r.day, cut(r.key, LIMITS.key), r.clicks, r.impressions, r.position])));
  }
  for (let i = 0; i < statements.length; i += STATEMENTS_PER_BATCH) {
    await db.batch(statements.slice(i, i + STATEMENTS_PER_BATCH));
  }
  return unique.length;
}

/** The sync state as an object: property, last_refresh, last_attempt, lock, backfill_next, backfill_until, backfill_done, last_error. */
export async function readSync(db) {
  const { results } = await db.prepare('SELECT key, value FROM search_sync').all();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

const SET_SYNC = 'INSERT INTO search_sync (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value';
const writeSync = (db, pairs) =>
  db.batch(Object.entries(pairs).map(([key, value]) => db.prepare(SET_SYNC).bind(key, value == null ? null : String(value))));

// --- dates (all UTC) -------------------------------------------------------------

export const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
export const monthOf = (day) => day.slice(0, 7);
const utcMonth = (year, monthIndex, day = 1) => new Date(Date.UTC(year, monthIndex, day)).toISOString();

/** The first and last day of a "YYYY-MM", the last clipped to today. */
export function monthRange(month, today) {
  const [y, m] = month.split('-').map(Number);
  const last = utcMonth(y, m, 0).slice(0, 10); // day zero of the next month
  return [`${month}-01`, last < today ? last : today];
}
export function previousMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return utcMonth(y, m - 2).slice(0, 7);
}
export function monthsAgo(today, n) {
  const d = new Date(`${today}T00:00:00Z`);
  return utcMonth(d.getUTCFullYear(), d.getUTCMonth() - n).slice(0, 7);
}
const daysAgo = (today, n) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86400000).toISOString().slice(0, 10);

// --- the module ---------------------------------------------------------------------

/**
 * options: { secret, site?, property? } as resolved by config.js.
 * deps.fetch lets tests stand in for Google.
 */
export function createSearchConsole(options, { fetch = globalThis.fetch } = {}) {
  const secretName = options.secret;
  const configuredSite = options.site || null;
  const preferred = options.property || null;

  /** Pull what is due. Never throws; the outcome is written to search_sync and returned. */
  async function refresh(env, { now = Math.floor(Date.now() / 1000), host = null } = {}) {
    const db = env.ANALYTICS_DB;
    const raw = env[secretName];
    if (!db) return { skipped: 'no database' };
    if (!raw) return { skipped: 'not connected' };
    let state;
    try {
      state = await readSync(db);
    } catch (error) {
      console.error('analytics: search console state unreadable (migration 0002 applied?)', error);
      return { error: messageOf(error) };
    }
    const age = (key) => (state[key] ? now - Number(state[key]) : Infinity);
    if (age('lock') < LOCK_SECONDS) return { skipped: 'a refresh is running' };
    if (state.last_error && age('last_attempt') < RETRY_SECONDS) return { skipped: 'failed recently' };
    const backfilling = Boolean(state.backfill_next);
    if (!backfilling && age('last_refresh') < REFRESH_SECONDS) return { skipped: 'fresh' };

    const started = Date.now();
    const done = { months: [], days: 0 };
    try {
      await writeSync(db, { lock: now, last_attempt: now });
      const creds = parseCredentials(raw, secretName);
      const token = await fetchAccessToken(creds, fetch, now);
      const property = state.property || await findProperty(token, configuredSite || host, fetch, preferred);
      const today = dayOf(now);
      const pull = async (startDate, endDate) => {
        for (const dimension of ['query', 'page']) {
          await upsertRows(db, dimension, await fetchRows(token, property, dimension, startDate, endDate, fetch));
        }
      };

      let next = state.backfill_next || null;
      let until = state.backfill_until || null;
      if (!state.last_refresh && !next && !state.backfill_done) {
        // The very first run: sixteen months, newest first.
        next = monthOf(today);
        until = monthsAgo(today, BACKFILL_MONTHS);
      }
      if (next) {
        while (done.months.length < MONTHS_PER_RUN && next >= until && Date.now() - started < RUN_BUDGET_MS) {
          const [start, end] = monthRange(next, today);
          await pull(start, end);
          done.months.push(next);
          next = previousMonth(next);
        }
        const finished = next < until;
        await writeSync(db, {
          property, last_refresh: now, last_error: null, lock: null,
          backfill_next: finished ? null : next, backfill_until: until, backfill_done: finished ? '1' : null,
        });
      } else {
        await pull(daysAgo(today, RECENT_DAYS), today);
        done.days = RECENT_DAYS;
        await writeSync(db, { property, last_refresh: now, last_error: null, lock: null });
      }
      return done;
    } catch (error) {
      console.error('analytics: search console refresh failed', error);
      await writeSync(db, { last_error: cut(messageOf(error), LIMITS.error), lock: null }).catch(() => {});
      return { error: messageOf(error) };
    }
  }

  /** Schedule a refresh off the response path. Without a waitUntil there is nowhere to run it. */
  function maybeRefresh(env, ctx, opts = {}) {
    if (!ctx || typeof ctx.waitUntil !== 'function') return false;
    ctx.waitUntil(refresh(env, opts).catch((error) => console.error('analytics: search console', error)));
    return true;
  }

  /** What the dashboard shows for a range. Never throws. */
  async function report(env, { from, to }) {
    const connected = Boolean(env[secretName]);
    const out = {
      status: connected ? 'ok' : 'not-connected',
      message: connected ? '' : `${secretName} is not set`,
      property: null, lastRefresh: null, backfilling: false,
      totals: { clicks: 0, impressions: 0 }, queries: [], pages: [],
    };
    const db = env.ANALYTICS_DB;
    if (!db) return { ...out, status: 'error', message: 'no ANALYTICS_DB binding' };
    try {
      const state = await readSync(db);
      out.property = state.property || null;
      out.lastRefresh = state.last_refresh ? Number(state.last_refresh) : null;
      out.backfilling = Boolean(state.backfill_next);
      if (connected && state.last_error) {
        out.status = 'error';
        out.message = state.last_error;
      }
      const fromDay = dayOf(from);
      const toDay = dayOf(to - 1);
      const list = async (dimension) => {
        const { table, column } = TABLES[dimension];
        const { results } = await db.prepare(
          `SELECT ${column} AS key, SUM(clicks) AS clicks, SUM(impressions) AS impressions,
                  CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) END AS position
           FROM ${table} WHERE day >= ? AND day <= ? GROUP BY ${column}
           ORDER BY clicks DESC, impressions DESC, key LIMIT ?`,
        ).bind(fromDay, toDay, LIST_LIMIT).all();
        return results;
      };
      out.queries = await list('query');
      out.pages = await list('page');
      // Totals come from the page rows: Google withholds rare queries from the
      // query rows but counts their clicks against the pages they landed on.
      const { results } = await db.prepare(
        'SELECT SUM(clicks) AS clicks, SUM(impressions) AS impressions FROM search_pages WHERE day >= ? AND day <= ?',
      ).bind(fromDay, toDay).all();
      out.totals = { clicks: (results[0] && results[0].clicks) || 0, impressions: (results[0] && results[0].impressions) || 0 };
    } catch (error) {
      out.status = 'error';
      out.message = cut(messageOf(error), LIMITS.error);
    }
    return out;
  }

  return { secretName, refresh, maybeRefresh, report };
}
