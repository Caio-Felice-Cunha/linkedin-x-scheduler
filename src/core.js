'use strict';

/**
 * Scheduler core context.
 *
 * Assembles the shared run context the platform adapters and the orchestrator
 * all consume: config, the loaded state store, the run-log, the screenshotter,
 * the bounded-retry/verify helpers, and the dry-run/live mode. It also defines
 * the `reconcileWithQueue(adapter)` contract the orchestrator calls on resume.
 *
 * The core has NO platform-UI knowledge and NO OS-dialog code. It never
 * launches a browser (connect.js attaches) and never writes per-post assets.
 */

const config = require('./config');
const helpers = require('./helpers');
const { ScheduleState } = require('./state');
const { RunLog } = require('./runlog');
const { Screenshotter } = require('./screenshot');

/** Run modes. Dry-run is the default; live arms the terminal click. */
const MODE = Object.freeze({ DRY_RUN: 'dry-run', LIVE: 'live' });

/**
 * The shared run context. One per `schedule run`/`dry-run` invocation.
 */
class SchedulerCore {
  /**
   * @param {object} options
   * @param {string} options.week - the `YYYY-Www` week id
   * @param {string} [options.stateFile] - explicit state-file path (--state)
   * @param {string} [options.mode=MODE.DRY_RUN] - 'dry-run' | 'live'
   * @param {object} [options.config] - config overrides (cdpEndpoint, etc.)
   * @param {boolean} [options.screenshots=true] - capture step screenshots
   */
  constructor(options) {
    if (!options || !options.week) {
      throw new Error('SchedulerCore requires a week.');
    }
    /** @type {string} */
    this.week = options.week;
    /** @type {Readonly<object>} */
    this.config = config.buildConfig(options.config || {});
    /** @type {string} */
    this.mode = options.mode === MODE.LIVE ? MODE.LIVE : MODE.DRY_RUN;
    /** @type {ScheduleState} */
    this.state = ScheduleState.load(options.week, options.stateFile);
    /** @type {RunLog} */
    this.runLog = new RunLog(options.week);
    /** @type {Screenshotter} */
    this.screenshotter = new Screenshotter(options.week, {
      enabled: options.screenshots !== false,
    });
    // Browser handles — populated by `connect()`.
    /** @type {?object} */
    this.browser = null;
    /** @type {?object} */
    this.context = null;
    /** @type {?object} */
    this.page = null;
  }

  /** True when the terminal Schedule action must be stubbed. */
  get isDryRun() {
    return this.mode === MODE.DRY_RUN;
  }

  /**
   * Connect to the operator's running Chrome over CDP. Stores the
   * browser/context/page on the core. Injectable `chromium` for tests.
   *
   * @param {object} [deps]
   * @param {object} [deps.chromium] - injected Playwright `chromium` (tests)
   * @param {Function} [deps.connectFn] - injected connect fn (tests)
   * @returns {Promise<object>} the connected page
   */
  async connect(deps = {}) {
    // eslint-disable-next-line global-require
    const connect = require('./connect');
    const connectFn = deps.connectFn || connect.connectToRunningChrome;
    const result = await connectFn({
      endpoint: this.config.cdpEndpoint,
      chromium: deps.chromium,
    });
    this.browser = result.browser;
    this.context = result.context;
    this.page = result.page;
    return this.page;
  }

  /**
   * Verify the connected session is logged in as the operator for a platform.
   * Delegates to connect.assertLoggedIn with the configured identities.
   *
   * @param {string} platform - 'linkedin' | 'x'
   * @param {object} [deps]
   * @param {Function} [deps.assertFn] - injected guard fn (tests)
   * @returns {Promise<object>} the login result
   */
  async assertLoggedIn(platform, deps = {}) {
    // eslint-disable-next-line global-require
    const connect = require('./connect');
    const assertFn = deps.assertFn || connect.assertLoggedIn;
    return assertFn(this.page, platform, this.config.accounts);
  }

  /**
   * Bounded-retry wrapper, pre-bound to the configured ceiling and the run-log
   * so every retry is recorded.
   *
   * @template T
   * @param {() => Promise<T>} stepFn - the async step
   * @param {string} description - label for logs/errors
   * @param {string} [postId] - the post id, for run-log context
   * @returns {Promise<T>}
   */
  withRetry(stepFn, description, postId) {
    return helpers.withRetry(stepFn, {
      maxAttempts: this.config.maxRetries,
      description,
      onRetry: (attempt, error) => {
        this.runLog.append({
          postId,
          action: description,
          result: 'retry',
          detail: `attempt ${attempt} failed: ${error.message}`,
        });
      },
    });
  }

  /**
   * Verify gate, recording the check to the run-log.
   *
   * @param {() => (boolean|Promise<boolean>)} predicateFn - the check
   * @param {string} description - human-readable description
   * @param {string} [postId] - the post id, for run-log context
   * @returns {Promise<true>}
   */
  async verify(predicateFn, description, postId) {
    try {
      await helpers.verify(predicateFn, description, {
        timeoutMs: this.config.verifyTimeoutMs || 12000,
      });
      this.runLog.append({ postId, action: `verify: ${description}`, result: 'ok' });
      return true;
    } catch (error) {
      this.runLog.append({
        postId,
        action: `verify: ${description}`,
        result: 'fail',
      });
      throw error;
    }
  }

  /**
   * Capture a step screenshot + record its id to the run-log.
   *
   * @param {string} stepLabel - short kebab label for the step
   * @param {string} [postId] - the post id
   * @returns {Promise<(string|null)>} the screenshot id, or null
   */
  async screenshot(stepLabel, postId) {
    const id = await this.screenshotter.capture(this.page, stepLabel, postId);
    if (id) {
      this.runLog.append({
        postId,
        action: stepLabel,
        result: 'screenshot',
        screenshotId: id,
      });
    }
    return id;
  }

  /**
   * The reconcile-with-queue contract. The CORE does not parse any platform
   * queue — it delegates to the platform adapter, which knows how to read its
   * own Scheduled queue. The orchestrator calls this on resume: for each post
   * already scheduled-but-unverified (or claimed verified), the adapter confirms
   * presence in the live queue (queue = source of truth), and the core marks
   * matches `verified` and reports duplicates.
   *
   * Contract the adapter MUST implement:
   *   adapter.queueContains(page, firstLine) → Promise<boolean>
   *     — true iff a post whose first line equals `firstLine` is in the live
   *       Scheduled/unsent queue.
   *
   * @param {object} adapter - a platform adapter implementing `queueContains`
   * @param {object[]} packets - resolved packets for this adapter's platform
   * @returns {Promise<{reconciled:string[], stillPending:string[]}>}
   */
  async reconcileWithQueue(adapter, packets) {
    if (!adapter || typeof adapter.queueContains !== 'function') {
      throw new Error(
        'reconcileWithQueue: adapter must implement queueContains(page, firstLine).'
      );
    }
    const reconciled = [];
    const stillPending = [];
    for (const packet of packets) {
      // Skip posts already verified in the state file.
      if (this.state.isVerified(packet.postId)) {
        continue;
      }
      // eslint-disable-next-line no-await-in-loop
      const present = await adapter.queueContains(this.page, packet.firstLine);
      if (present) {
        this.state.transition(packet.postId, 'verified', {
          verifiedAt: new Date().toISOString(),
          reconciled: true,
        });
        this.runLog.append({
          postId: packet.postId,
          action: 'reconcile',
          result: 'verified-from-queue',
          detail: 'found in live Scheduled queue (queue = source of truth)',
        });
        reconciled.push(packet.postId);
      } else {
        stillPending.push(packet.postId);
      }
    }
    return { reconciled, stillPending };
  }

  /**
   * Begin the run-log + persist the active mode onto the state document
   * (an additive top-level field — never removes existing keys).
   *
   * @returns {void}
   */
  startRun() {
    this.runLog.start({ mode: this.mode, cdpEndpoint: this.config.cdpEndpoint });
    this.state.doc.mode = this.mode;
    try {
      this.state.persist();
    } catch (error) {
      // A state-write failure at run start is non-fatal — the in-memory mirror
      // holds; the run-log already recorded the mode.
      this.runLog.append({
        action: 'persist-mode',
        result: 'fail',
        detail: error.message,
      });
    }
  }
}

module.exports = { SchedulerCore, MODE };
