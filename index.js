// worker-analytics: first-party traffic analytics for a Cloudflare Worker.
//
// One factory does the wiring. Everything else is exported for tests and for
// anyone who wants a piece of it without the rest.
//
//   import { createAnalytics } from 'worker-analytics';
//   const analytics = createAnalytics({ siteName: 'example.com' });
//   ...
//   if (analytics.matches(url.pathname)) return analytics.handle(request, env);
//   const response = await env.ASSETS.fetch(request);
//   analytics.recordPageview(request, response, env, ctx);
//   return response;

export { createAnalytics } from './src/analytics.js';
export { resolveOptions } from './src/config.js';
export {
  isBot, botName, isProbe, isFakeBrowser, deviceOf, browserOf, osOf, languageOf, referrerOf, shouldRecord,
  visitorHash, describe, writePageview, recordPageview, recordEvent, hmac, hex, dayOf,
} from './src/collect.js';
export {
  sessionsOf, totalsOf, series, weekGrid, aggregate, buildReport, buildCsv, bucketFor,
  loadRows, loadBots, loadEvents, loadLive, SESSION_GAP,
} from './src/report.js';
export { createAnalyticsHandler, parseRange, renderDashboard } from './src/routes.js';
export {
  createSearchConsole, parseCredentials, signJwt, fetchAccessToken, findProperty, fetchRows, upsertRows, readSync,
} from './src/search-console.js';
export { default as dashboardHtml } from './src/dashboard.js';
