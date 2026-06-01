'use strict';

/**
 * Scheduler configuration + working-directory path resolution.
 *
 * Centralises every operational tunable so nothing is hard-coded in the flow
 * logic: the CDP endpoint, the expected logged-in account identities, the
 * bounded-retry ceiling, and timeouts. It also resolves the per-run working
 * paths (the resume state file, the run-log, the report, and the screenshots
 * directory) under a single working directory set by the CLI.
 *
 * This module contains NO browser, OS-dialog, or platform-UI code — it is pure
 * configuration + path resolution.
 */

const path = require('path');

/**
 * Default CDP endpoint of the operator's already-running, logged-in Chrome.
 * The operator launches Chrome with `--remote-debugging-port=9222`; the
 * scheduler attaches here — it never launches a browser.
 */
// 127.0.0.1 (not "localhost"): on some systems localhost resolves to IPv6 ::1
// while Chrome binds the debug port on IPv4, which refuses the connection.
const DEFAULT_CDP_ENDPOINT = 'http://127.0.0.1:9222';

/** Bounded-retry ceiling: max retries per step, then stop and report. */
const DEFAULT_MAX_RETRIES = 2;

/**
 * The working directory for a run. All runtime artifacts (state, run-log,
 * report, screenshots) live here. Defaults to the current working directory;
 * the CLI overrides it to `<batch-dir>/.scheduler/` via `setWorkDir`.
 * @type {string}
 */
let WORK_DIR = process.cwd();

/**
 * Set the working directory for the run (called once by the CLI before the core
 * is constructed). All path helpers below resolve relative to it.
 *
 * @param {string} dir - absolute working directory
 * @returns {void}
 */
function setWorkDir(dir) {
  WORK_DIR = path.resolve(dir);
}

/**
 * The current working directory for the run.
 * @returns {string}
 */
function workDir() {
  return WORK_DIR;
}

/**
 * Build the immutable scheduler config for a run.
 *
 * @param {object} [overrides] - partial overrides
 * @param {string} [overrides.cdpEndpoint] - CDP endpoint URL
 * @param {number} [overrides.maxRetries] - bounded-retry ceiling
 * @param {object} [overrides.accounts] - per-platform expected identities,
 *   e.g. `{ linkedin: { displayName }, x: { handle } }`. Used by the optional
 *   logged-in session guard; an empty object disables name checks.
 * @param {number} [overrides.stepTimeoutMs] - per-DOM-step timeout
 * @param {number} [overrides.uploadTimeoutMs] - media-processing wait ceiling
 * @param {number} [overrides.verifyTimeoutMs] - verify-gate poll ceiling
 * @returns {Readonly<object>} the frozen config object
 */
function buildConfig(overrides = {}) {
  return Object.freeze({
    cdpEndpoint: overrides.cdpEndpoint || DEFAULT_CDP_ENDPOINT,
    maxRetries:
      typeof overrides.maxRetries === 'number'
        ? overrides.maxRetries
        : DEFAULT_MAX_RETRIES,
    // Expected logged-in identities (optional). Empty by default — the guard
    // only enforces a name when one is provided.
    accounts: overrides.accounts || { linkedin: {}, x: {} },
    stepTimeoutMs:
      typeof overrides.stepTimeoutMs === 'number' ? overrides.stepTimeoutMs : 30000,
    uploadTimeoutMs:
      typeof overrides.uploadTimeoutMs === 'number' ? overrides.uploadTimeoutMs : 20000,
    verifyTimeoutMs:
      typeof overrides.verifyTimeoutMs === 'number' ? overrides.verifyTimeoutMs : 12000,
  });
}

/**
 * A safe batch id: a non-empty string with no path separators (used only as a
 * label in logs/reports — paths derive from the working directory, not the id).
 *
 * @param {string} id - the candidate batch id
 * @returns {boolean}
 */
function isValidBatchId(id) {
  return typeof id === 'string' && id.length > 0 && !/[\\/]/.test(id);
}

/**
 * The resume + idempotency state file: `<workDir>/schedule-state.json`.
 * (Arg accepted for back-compat with callers that pass a label; ignored.)
 *
 * @returns {string} the absolute state-file path
 */
function stateFilePath() {
  return path.join(WORK_DIR, 'schedule-state.json');
}

/**
 * The append-only run-log: `<workDir>/schedule-runlog.md`.
 *
 * @returns {string} the absolute run-log path
 */
function runLogPath() {
  return path.join(WORK_DIR, 'schedule-runlog.md');
}

/**
 * The final report: `<workDir>/schedule-report.md`.
 *
 * @returns {string} the absolute report path
 */
function reportPath() {
  return path.join(WORK_DIR, 'schedule-report.md');
}

/**
 * The per-step screenshot directory: `<workDir>/scheduler-logs/`.
 *
 * @returns {string} the absolute screenshot directory
 */
function screenshotDir() {
  return path.join(WORK_DIR, 'scheduler-logs');
}

/**
 * Resolve a batch's working directory: `<batchDir>/.scheduler/<batchId>/`.
 *
 * Keying on the batch id (not just the batch directory) keeps two different
 * `batch.json` files in the SAME directory from sharing one `.scheduler/` and
 * loading each other's stale resume state. Falls back to a flat `.scheduler/`
 * if no usable id is given.
 *
 * @param {string} batchDir - the directory containing the manifest
 * @param {string} batchId - the manifest's id
 * @returns {string} the absolute working directory for this batch
 */
function batchWorkDir(batchDir, batchId) {
  const base = path.join(batchDir, '.scheduler');
  return isValidBatchId(batchId) ? path.join(base, batchId) : base;
}

module.exports = {
  DEFAULT_CDP_ENDPOINT,
  DEFAULT_MAX_RETRIES,
  setWorkDir,
  workDir,
  batchWorkDir,
  buildConfig,
  isValidBatchId,
  stateFilePath,
  runLogPath,
  reportPath,
  screenshotDir,
};
