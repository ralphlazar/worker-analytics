// The retention Worker: a daily Cron Trigger that rolls each settled day of
// pageviews into the day summaries and then deletes pageview rows past the
// retention limit. All of the work, and every guard on it, is in
// ../src/rollup.js; this file only connects it to a schedule.
//
// It is a Worker of its own because a Pages Function has no scheduled handler.
// It has no fetch handler and no public URL (workers_dev is off in
// wrangler.jsonc): nothing on the internet can start it, and it reads and
// writes only the D1 database bound as ANALYTICS_DB, the same one the site
// writes its pageviews to.
//
// It is safe to run twice, and a failed run changes nothing it half-did, so
// whatever goes wrong the next night starts clean. A run that finds a problem
// logs it as an error and throws, so the invocation shows as failed in the
// Cloudflare dashboard instead of looking like a quiet night.

import { runRollup, problemsOf } from '../src/rollup.js';

export default {
  async scheduled(controller, env) {
    const db = env.ANALYTICS_DB;
    if (!db) throw new Error('analytics rollup: no ANALYTICS_DB binding, so there is nothing to roll up or delete');

    // The time this run was scheduled for, so a run started by hand with a time
    // of its own (wrangler dev, ?time=) behaves as if it were that night's.
    const scheduled = controller && Number.isFinite(controller.scheduledTime) ? controller.scheduledTime : Date.now();
    const report = await runRollup(db, { now: Math.floor(scheduled / 1000) });
    const problems = problemsOf(report);

    const line = JSON.stringify({
      event: 'analytics-rollup',
      ok: problems.length === 0,
      today: report.today,
      settledThrough: report.settledThrough,
      keepFrom: report.keepFrom,
      summarised: report.summarised,
      waiting: report.deferred.length,
      deleted: report.deleted,
      queries: report.queries,
      problems,
    });
    if (problems.length) {
      console.error(line);
      throw new Error(`analytics rollup: ${problems.join('; ')}`);
    }
    console.log(line);
  },
};
