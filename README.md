# worker-analytics

First-party traffic analytics for a Cloudflare Worker. The Worker already
runs on every request, so it writes down what it serves: nothing runs in the
visitor's browser, no cookie is set, and the data is yours, in a D1 database,
with no retention limit. A password-gated dashboard reads it back. No
dependencies.

Built for one site and extracted so the other Worker sites get the same
thing with the same guarantees, and so a fix made once reaches all of them.

## What it records

One row per page a person is served: path, status (200 and 404 only, so
broken links show), external referrer, UTM tags, country, region and city
from `request.cf`, device, browser, OS, language, and a visitor that is a
one-way HMAC of address and user agent keyed on the day and the password.
**The address is never written.** The same person counts once per day and
nothing stored can be turned back into who they were.

Crawlers are counted per day in a `bot_hits` table, never logged as
visitors. So are scanner probes: a request for `/.env`, `/wp-login.php`,
`/.git/config` and the rest of the leaked-secrets checklist is a crawler
named `scanner` whatever its user agent claims, because scanners claim to be
browsers and would otherwise be half the visitor count. Images, APIs, the
dashboard itself, redirects, prefetches and non-HTML responses are skipped.

Every write is off the response path inside `ctx.waitUntil` and wrapped, so a
dead database cannot slow or break a page. That contract is the reason the
analytics are allowed on a site at all.

The dashboard is gated on `ANALYTICS_PASSWORD` and **fails closed**: with no
secret, every route answers 503. Five wrong passwords lock an address for
fifteen minutes. The session cookie is an HMAC under the password, so
rotating the password logs everyone out. Rotating it also changes that day's
visitor hashes, since they are keyed on it.

## Install

```bash
npm install github:ralphlazar/worker-analytics#v0.1.3
```

The repo is public, so npm needs no credentials: for a GitHub tag it fetches
the tarball over https, and a build machine with no git identity installs it
the same way. Pin a tag, never a branch, so a site only moves when someone
moves it. To move to a newer tag, change the spec and run
`npm uninstall worker-analytics && npm install`, then check the lockfile's
resolved commit: a plain `npm install` after a tag bump keeps the old commit
in the lock and ships the old code.

MIT licensed; see LICENSE.

## Wire it into a Worker

Ten lines, in three places.

**1. The database.** Create it and bind it as `ANALYTICS_DB` with a
migrations directory:

```bash
npx wrangler d1 create <project>-analytics
```

```jsonc
// wrangler.jsonc
"d1_databases": [
  { "binding": "ANALYTICS_DB", "database_name": "<project>-analytics",
    "database_id": "<id from the create command>", "migrations_dir": "./migrations" }
],
```

Copy `migrations/0001_analytics.sql` from this package into that directory,
with a comment saying where it came from, and apply it:

```bash
npx wrangler d1 migrations apply <project>-analytics --local
npx wrangler d1 migrations apply <project>-analytics --remote
```

A schema change is a new numbered migration that every consumer copies. Never
edit an applied one.

**2. Static assets.** If the Worker serves static assets, set
`"run_worker_first": true` under `assets`. Without it Cloudflare answers
asset requests before the Worker runs, nothing is counted, and nothing tells
you so.

**3. The Worker.** One instance at module load, then three calls:

```js
import { createAnalytics } from 'worker-analytics';

const analytics = createAnalytics({
  siteName: 'example.com',
  skipPrefixes: ['/images/', '/api/'],
  panels: [{ title: 'Posts', prefix: '/posts/' }],
  events: [{ type: 'signup', label: 'Sign-ups', description: 'through the form' }],
  launchDate: '2026-09-01',
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (analytics.matches(url.pathname)) return analytics.handle(request, env);

    const response = await env.ASSETS.fetch(request);
    analytics.recordPageview(request, response, env, ctx); // off the response path
    return response;
  },
};
```

Route the dashboard prefix before everything else. Call the recorder after
the response is produced, never before. If the site has a form that reaches
you, log a delivered submission as an event carrying what it concerned,
never the message:

```js
analytics.recordEvent(request, env, ctx, 'signup', 'newsletter');
```

**4. The password.** Long and random, set once, written down once:

```bash
openssl rand -base64 32
npx wrangler secret put ANALYTICS_PASSWORD
```

Put the same value in `.dev.vars` for local work and make sure `.dev.vars`
is gitignored. It goes nowhere else.

**5. robots.txt.** Add `Disallow: /analytics/` (or whatever prefix you chose).

**6. Deploy and verify on the real domain**, not on a build:

- a stranger at `/analytics/` gets 401 and the login page;
- a browser-like visit to a real page lands in the production database
  within a minute (`npx wrangler d1 execute <db> --remote --json --command
  "SELECT ..."`; `--file` against a remote database returns only a row
  count, not the rows);
- a curl visit lands in `bot_hits`, not in `pageviews`;
- the site's own pages, images and redirects answer exactly as before.

## Wire it into Cloudflare Pages

A Pages project has no `fetch` export, but a Pages Function middleware runs on
every request (when there is no `_routes.json`), and its `context` carries the
`waitUntil` the recorder needs. So the same three calls hang off
`functions/_middleware.js`:

```js
import { createAnalytics } from 'worker-analytics';

const analytics = createAnalytics({ siteName: 'example.com' });

export async function onRequest(context) {
  const { request, env } = context;
  if (analytics.matches(new URL(request.url).pathname)) return analytics.handle(request, env);

  const response = await context.next();
  analytics.recordPageview(request, response, env, context); // off the response path
  return response;
}
```

If that middleware already gates the site, decide where the dashboard sits:
matching the prefix before the gate leaves it behind the package's own
password wall alone; matching after it puts it behind both.

What differs from a Worker:

- **Bindings live on the Pages project**, under its Functions settings, for
  Production and Preview: the D1 database as `ANALYTICS_DB` and the password
  as `ANALYTICS_PASSWORD`
  (`npx wrangler pages secret put ANALYTICS_PASSWORD --project-name <project>`
  sets production). Do not add a wrangler config for this alone: on Pages it
  takes every binding over from the dashboard. There is no migrations
  directory either; apply the schema once with
  `npx wrangler d1 execute <db> --remote --file=migrations/0001_analytics.sql`.
- **Set a build command.** Add a `package.json` naming this package at a tag,
  commit the lockfile, and set the project's build command to
  `if [ -f package-lock.json ]; then npm ci; fi`. With no build command Pages
  skips dependency installation entirely and the Functions build fails with
  "Could not resolve worker-analytics". Once any build command exists Pages
  installs before running it, so the explicit `npm ci` is belt and braces, and
  the guard keeps a commit without a lockfile buildable.
- **No `run_worker_first`.** Functions already run before static assets.
- **Preview deployments write to the same database** as production when both
  environments carry the binding.
- **A site without a `404.html`** serves its index at 200 for an unknown path,
  so such a visit is recorded under the path asked for and the broken-links
  panel stays empty. Add a `404.html` to get real 404s.

## Options

| Option | Default | What it does |
|---|---|---|
| `siteName` | the request's hostname | Shown on the login page, the dashboard and the CSV filename |
| `prefix` | `/analytics` | Where the dashboard and its API live |
| `cookieName` | `analytics_session` | The session cookie |
| `skipPrefixes` | `[]` | Paths never recorded. The dashboard prefix is always skipped |
| `panels` | `[]` | Extra dashboard panels, one per path prefix: `{ title, prefix, description? }` |
| `events` | `[]` | Event types shown as KPIs and listed in a panel: `{ type, label?, description? }` |
| `launchDate` | none | `YYYY-MM-DD`; the start of the dashboard's "All" range |
| `titlesUrl` | none | URL of a JSON array of `{ href, title }` used to label pages |
| `probes` | `true` | Count scanner probes as a crawler named `scanner` |

Options are checked once at startup and a mistake throws, so a bad
configuration fails the deploy rather than the dashboard.

## The dashboard

`src/dashboard.html` is the page. `src/dashboard.js` is the same page as a
JS module exporting the string, generated by `npm run build` and committed,
so a consumer needs no wrangler `rules` entry to import HTML. `npm test`
refuses to run if the module is stale. Per-site configuration is injected
when the page is served, through three placeholders, so nothing is baked in.

One rule in the stylesheet is load-bearing: `[hidden]{display:none!important}`
stays first. Any author `display` rule otherwise beats the attribute, and
every panel shows all of its rows instead of ten.

## Tests

```bash
npm test
```

Thirty-six tests, guards checked by tripping them: the collector never
writes an address, leaves crawlers and probes out of the visitor count, and
fails silently rather than taking the page down; the report arithmetic is
right on hand-built rows; the dashboard fails closed with no password and
refuses a wrong one; options are validated; the served page carries the
site's configuration safely escaped; and the package's own hygiene holds:
nothing site-specific, no em or en dashes, `[hidden]` first in the
stylesheet, and a LICENSE that agrees with package.json.
