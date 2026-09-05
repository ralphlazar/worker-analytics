# worker-analytics

First-party traffic analytics for a Cloudflare Worker or Pages project. The
server already runs on every request, so it writes down what it serves:
nothing runs in the visitor's browser, no cookie is set, and the data is
yours, in a D1 database, with no retention limit. A password-gated dashboard
reads it back. Optionally, the words people typed into Google to reach the
site, from Search Console (see "Google searches"). No dependencies.

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
visitors. So is anything wearing a browser user agent without a browser behind
it: every real browser sends `Accept-Language`, and every modern one (Chrome
and Edge since 76, Firefox since 90, Safari and iOS since 16.4) sends the
`Sec-Fetch` headers on a page navigation, so a request that claims one of
those and sends neither is a crawler named `fake browser`. Older browsers that
never sent them are judged on `Accept-Language` alone. On one site's first day
this was six in ten recorded page views. When you test a visit with curl,
send what a browser sends beside the user agent, `-H 'Accept-Language: en-GB'
-H 'Sec-Fetch-Mode: navigate' -H 'Sec-Fetch-Dest: document'`, or the visit is
counted as a fake browser, which is the rule working. So are scanner probes: a request for `/.env`, `/wp-login.php`,
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
npm install github:ralphlazar/worker-analytics#v0.2.1
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
    if (analytics.matches(url.pathname)) return analytics.handle(request, env, ctx);

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

A Pages project has no `fetch` export, but a Pages Function middleware runs
on every request the project routes to Functions, and its `context` carries
the `waitUntil` the recorder needs. So the same three calls hang off
`functions/_middleware.js`:

```js
import { createAnalytics } from 'worker-analytics';

const analytics = createAnalytics({ siteName: 'example.com', skipPrefixes: ['/assets/'] });

export async function onRequest(context) {
  const { request, env } = context;
  if (analytics.matches(new URL(request.url).pathname)) return analytics.handle(request, env, context);

  const response = await context.next();
  analytics.recordPageview(request, response, env, context); // off the response path
  return response;
}
```

If that middleware already gates the site, decide where the dashboard sits:
matching the prefix before the gate leaves it behind the package's own
password wall alone; matching after it puts it behind both.

What differs from a Worker:

- **Every included request is a Function invocation**, and invocations count
  against the Workers request allowance (100,000 a day on the free plan).
  Without a `_routes.json` Pages derives one from the functions directory,
  and a root middleware makes that "everything", images included. So write
  a `_routes.json` into the build output: include `/*`, exclude the trees
  that hold only assets, keep every path another Function answers inside
  the include. Wildcards are trailing only, 100 rules at most, and
  `exclude` wins over `include`. The collector skips non-HTML responses
  anyway; the exclusions just keep the invocations down.

  ```json
  { "version": 1, "include": ["/*"], "exclude": ["/assets/*", "/images/*", "/robots.txt", "/sitemap.xml", "/favicon.ico"] }
  ```

- **`_redirects` keep working.** Cloudflare documents that redirect rules
  are not applied to requests a Function serves, but a rule is applied when
  the middleware hands the request on with `context.next()`: checked on a
  live domain with forty-two rules, locally under `wrangler pages dev` and
  in production.
- **Bindings, two ways.** A Git-connected project without a wrangler config
  keeps them on the Pages project under its Functions settings, for
  Production and Preview: the D1 database as `ANALYTICS_DB`, the password as
  `ANALYTICS_PASSWORD` (`npx wrangler pages secret put ANALYTICS_PASSWORD
  --project-name <project>` sets production). Adding a wrangler config to
  such a project moves the source of truth for bindings into the file, so do
  not add one for this alone; apply the schema once with `npx wrangler d1
  execute <db> --remote --file=migrations/0001_analytics.sql`. A project that
  already has a `wrangler.toml` with `pages_build_output_dir` (the
  direct-upload kind) adds the `[[d1_databases]]` block from step 1 with
  `migrations_dir = "migrations"`, and `wrangler d1 migrations apply` then
  works as for a Worker. Secrets set in the dashboard or with `wrangler
  pages secret put` survive deploys from such a file; plaintext `[vars]` are
  the thing not to add unless the file is meant to own them.
- **Installing the package.** Git-connected: add a `package.json` naming
  this package at a tag, commit the lockfile, and set the project's build
  command to `if [ -f package-lock.json ]; then npm ci; fi`. With no build
  command Pages skips dependency installation entirely and the Functions
  build fails with "Could not resolve worker-analytics"; once any build
  command exists Pages installs before running it, so the explicit `npm ci`
  is belt and braces, and the guard keeps a commit without a lockfile
  buildable. Direct upload: `wrangler pages deploy` bundles the Functions
  locally and resolves the package from the project's own `node_modules`, so
  run `npm install` there first. Deploying from a checkout on any branch
  other than the production branch, pass `--branch=<production branch>`, or
  the deploy lands as an unlisted preview with no error to say so.
- **Local check.** `npx wrangler pages dev <output dir> --port <free port>`
  reads `.dev.vars` and the bindings from `wrangler.toml`; apply the
  migration to the local database first with `--local`, and log in with
  curl rather than by typing the password into a browser.
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
| `fakeBrowsers` | `true` | Count a browser user agent that sends none of what a browser sends as a crawler named `fake browser` |
| `searchConsole` | off | `{ secret, site?, property? }`: the Google searches panels, see below |

Options are checked once at startup and a mistake throws, so a bad
configuration fails the deploy rather than the dashboard.

## Google searches

The words people typed into Google to reach the site have exactly one
source. Google stopped sending search terms in the referrer in 2013: a
visitor from Google arrives carrying `google.com` and nothing else, on every
site in the world, so no analytics tool sees the words that way. Search
Console's Performance data has them, published two to three days late, kept
for sixteen months, and trimmed: rare searches are withheld, so its totals
run below the real click count. The dashboard says so under the panels.
(Bing Webmaster Tools offers the same for Bing; not done.)

The module is optional and lives in `src/search-console.js`
(`worker-analytics/search-console`). Switch it on with one option:

```js
createAnalytics({ siteName: 'example.com', searchConsole: { secret: 'GSC_SERVICE_ACCOUNT' } });
```

`secret` names the env var holding a Google service-account JSON. `site`
(default: `siteName`, else the request's host) is the host whose property to
read; a domain property `sc-domain:<host>` is preferred to the URL-prefix
form, or pin one with `property`. Copy `migrations/0002_search_console.sql`
next to the first migration and apply it: three tables, `search_queries`
and `search_pages` keyed by day, and `search_sync` for the state. Pass `ctx`
(or the Pages `context`) as the third argument of `handle`: the refresh runs
inside its `waitUntil`.

Refresh is on demand, since Pages has no cron. When the dashboard API is
called and the last refresh is over an hour old, the last seven days are
pulled again (final figures lag and get revised). On the very first run the
sixteen months Google keeps are backfilled in monthly chunks, newest first,
six months a call so no call outlives the runtime's budget for background
work; the dashboard's own polling brings the next chunk in, so leave it
open for a few minutes the first time. Rows are upserted by day, so a
refresh never duplicates and a revised day replaces itself. A failure is
written to `search_sync.last_error`, shown under the panel, and retried
after five minutes; without the secret the panel says "Not connected"; in
every case the rest of the dashboard is unaffected.

The dashboard gains two panels, "Google searches" (query, clicks,
impressions, average position) and "Search landing pages", ten rows paged
like the rest, with one line beneath: "From Google Search Console. Final
figures arrive two to three days late and rare searches are withheld."

The site owner's part, once, in their Google account:

1. In [Search Console](https://search.google.com/search-console), add the
   site as a Domain property if it is not there, prove ownership with the
   TXT record Google gives (added at the DNS host), and wait for "verified".
2. In [Google Cloud](https://console.cloud.google.com), create a project,
   enable the "Google Search Console API", create a service account under
   Credentials, and download a JSON key for it.
3. Back in Search Console, Settings, Users and permissions: add the service
   account's email (it ends in `iam.gserviceaccount.com`) with Full
   permission.
4. Store the whole JSON as the secret (`npx wrangler pages secret put
   GSC_SERVICE_ACCOUNT --project-name <project>`, or `wrangler secret put`
   for a Worker), and on one line in single quotes in `.dev.vars` for local
   work. Then delete the download. Never commit it, never quote it.

How it talks to Google: a JWT (RS256 under the account's key, imported as
PKCS8; `iss` the account email, scope
`https://www.googleapis.com/auth/webmasters.readonly`, `aud` the token
endpoint, one hour) is posted as a `jwt-bearer` grant for an access token;
`GET .../webmasters/v3/sites` finds the property; `POST
.../sites/{siteUrl}/searchAnalytics/query` with dimensions `date, query`
and separately `date, page`, `rowLimit` 25000, paged by `startRow`,
`dataState` `final`. The tests run all of it against a mocked Google, with
the JWT verified under the matching public key.

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

Forty-four tests in two files, guards checked by tripping them: the collector never
writes an address, leaves crawlers and probes out of the visitor count, and
fails silently rather than taking the page down; the report arithmetic is
right on hand-built rows; the dashboard fails closed with no password and
refuses a wrong one; options are validated; the served page carries the
site's configuration safely escaped; and the package's own hygiene holds:
nothing site-specific, no em or en dashes, `[hidden]` first in the
stylesheet, and a LICENSE that agrees with package.json. The Search Console
file signs a real JWT and verifies it under the matching public key, pages
rows the way Google pages them, upserts by day, backfills before it settles
into the hourly rhythm, and turns a missing secret, a missing table and a
Google error into text rather than a failure.
