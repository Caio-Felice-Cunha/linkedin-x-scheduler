'use strict';

/**
 * Batch orchestrator + safety layer.
 *
 * Runs a full batch in a safe order, one post at a time, driving the per-post
 * state machine through the platform adapters, enforcing the scheduled-vs-live
 * abort across the WHOLE batch, resuming idempotently from the state file +
 * live queue, and emitting a final report.
 *
 * The one non-negotiable safety property: the default outcome of a run is
 * "nothing was published live". A live-publish from ANY adapter STOPS the
 * entire batch immediately, alerts the operator, and offers to delete the live
 * post.
 *
 * Execution order, derived from metadata not hard-coded ids:
 *   LinkedIn document (LI-CAROUSEL) → LinkedIn image (LI-SINGLE) → X single
 *   (x-single) → X carousel (X-CAROUSEL). All LinkedIn before all X (the proven
 *   flow runs before the unproven one; the LinkedIn document proves the whole
 *   chain first).
 */

const { SchedulerCore, MODE } = require('./core');
const { LinkedInAdapter, LivePublishError } = require('./platforms/linkedin');
const { XAdapter } = require('./platforms/x');
const { buildPacket } = require('./packets');
const { SessionError, ConnectError } = require('./connect');
const report = require('./report');

/** Outcome tokens for a batch run. */
const OUTCOME = Object.freeze({
  COMPLETE: 'complete',
  PARTIAL: 'partial',
  ABORTED: 'aborted',
});

/**
 * Rank a post for the execution order. Lower rank = earlier. Derived from
 * platform + template so it generalizes to any batch's mix:
 *   0 LinkedIn document, 1 LinkedIn image, 2 X single, 3 X carousel.
 * Unknown combos sort last (rank 9) but still run.
 *
 * @param {object} post - a state-file post record (platform + template)
 * @returns {number} the order rank
 */
function orderRank(post) {
  const platform = post.platform;
  const template = post.template || '';
  if (platform === 'linkedin') {
    return template === 'LI-CAROUSEL' ? 0 : 1;
  }
  if (platform === 'x') {
    return template === 'X-CAROUSEL' ? 3 : 2;
  }
  return 9;
}

/**
 * Compute the run order for a set of posts. Stable within a rank so the
 * state-file order (already chronological-ish) breaks ties deterministically.
 *
 * @param {object[]} posts - the state-file post records
 * @returns {object[]} the posts in execution order
 */
function computeOrder(posts) {
  return posts
    .map((post, index) => ({ post, index, rank: orderRank(post) }))
    .sort((a, b) => (a.rank - b.rank) || (a.index - b.index))
    .map((entry) => entry.post);
}

/**
 * The orchestrator. Composes the core + the two adapters into one safe run.
 */
class Orchestrator {
  /**
   * @param {object} options - SchedulerCore options (week, mode, stateFile, …)
   * @param {object} [deps] - injectable dependencies for tests
   * @param {string} [options.only] - restrict the run to this single postId
   * @param {object} [deps.core] - a pre-built SchedulerCore (tests)
   * @param {object} [deps.linkedinAdapter] - injected LinkedIn adapter (tests)
   * @param {object} [deps.xAdapter] - injected X adapter (tests)
   * @param {Function} [deps.connectFn] - injected CDP connect (tests)
   * @param {object} [deps.chromium] - injected Playwright chromium (tests)
   */
  constructor(options, deps = {}) {
    /** @type {SchedulerCore} */
    this.core = deps.core || new SchedulerCore(options);
    /** @type {object} */
    this.linkedin = deps.linkedinAdapter || new LinkedInAdapter(this.core);
    /** @type {object} */
    this.x = deps.xAdapter || new XAdapter(this.core);
    /** @type {?Function} */
    this.connectFn = deps.connectFn;
    /** @type {?object} */
    this.chromium = deps.chromium;
    /**
     * Optional single-post restriction (`--only`). When set, only this postId is
     * scheduled; all others are left untouched (state preserved) — a
     * non-destructive filter, NOT a mutation of the state document.
     * @type {?string}
     */
    this.only = options && options.only ? options.only : null;
    /** @type {Set<string>} postIds attempted this run (for the report). */
    this.attempted = new Set();
  }

  /**
   * Pick the adapter for a post by platform.
   *
   * @param {object} post - a state-file post record
   * @returns {object} the matching adapter
   */
  adapterFor(post) {
    return post.platform === 'x' ? this.x : this.linkedin;
  }

  /**
   * Pre-flight gate: CDP connect, login guard per platform present in the
   * batch, asset existence per post, state loaded, mode logged. Any failure
   * STOPS with an actionable message before touching a composer.
   *
   * @returns {Promise<void>}
   * @throws {ConnectError|SessionError|Error} on any pre-flight failure
   */
  async preflight() {
    const core = this.core;
    core.startRun();

    // CDP connect.
    await core.connect({ connectFn: this.connectFn, chromium: this.chromium });
    core.runLog.append({ action: 'preflight-connect', result: 'ok', detail: core.config.cdpEndpoint });

    // Asset existence for every post — fail before any compose.
    for (const post of core.state.posts()) {
      const { ok, missing } = core.state.resolveAssets(post.postId);
      if (!ok) {
        throw new Error(
          `Pre-flight failed: ${post.postId} is missing asset(s): ${missing.join(', ')}`
        );
      }
    }
    core.runLog.append({ action: 'preflight-assets', result: 'ok' });

    // Login guard for each platform present in the batch.
    const platforms = new Set(core.state.posts().map((p) => p.platform));
    for (const platform of platforms) {
      // eslint-disable-next-line no-await-in-loop
      await core.assertLoggedIn(platform);
      core.runLog.append({ action: 'preflight-login', result: 'ok', detail: platform });
    }
  }

  /**
   * Idempotent resume + queue reconcile: skip `verified` posts; then ask each
   * platform adapter to reconcile its posts against the live queue (queue =
   * source of truth) so a re-run never double-posts.
   *
   * @param {object[]} packets - resolved packets for all posts
   * @returns {Promise<void>}
   */
  async reconcile(packets) {
    const byPlatform = { linkedin: [], x: [] };
    for (const packet of packets) {
      (byPlatform[packet.platform] || (byPlatform[packet.platform] = [])).push(packet);
    }
    if (byPlatform.linkedin.length > 0) {
      await this.core.reconcileWithQueue(this.linkedin, byPlatform.linkedin);
    }
    if (byPlatform.x.length > 0) {
      await this.core.reconcileWithQueue(this.x, byPlatform.x);
    }
  }

  /**
   * Run the full batch. Returns the structured report. On a live-publish it
   * stops the whole batch and returns an ABORTED report carrying the operator
   * alert. Pre-flight / session failures STOP and return an aborted report with
   * the actionable reason.
   *
   * @returns {Promise<{report:object, markdown:string, reportPath:(string|null), outcome:string}>}
   */
  async run() {
    const core = this.core;
    let outcome = OUTCOME.COMPLETE;
    let abortReason = null;

    // --- Pre-flight ---------------------------------------------------------
    try {
      await this.preflight();
    } catch (error) {
      abortReason = error.message;
      core.runLog.append({ action: 'preflight', result: 'STOP', detail: error.message });
      return this.finish(OUTCOME.ABORTED, abortReason);
    }

    // --- Resolve packets (read postText/assets/targets) ---------------------
    let packets;
    try {
      packets = core.state.posts().map((post) => buildPacket(core.state, post.postId));
    } catch (error) {
      abortReason = `packet resolution failed: ${error.message}`;
      core.runLog.append({ action: 'resolve-packets', result: 'STOP', detail: error.message });
      return this.finish(OUTCOME.ABORTED, abortReason);
    }

    // --- Idempotent resume + reconcile --------------------------------------
    try {
      await this.reconcile(packets);
    } catch (error) {
      // Reconcile is best-effort safety; a failure here is non-fatal (we simply
      // proceed treating unverified posts as still-pending), but it is logged.
      core.runLog.append({ action: 'reconcile', result: 'warn', detail: error.message });
    }

    // --- Execution order from metadata --------------------------------------
    // `--only` restricts the run to one post WITHOUT mutating the state document
    // (every other post's on-disk state is preserved untouched).
    const orderedPosts = computeOrder(core.state.posts()).filter(
      (post) => !this.only || post.postId === this.only
    );

    // --- One-at-a-time per-post loop ----------------------------------------
    let anyFailed = false;
    for (const post of orderedPosts) {
      const { postId } = post;

      // Skip already-verified.
      if (core.state.isVerified(postId)) {
        core.runLog.append({ postId, action: 'skip', result: 'already-verified' });
        continue;
      }

      const packet = packets.find((p) => p.postId === postId);
      const adapter = this.adapterFor(post);
      this.attempted.add(postId);

      try {
        // eslint-disable-next-line no-await-in-loop
        const result = await adapter.schedulePost(packet);
        core.runLog.append({
          postId,
          action: 'post-result',
          result: result.status,
          detail: result.reason || result.scheduledLocalTime,
        });
        if (result.status === 'failed') {
          anyFailed = true;
        }
      } catch (error) {
        // --- Live-publish batch abort — the one non-negotiable safety stop --
        if (error instanceof LivePublishError || error.critical) {
          abortReason = error.message;
          core.runLog.append({
            postId,
            action: 'G3-ABORT',
            result: 'CRITICAL',
            detail: error.message,
          });
          this.alertOperator(error.message);
          return this.finish(OUTCOME.ABORTED, abortReason);
        }

        // --- Session/login failure → STOP + ask the operator ----------------
        if (error instanceof SessionError || error instanceof ConnectError) {
          abortReason = error.message;
          core.runLog.append({ postId, action: 'STOP', result: 'session', detail: error.message });
          this.alertOperator(error.message);
          return this.finish(OUTCOME.ABORTED, abortReason);
        }

        // --- Bounded-retry exhaustion / guard-failed-twice → mark failed,
        //     stop-and-ask, do NOT continue the batch. -----------------------
        core.state.markFailed(postId, error.message);
        anyFailed = true;
        abortReason =
          `Stopped at ${postId}: ${error.message} ` +
          '(bounded retries exhausted / guard failed). Reporting precise state; ' +
          'propose options before continuing.';
        core.runLog.append({ postId, action: 'STOP-AND-ASK', result: 'fail', detail: error.message });
        this.alertOperator(abortReason);
        return this.finish(OUTCOME.ABORTED, abortReason);
      }
    }

    outcome = anyFailed ? OUTCOME.PARTIAL : OUTCOME.COMPLETE;
    return this.finish(outcome, abortReason);
  }

  /**
   * Emit the operator alert. Written to stderr + the run-log so an operator
   * watching the run sees it immediately. (Email/push wiring is an operator
   * concern; the contract here is a loud, precise alert.)
   *
   * @param {string} message - the precise alert text
   * @returns {void}
   */
  alertOperator(message) {
    process.stderr.write(`\n*** ALERT: ${message} ***\n\n`);
    this.core.runLog.append({ action: 'alert', result: 'sent', detail: message });
  }

  /**
   * Build + write the final report and return it with the outcome. Also
   * performs the leave-it-clean reporting: the final state of all posts.
   *
   * @param {string} outcome - 'complete' | 'partial' | 'aborted'
   * @param {(string|null)} abortReason - the abort reason, if any
   * @returns {{report:object, markdown:string, reportPath:(string|null), outcome:string}}
   */
  finish(outcome, abortReason) {
    const structured = report.buildReport({
      state: this.core.state,
      mode: this.core.mode,
      outcome,
      attempted: this.attempted,
      validationRegister: this.x.validationRegister
        ? this.x.validationRegister()
        : [],
      abortReason,
    });
    const markdown = report.renderMarkdown(structured);
    let reportPath = null;
    try {
      reportPath = report.writeReport(this.core.week, markdown);
    } catch (error) {
      this.core.runLog.append({ action: 'write-report', result: 'fail', detail: error.message });
    }
    this.core.runLog.append({ action: 'run-finished', result: outcome });
    return { report: structured, markdown, reportPath, outcome };
  }
}

module.exports = {
  Orchestrator,
  computeOrder,
  orderRank,
  OUTCOME,
  MODE,
};
