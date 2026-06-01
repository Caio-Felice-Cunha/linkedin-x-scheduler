'use strict';

/**
 * Reschedule runner — change the scheduled TIME of existing X posts in place
 * (no delete, no re-create), reusing the same manifest. Each post is matched in
 * the live scheduled queue by its first line and moved to its manifest
 * `scheduledAt`. X-only for now (LinkedIn reschedule is a roadmap item).
 *
 * Dry-run (default) sets + verifies the new time in the overlay without saving;
 * --live saves it. A G3 live-publish detection aborts the run.
 */

const { XAdapter } = require('./platforms/x');
const { LivePublishError } = require('./platforms/linkedin');

/**
 * Run a reschedule over a batch's posts.
 *
 * @param {object} params
 * @param {import('./core').SchedulerCore} params.core - the run context
 * @param {Array<{postId:string, platform:string, target:string, firstLine:string}>} params.packets
 * @param {?string} [params.only] - restrict to one postId
 * @param {object} [deps]
 * @param {Function} [deps.connectFn] - injected connect (tests)
 * @param {object} [deps.xAdapter] - injected X adapter (tests)
 * @returns {Promise<{outcome:string, results:object[], summary:object}>}
 */
async function runReschedule({ core, packets, only }, deps = {}) {
  core.startRun();

  if (deps.connectFn) {
    const r = await deps.connectFn();
    core.browser = r.browser;
    core.context = r.context;
    core.page = r.page;
  } else {
    await core.connect();
  }

  const targets = packets.filter((p) => !only || p.postId === only);
  const xPackets = targets.filter((p) => p.platform === 'x');
  const otherPackets = targets.filter((p) => p.platform !== 'x');

  const results = [];
  if (xPackets.length > 0) {
    // Throws SessionError if not logged in — surfaced to the caller as an abort.
    await core.assertLoggedIn('x');
  }

  const x = deps.xAdapter || new XAdapter(core);
  let aborted = false;
  for (const packet of xPackets) {
    if (aborted) {
      results.push({ postId: packet.postId, status: 'not-attempted' });
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await x.reschedulePost(packet);
      results.push(r);
      core.runLog.append({ postId: packet.postId, action: 'reschedule-result', result: r.status, detail: r.reason || r.scheduledLocalTime });
    } catch (err) {
      if (err instanceof LivePublishError || err.critical) {
        results.push({ postId: packet.postId, status: 'failed', reason: `G3 live-publish: ${err.message}` });
        core.runLog.append({ postId: packet.postId, action: 'reschedule', result: 'G3-ABORT', detail: err.message });
        aborted = true;
      } else {
        results.push({ postId: packet.postId, status: 'failed', reason: String(err.message).split('\n')[0] });
      }
    }
  }

  for (const p of otherPackets) {
    results.push({ postId: p.postId, status: 'skipped', reason: 'reschedule supports X only for now' });
  }

  const verified = results.filter((r) => r.status === 'verified').length;
  const failed = results.filter((r) => r.status === 'failed').length;
  const unverified = results.filter((r) => r.status === 'scheduled-unverified').length;
  const outcome = aborted ? 'aborted' : failed > 0 ? 'partial' : 'complete';
  return { outcome, results, summary: { total: results.length, verified, failed, unverified } };
}

module.exports = { runReschedule };
