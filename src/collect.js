// Traffic collection, done by the Worker rather than by a script on the page.
//
// The Worker already runs on every request (with `run_worker_first` set when
// the site serves static assets), so it can write down what it serves: the path, where the visitor is (Cloudflare puts
// country, region and city on `request.cf`), where they came from, and what
// they are browsing with. Nothing is added to the page, no cookie is set, and
// no third party is involved, which is what keeps the site museum-quiet and
// keeps a consent banner off the site.
//
// A visitor is a one-way hash of address and user agent keyed on the day, the
// approach Plausible and Fathom use: the same person on the same day is one
// visitor, tomorrow they are a new one, and nothing stored can be turned back
// into who they were. The daily key is derived from ANALYTICS_PASSWORD, so
// without that secret the hash falls back to the bare date. It still hashes,
// it is just guessable, so set the secret.
//
// Crawlers are counted per day rather than logged per hit, so a busy bot can
// neither swell the tables nor show up as a spike of "visitors".
//
// Every write is wrapped: analytics that can break the site are not worth
// having, so a failure here logs and the page is served regardless.

// The obviously automated. Not exhaustive, since nothing is: verified bots
// also arrive labelled by Cloudflare, and the rest is a user-agent sweep.
const BOT_RE =
  /bot|crawl|spider|slurp|scan|monitor|headless|python|curl|wget|okhttp|go-http|java\/|libwww|httpclient|facebookexternalhit|embedly|pinterest|whatsapp|telegram|discord|skype|slack|lighthouse|pagespeed|gtmetrix|ahrefs|semrush|dotbot|petalbot|bytespider|gptbot|claudebot|ccbot|anthropic|openai|perplexity|applebot|bingpreview|yandex|baidu|duckduck|sogou|exabot|ia_archiver|archive\.org|feedfetcher|feedburner|prerender|phantomjs|puppeteer|playwright|selenium/i;

// Requests only a vulnerability scanner makes. Nothing here exists on a Worker
// site: leaked-secret files (.env in every flavour, keys, cloud
// credentials), PHP and WordPress entry points, and the manifests build tools
// leave behind. Scanners claim to be browsers, so the user-agent sweep above
// misses them, and every probe was being counted as a visitor: on 2026-09-05
// one sweep from Frankfurt made twelve requests in one second under twelve
// different fake browsers, and over half of all page views recorded since
// launch of ralphlazar.com were 404s of this kind. A probe is counted as a crawler named
// "scanner", per day like any other bot, and never written as a pageview, so
// it stays out of the visitor count and out of the Broken links panel.
//
// Old WordPress upload links (/wp-content/uploads/*.jpg) are deliberately NOT
// probes: on a site migrated off WordPress those are people following a link
// from somewhere, which is exactly what the Broken links panel exists to show. The families are matched by
// path segment rather than by whole path because the sweeps try them at every
// depth (/config/.env, /wp2/wp-includes/, /dist/.vite/manifest.json).
const PROBE_SEGMENT_RE =
  /^(?:\.env(?:\..*)?|\.git|\.svn|\.hg|\.ssh|\.aws|\.docker|\.vite|\.astro|wp-admin|wp-includes|wp-json|_profiler)$/i;
const PROBE_FILE_RE =
  /^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|private\.key|config\.json|config\.ya?ml|credentials(?:\.ya?ml|\.json)?|appsettings\.json|settings\.py|application\.properties|web\.config|phpinfo|wlwmanifest\.xml|wp-sitemap-users-\d+\.xml)$/i;

/** Whether a path is one only a scanner would ask for. */
export function isProbe(pathname) {
  let path = pathname || '';
  try {
    path = decodeURIComponent(path);
  } catch {
    // A path that does not decode is left as it came; the raw form still matches.
  }
  const segments = path.split('/').filter(Boolean);
  if (!segments.length) return false;
  const last = segments[segments.length - 1];
  if (/\.php$/i.test(last) || PROBE_FILE_RE.test(last)) return true;
  if (/^manifest\.json$/i.test(last) && segments.some((s) => /^(?:build|dist)$/i.test(s))) return true;
  return segments.some((segment, i) => {
    if (PROBE_SEGMENT_RE.test(segment)) return true;
    // wp-content is a probe unless it is the uploads folder, where the old
    // site's pictures lived and where a real broken link lands.
    return /^wp-content$/i.test(segment) && !/^uploads$/i.test(segments[i + 1] || '');
  });
}

const LIMITS = { path: 300, referrerUrl: 300, utm: 100, botName: 60, lang: 12, place: 80 };

const cut = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : null);
const blank = (value) => (value ? value : null);

export function isBot(userAgent) {
  return !userAgent || BOT_RE.test(userAgent);
}

/** A short, stable label for a crawler, e.g. "googlebot" or "curl". */
export function botName(userAgent, verifiedCategory) {
  if (verifiedCategory) return cut(verifiedCategory.toLowerCase(), LIMITS.botName);
  if (!userAgent) return 'no user agent';
  const named = userAgent.match(/([a-z0-9_.-]*(?:bot|spider|crawler)[a-z0-9_.-]*)/i);
  if (named) return cut(named[1].toLowerCase(), LIMITS.botName);
  const product = userAgent.match(/^([a-z0-9_.-]+)/i);
  return cut((product ? product[1] : 'unknown').toLowerCase(), LIMITS.botName);
}

export function deviceOf(ua) {
  if (/ipad|tablet|kindle|silk|playbook/i.test(ua)) return 'tablet';
  if (/android/i.test(ua) && !/mobile/i.test(ua)) return 'tablet';
  if (/mobi|iphone|ipod|android|windows phone|blackberry|opera mini/i.test(ua)) return 'mobile';
  return 'desktop';
}

export function browserOf(ua) {
  if (/edg(e|a|ios)?\//i.test(ua)) return 'Edge';
  if (/opr\/|opera/i.test(ua)) return 'Opera';
  if (/samsungbrowser/i.test(ua)) return 'Samsung Internet';
  if (/firefox|fxios/i.test(ua)) return 'Firefox';
  if (/duckduckgo/i.test(ua)) return 'DuckDuckGo';
  if (/brave/i.test(ua)) return 'Brave';
  if (/vivaldi/i.test(ua)) return 'Vivaldi';
  if (/crios|chrome|chromium/i.test(ua)) return 'Chrome';
  if (/safari/i.test(ua)) return 'Safari';
  if (/msie|trident/i.test(ua)) return 'Internet Explorer';
  return 'Other';
}

export function osOf(ua) {
  if (/iphone|ipad|ipod/i.test(ua)) return 'iOS';
  if (/android/i.test(ua)) return 'Android';
  if (/windows/i.test(ua)) return 'Windows';
  if (/cros/i.test(ua)) return 'ChromeOS';
  if (/mac os x|macintosh/i.test(ua)) return 'macOS';
  if (/linux/i.test(ua)) return 'Linux';
  return 'Other';
}

/** The first tag of Accept-Language, lowercased: "en-gb", "de", "fr-ch". */
export function languageOf(header) {
  const first = (header || '').split(',')[0].split(';')[0].trim().toLowerCase();
  return blank(cut(first, LIMITS.lang));
}

const stripWww = (host) => host.replace(/^www\./, '');

/** The referrer, or nulls when it is this site itself or unparseable. */
export function referrerOf(header, ownHost) {
  if (!header) return { referrer: null, referrerUrl: null };
  let parsed;
  try {
    parsed = new URL(header);
  } catch {
    return { referrer: null, referrerUrl: null };
  }
  const host = stripWww(parsed.hostname.toLowerCase());
  if (!host || host === stripWww(ownHost.toLowerCase())) {
    return { referrer: null, referrerUrl: null };
  }
  // Query strings on referrers are mostly tracking noise and occasionally
  // someone else's session token, so keep origin and path only.
  const url = `${parsed.origin}${parsed.pathname}`;
  return { referrer: host, referrerUrl: cut(url, LIMITS.referrerUrl) };
}

/**
 * Whether this request and response are a page a person was served. Images,
 * API calls, the dashboard, redirects, prefetches and anything that is not
 * HTML are left out; a 404 page is kept, since broken links are worth seeing.
 */
export function shouldRecord(request, response, skipPrefixes = []) {
  if (request.method !== 'GET') return false;
  const path = new URL(request.url).pathname;
  if (skipPrefixes.some((prefix) => path.startsWith(prefix))) return false;
  if (response.status !== 200 && response.status !== 404) return false;
  const type = response.headers.get('content-type') || '';
  if (!type.includes('text/html')) return false;
  const purpose = request.headers.get('sec-purpose') || request.headers.get('purpose') || '';
  if (/prefetch|prerender/i.test(purpose)) return false;
  const dest = request.headers.get('sec-fetch-dest');
  if (dest && dest !== 'document') return false;
  return true;
}

const encoder = new TextEncoder();
export const hex = (buffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

export async function hmac(secret, message) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  return hex(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
}

// One key per UTC day, derived from the secret, cached per isolate. The map
// is emptied whenever the day rolls over so it never grows. Keyed on the
// secret as well as the day, so a rotated password takes effect at once.
const dayKeys = new Map();
async function dayKey(secret, day) {
  const id = `${day}|${secret || ''}`;
  if (!dayKeys.has(id)) {
    dayKeys.clear();
    dayKeys.set(id, secret ? await hmac(secret, `visitor|${day}`) : `visitor|${day}|nosecret`);
  }
  return dayKeys.get(id);
}

export const dayOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);

/** A one-way, daily-rotating identifier. Sixteen hex characters, nothing else. */
export async function visitorHash(secret, day, ip, userAgent) {
  const key = await dayKey(secret, day);
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`${key}|${ip}|${userAgent}`));
  return hex(digest).slice(0, 16);
}

/** Everything the row will hold, read off the request. Pure apart from the hash. */
export async function describe(request, response, env, now = Date.now(), { probes = true } = {}) {
  const url = new URL(request.url);
  const ua = request.headers.get('user-agent') || '';
  const cf = request.cf || {};
  const ts = Math.floor(now / 1000);
  const day = dayOf(ts);
  const verified = cf.verifiedBotCategory || null;
  const probe = probes && isProbe(url.pathname);
  const bot = Boolean(verified) || probe || isBot(ua);
  const { referrer, referrerUrl } = referrerOf(request.headers.get('referer'), url.hostname);
  const ip = request.headers.get('cf-connecting-ip') || '';
  const utm = (name) => blank(cut(url.searchParams.get(name), LIMITS.utm));

  return {
    ts,
    day,
    bot,
    // A verified crawler keeps its own name wherever it goes; anything else on
    // a probe path is a scanner whatever its user agent claims.
    botName: !bot ? null : probe && !verified ? 'scanner' : botName(ua, verified),
    visitor: bot ? null : await visitorHash(env.ANALYTICS_PASSWORD, day, ip, ua),
    path: cut(url.pathname, LIMITS.path),
    status: response.status,
    referrer,
    referrerUrl,
    utmSource: utm('utm_source'),
    utmMedium: utm('utm_medium'),
    utmCampaign: utm('utm_campaign'),
    country: blank(cf.country || request.headers.get('cf-ipcountry')),
    region: blank(cut(cf.region, LIMITS.place)),
    city: blank(cut(cf.city, LIMITS.place)),
    device: deviceOf(ua),
    browser: browserOf(ua),
    os: osOf(ua),
    lang: languageOf(request.headers.get('accept-language')),
  };
}

const INSERT_PAGEVIEW = `INSERT INTO pageviews
  (ts, visitor, path, status, referrer, referrer_url, utm_source, utm_medium, utm_campaign,
   country, region, city, device, browser, os, lang)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

const COUNT_BOT = `INSERT INTO bot_hits (day, name, hits) VALUES (?, ?, 1)
  ON CONFLICT (day, name) DO UPDATE SET hits = hits + 1`;

const INSERT_EVENT = `INSERT INTO events (ts, visitor, type, detail, path) VALUES (?, ?, ?, ?, ?)`;

/** Write one row for this response. Never throws; without a database it is a no-op. */
export async function writePageview(request, response, env, config = {}) {
  const db = env.ANALYTICS_DB;
  if (!db) return null;
  try {
    const row = await describe(request, response, env, Date.now(), config);
    if (row.bot) {
      await db.prepare(COUNT_BOT).bind(row.day, row.botName).run();
    } else {
      await db.prepare(INSERT_PAGEVIEW).bind(
        row.ts, row.visitor, row.path, row.status, row.referrer, row.referrerUrl,
        row.utmSource, row.utmMedium, row.utmCampaign, row.country, row.region, row.city,
        row.device, row.browser, row.os, row.lang,
      ).run();
    }
    return row;
  } catch (error) {
    console.error('analytics: could not record pageview', error);
    return null;
  }
}

/** Log a page after it has been served, off the response path. */
export function recordPageview(request, response, env, ctx, config = {}) {
  if (!env.ANALYTICS_DB || !shouldRecord(request, response, config.skipPrefixes)) return;
  const work = writePageview(request, response, env, config);
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
}

/** Log something a visitor did, e.g. an enquiry. Same guarantees as above. */
export function recordEvent(request, env, ctx, type, detail) {
  const db = env.ANALYTICS_DB;
  if (!db) return;
  const work = (async () => {
    try {
      const ts = Math.floor(Date.now() / 1000);
      const ua = request.headers.get('user-agent') || '';
      const ip = request.headers.get('cf-connecting-ip') || '';
      const visitor = await visitorHash(env.ANALYTICS_PASSWORD, dayOf(ts), ip, ua);
      const from = request.headers.get('referer');
      let path = null;
      try {
        path = from ? cut(new URL(from).pathname, LIMITS.path) : null;
      } catch {
        path = null;
      }
      await db.prepare(INSERT_EVENT).bind(ts, visitor, type, cut(detail, 200), path).run();
    } catch (error) {
      console.error('analytics: could not record event', error);
    }
  })();
  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(work);
}
