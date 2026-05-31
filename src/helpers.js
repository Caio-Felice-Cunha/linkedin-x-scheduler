'use strict';

/**
 * Scheduler shared helpers.
 *
 * The "verify after every step" and "bounded retries then stop" invariants are
 * enforced centrally here so no platform adapter re-implements them. Also hosts
 * the schedule-time formatting (the target times are authored as wall-clock
 * local, e.g. `2026-06-09 09:00`, and the LinkedIn/X UIs are driven in
 * M/D/YYYY + h:mm AM/PM) and small pure utilities.
 *
 * This module is browser-free and OS-dialog-free — it holds only pure logic +
 * the retry/verify control-flow wrappers.
 */

/**
 * A verification failure — a `verify()` predicate returned false. Distinct from
 * an arbitrary thrown error so callers can tell "the gate said no" from "the
 * step crashed".
 */
class VerifyError extends Error {
  /**
   * @param {string} description - what was being verified
   */
  constructor(description) {
    super(`Verification failed: ${description}`);
    this.name = 'VerifyError';
    this.description = description;
  }
}

/**
 * A bounded-retry exhaustion — a step still failed after `maxAttempts`.
 * Carries the last underlying error so the caller can report it.
 */
class RetryExhaustedError extends Error {
  /**
   * @param {string} description - the step that kept failing
   * @param {number} attempts - how many attempts were made
   * @param {Error} lastError - the final underlying error
   */
  constructor(description, attempts, lastError) {
    super(
      `Step "${description}" failed after ${attempts} attempt(s): ` +
        `${lastError ? lastError.message : 'unknown error'}`
    );
    this.name = 'RetryExhaustedError';
    this.description = description;
    this.attempts = attempts;
    this.lastError = lastError;
  }
}

/**
 * Run an async step with bounded retries. `maxAttempts` is the TOTAL number of
 * attempts (not initial-try-plus-retries); it defaults to the config ceiling.
 * On the final failure a RetryExhaustedError is thrown carrying the last error;
 * the caller stops and reports (never flails).
 *
 * @template T
 * @param {() => Promise<T>} stepFn - the async step (idempotent where possible)
 * @param {object} [options]
 * @param {number} [options.maxAttempts=2] - total attempts before giving up
 * @param {string} [options.description='step'] - label for logs/errors
 * @param {(attempt:number, error:Error) => void} [options.onRetry] - retry hook
 * @returns {Promise<T>} the step's resolved value
 * @throws {RetryExhaustedError} if every attempt fails
 */
async function withRetry(stepFn, options = {}) {
  const maxAttempts =
    typeof options.maxAttempts === 'number' && options.maxAttempts > 0
      ? options.maxAttempts
      : 2;
  const description = options.description || 'step';
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await stepFn();
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts && typeof options.onRetry === 'function') {
        options.onRetry(attempt, error);
      }
    }
  }

  throw new RetryExhaustedError(description, maxAttempts, lastError);
}

/**
 * Assert a predicate is truthy, throwing a VerifyError otherwise (verify after
 * every step; ambiguous = NOT done). The predicate may be sync or async; a
 * thrown predicate is treated as a failed verification.
 *
 * @param {() => (boolean|Promise<boolean>)} predicateFn - the check
 * @param {string} description - human-readable description of the check
 * @returns {Promise<true>} resolves true when the predicate holds
 * @throws {VerifyError} when the predicate is falsy or throws
 */
async function verify(predicateFn, description, options = {}) {
  const timeoutMs =
    typeof options.timeoutMs === 'number' && options.timeoutMs >= 0
      ? options.timeoutMs
      : 0;
  const intervalMs =
    typeof options.intervalMs === 'number' && options.intervalMs > 0
      ? options.intervalMs
      : 300;
  const deadline = Date.now() + timeoutMs;
  // Poll the predicate until it holds or the deadline passes (verify after
  // every step — but the UI is latency-bound, so a single instantaneous check
  // races the render. Polling waits for the expected state, then confirms it).
  for (;;) {
    let ok;
    try {
      // eslint-disable-next-line no-await-in-loop
      ok = await predicateFn();
    } catch (error) {
      void error;
      ok = false;
    }
    if (ok) {
      return true;
    }
    if (Date.now() >= deadline) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  throw new VerifyError(description);
}

/**
 * Parse a Pacific-local target timestamp of the form `YYYY-MM-DD HH:mm`
 * (24-hour, as stored in schedule-state.json `target`) into its components.
 * Performed as pure string parsing — NOT via the `Date` object — so the result
 * is timezone-agnostic and deterministic regardless of the host machine's TZ
 * (the value is already Pacific local; we must not let the host TZ shift it).
 *
 * @param {string} target - e.g. "2026-06-09 09:00"
 * @returns {{year:number, month:number, day:number, hour:number, minute:number}}
 * @throws {Error} if the string is malformed
 */
function parsePacificTarget(target) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(
    String(target).trim()
  );
  if (!match) {
    throw new Error(
      `Invalid target time "${target}": expected "YYYY-MM-DD HH:mm".`
    );
  }
  const [, y, mo, d, h, mi] = match;
  return {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
  };
}

/**
 * Format a parsed target's DATE as M/D/YYYY — the format the LinkedIn scheduler
 * Date field expects. No leading zeros on month/day. E.g. {2026,6,9} →
 * "6/9/2026".
 *
 * @param {{year:number,month:number,day:number}} parts - parsed target
 * @returns {string} the M/D/YYYY date string
 */
function formatDateMDY(parts) {
  return `${parts.month}/${parts.day}/${parts.year}`;
}

/**
 * Format a parsed target's TIME as h:mm AM/PM — the format the LinkedIn
 * scheduler Time field expects. 12-hour clock, no leading zero on the hour,
 * two-digit minute. E.g. {9,0} → "9:00 AM", {17,0} → "5:00 PM",
 * {0,30} → "12:30 AM".
 *
 * @param {{hour:number,minute:number}} parts - parsed target
 * @returns {string} the h:mm AM/PM time string
 */
function formatTime12h(parts) {
  const meridiem = parts.hour < 12 ? 'AM' : 'PM';
  let hour12 = parts.hour % 12;
  if (hour12 === 0) {
    hour12 = 12;
  }
  const mm = String(parts.minute).padStart(2, '0');
  return `${hour12}:${mm} ${meridiem}`;
}

/** Three-letter month abbreviations, index 1-12 (0 unused). */
const MONTH_ABBR = [
  '',
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Day-of-week abbreviations, Sunday = 0. */
const DOW_ABBR = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/**
 * Compute the day-of-week abbreviation for a parsed target using a pure
 * Zeller-style calculation (no `Date`, so host TZ cannot shift the day). Used to
 * assert the schedule-dialog header (e.g. "Tue, Jun 9, 9:00 AM…").
 *
 * @param {{year:number,month:number,day:number}} parts - parsed target
 * @returns {string} the 3-letter weekday (e.g. "Tue")
 */
function weekdayAbbr(parts) {
  // Sakamoto's algorithm — returns 0=Sunday..6=Saturday.
  const t = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4];
  let y = parts.year;
  const m = parts.month;
  const d = parts.day;
  if (m < 3) {
    y -= 1;
  }
  const dow =
    (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) +
      t[m - 1] + d) % 7;
  return DOW_ABBR[dow];
}

/**
 * Build a human-readable schedule label, e.g. "Tue, Jun 9, 9:00 AM" — recorded
 * to `scheduledLocalTime` + run-log and used to assert the schedule-dialog
 * header.
 *
 * @param {string} target - "YYYY-MM-DD HH:mm" wall-clock-local target
 * @returns {string} the formatted date/time label
 */
function pacificLabel(target) {
  const parts = parsePacificTarget(target);
  return (
    `${weekdayAbbr(parts)}, ${MONTH_ABBR[parts.month]} ${parts.day}, ` +
    `${formatTime12h(parts)}`
  );
}

/**
 * Extract the first non-empty line of a post's text — the dedupe / queue-match
 * key (find a scheduled post by its first line). Trimmed.
 *
 * @param {string} text - the full post text
 * @returns {string} the first non-empty line (or '' if none)
 */
function firstLine(text) {
  if (typeof text !== 'string') {
    return '';
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length > 0) {
      return line;
    }
  }
  return '';
}

/**
 * Sleep for `ms` milliseconds (a bounded, explicit wait used between polling
 * checks). Promise-based so it composes inside async steps.
 *
 * @param {number} ms - milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

module.exports = {
  VerifyError,
  RetryExhaustedError,
  withRetry,
  verify,
  parsePacificTarget,
  formatDateMDY,
  formatTime12h,
  weekdayAbbr,
  pacificLabel,
  firstLine,
  sleep,
  MONTH_ABBR,
  DOW_ABBR,
};
