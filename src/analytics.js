// The factory. One call at module load, then four things to use:
//
//   analytics.matches(pathname)                     is this a dashboard request
//   analytics.handle(request, env)                  answer it
//   analytics.recordPageview(request, response, env, ctx)   after each response
//   analytics.recordEvent(request, env, ctx, type, detail)  something a visitor did

import { resolveOptions } from './config.js';
import { recordEvent, recordPageview } from './collect.js';
import { createAnalyticsHandler } from './routes.js';

export function createAnalytics(options = {}) {
  const config = resolveOptions(options);
  const handle = createAnalyticsHandler(config);
  return {
    config,
    prefix: config.prefix,
    matches: (pathname) => pathname === config.prefix || pathname.startsWith(`${config.prefix}/`),
    handle,
    recordPageview: (request, response, env, ctx) => recordPageview(request, response, env, ctx, config),
    recordEvent: (request, env, ctx, type, detail) => recordEvent(request, env, ctx, type, detail),
  };
}
