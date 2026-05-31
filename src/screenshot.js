'use strict';

/**
 * Step-screenshot helper — heavy logging + a screenshot on each step.
 *
 * Writes a full-page screenshot for a named step into the batch's
 * `scheduler-logs/` directory and returns a stable screenshot id that the
 * run-log records. Because the X flow is unproven, a screenshot at every step
 * is how a live `--dry-run` rehearsal becomes diagnosable.
 *
 * Screenshots go to `scheduler-logs/`, NOT into any per-post asset folder, so
 * this never modifies a post's individual asset directory.
 *
 * A screenshot failure is best-effort: it never throws (a missing screenshot
 * must not abort a real scheduling run); it logs to stderr and returns null.
 */

const fs = require('fs');
const config = require('./config');
const path = require('path');

/**
 * A screenshotter bound to one week's `scheduler-logs/` directory. Numbers
 * screenshots monotonically so the run-log ids sort in capture order.
 */
class Screenshotter {
  /**
   * @param {string} week - the `YYYY-Www` week id
   * @param {object} [options]
   * @param {boolean} [options.enabled=true] - master switch (off in pure unit
   *   tests that pass a page with no `screenshot`)
   */
  constructor(week, options = {}) {
    /** @type {string} */
    this.week = week;
    /** @type {string} */
    this.dir = config.screenshotDir(week);
    /** @type {number} */
    this.counter = 0;
    /** @type {boolean} */
    this.enabled = options.enabled !== false;
  }

  /**
   * Capture a screenshot for a step. The id encodes order + post + step, e.g.
   * `0007-<postId>-attach-image`. Best-effort: returns the id on success,
   * or null on any failure (never throws).
   *
   * @param {object} page - the Playwright Page (must expose `screenshot`)
   * @param {string} stepLabel - a short kebab label for the step
   * @param {string} [postId] - the post id, if applicable
   * @returns {Promise<(string|null)>} the screenshot id, or null
   */
  async capture(page, stepLabel, postId) {
    if (!this.enabled || !page || typeof page.screenshot !== 'function') {
      return null;
    }
    this.counter += 1;
    const seq = String(this.counter).padStart(4, '0');
    const safeLabel = String(stepLabel).replace(/[^A-Za-z0-9._-]/g, '-');
    const safePost = postId
      ? String(postId).replace(/[^A-Za-z0-9._-]/g, '-')
      : 'run';
    const id = `${seq}-${safePost}-${safeLabel}`;
    const outPath = path.join(this.dir, `${id}.png`);
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      await page.screenshot({ path: outPath, fullPage: true });
      return id;
    } catch (error) {
      process.stderr.write(
        `screenshot: failed to capture "${id}": ${error.message}\n`
      );
      return null;
    }
  }
}

module.exports = { Screenshotter };
