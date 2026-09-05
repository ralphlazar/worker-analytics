// The per-site options, checked once at startup so a mistake is loud at
// deploy time rather than silent in production.

const slug = (text) =>
  String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'site';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function fail(message) {
  throw new Error(`createAnalytics: ${message}`);
}

/**
 * Normalise and validate the options `createAnalytics` accepts.
 *
 *   siteName      shown on the login page, the dashboard and the CSV name.
 *                 Defaults to the request's hostname.
 *   prefix        where the dashboard lives. Default "/analytics".
 *   cookieName    the session cookie. Default "analytics_session".
 *   skipPrefixes  paths never recorded, e.g. ["/images/", "/api/"]. The
 *                 dashboard prefix is always skipped.
 *   panels        extra dashboard panels, one per path prefix:
 *                 [{ title: "Projects", prefix: "/projects/" }].
 *   events        event types counted as KPIs and listed in a panel:
 *                 [{ type: "enquiry", label: "Enquiries", description: "..." }].
 *   launchDate    "YYYY-MM-DD"; the start of the dashboard's "All" range.
 *   titlesUrl     optional URL of a JSON array of { href, title } used to
 *                 label pages in the dashboard.
 *   probes        whether requests for files only a scanner asks for are
 *                 counted as a crawler named "scanner". Default true.
 */
export function resolveOptions(options = {}) {
  if (options === null || typeof options !== 'object') fail('options must be an object');

  const prefix = String(options.prefix ?? '/analytics').replace(/\/+$/, '');
  if (!/^\/[^/?#]+/.test(prefix)) fail(`prefix must be a path like "/analytics", got "${options.prefix}"`);

  const panels = (options.panels ?? []).map((panel, i) => {
    if (!panel || typeof panel !== 'object') fail(`panels[${i}] must be an object`);
    if (typeof panel.prefix !== 'string' || !panel.prefix.startsWith('/')) fail(`panels[${i}] needs a prefix starting with "/"`);
    if (!panel.title) fail(`panels[${i}] needs a title`);
    return {
      key: panel.key ? String(panel.key) : slug(panel.title),
      title: String(panel.title),
      prefix: panel.prefix,
      description: panel.description ? String(panel.description) : '',
    };
  });

  const events = (options.events ?? []).map((event, i) => {
    const type = typeof event === 'string' ? event : event && event.type;
    if (!type) fail(`events[${i}] needs a type`);
    const given = typeof event === 'object' ? event : {};
    return {
      type: String(type),
      label: given.label ? String(given.label) : String(type),
      description: given.description ? String(given.description) : '',
    };
  });

  const launchDate = options.launchDate == null ? null : String(options.launchDate);
  if (launchDate !== null && !DATE.test(launchDate)) fail(`launchDate must be YYYY-MM-DD, got "${launchDate}"`);

  const skipPrefixes = [...new Set([prefix, ...(options.skipPrefixes ?? []).map(String)])];

  return {
    siteName: options.siteName ? String(options.siteName) : '',
    prefix,
    cookieName: options.cookieName ? String(options.cookieName) : 'analytics_session',
    skipPrefixes,
    panels,
    events,
    launchDate,
    titlesUrl: options.titlesUrl ? String(options.titlesUrl) : null,
    probes: options.probes !== false,
  };
}

export { slug };
