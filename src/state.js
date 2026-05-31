'use strict';

/**
 * Scheduler state store.
 *
 * Owns `schedule-state.json` as the idempotency + resume source of truth.
 * Responsibilities:
 *   - Hold the run document: top-level `week` (the batch id) + `timezone`, and
 *     `posts[]`; each post `{ postId, platform, template, assets[], target,
 *     status, attempts, lastError, postText, docTitle }`. Optional fields added
 *     on write: `scheduledLocalTime`, `verifiedAt`, `mode`.
 *   - The per-post state machine `pending → composing → texted → attached →
 *     timed → scheduled → verified` (+ `failed`) with validated transitions.
 *   - Crash-safe persistence: write-temp-then-rename, retry on failure, and an
 *     in-memory mirror that survives a disk-write failure.
 *   - Asset existence assertion per post (read-only).
 *   - `verified`-skip on start (idempotent resume).
 *
 * Browser-free, OS-dialog-free.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * The per-post state machine. Ordered so the index also encodes
 * progression. `failed` is terminal-on-error and reachable from any state.
 */
const STATES = Object.freeze([
  'pending',
  'composing',
  'texted',
  'attached',
  'timed',
  'scheduled',
  'verified',
]);

/**
 * Allowed forward transitions. Each state may advance to the next, OR a post may
 * become `failed` from anywhere, OR re-enter `composing` from `pending`/a retry.
 * Idempotent self-transitions (X → X) are permitted so a re-drive is harmless.
 *
 * `verified` is reachable directly from `pending` (and `failed`) to support the
 * idempotent dedupe / queue-reconcile short-circuit: when a post is found ALREADY
 * present in the platform's live Scheduled queue (the queue is the source of
 * truth), it is marked `verified` without re-driving the machine.
 */
const TRANSITIONS = Object.freeze({
  pending: ['composing', 'verified', 'failed', 'pending'],
  composing: ['texted', 'composing', 'failed', 'pending'],
  texted: ['attached', 'texted', 'failed', 'pending'],
  attached: ['timed', 'attached', 'failed', 'pending'],
  timed: ['scheduled', 'timed', 'failed', 'pending'],
  scheduled: ['verified', 'scheduled', 'failed', 'pending'],
  verified: ['verified'],
  failed: ['failed', 'pending', 'composing', 'verified'],
});

/** The existing top-level keys we must preserve verbatim. */
const PRESERVED_TOP_KEYS = Object.freeze(['week', 'timezone', 'note']);

/** The existing per-post keys we must preserve verbatim. */
const PRESERVED_POST_KEYS = Object.freeze([
  'postId',
  'platform',
  'template',
  'assets',
  'target',
  'status',
  'attempts',
  'lastError',
]);

/**
 * The state store — wraps the parsed state-file document, exposes the post
 * records, validates + persists transitions, and keeps an in-memory mirror.
 */
class ScheduleState {
  /**
   * @param {object} doc - the parsed state-file JSON document
   * @param {string} stateFile - absolute path the document is persisted to
   * @param {string} week - the `YYYY-Www` week id
   */
  constructor(doc, stateFile, week) {
    /** @type {object} the live document (the in-memory mirror). */
    this.doc = doc;
    /** @type {string} */
    this.stateFile = stateFile;
    /** @type {string} */
    this.week = week;
    /** @type {boolean} set true if a disk write ever failed (mirror-only). */
    this.dirty = false;
  }

  /**
   * Load (and parse) a week's state file into a ScheduleState. Validates the
   * shape minimally (must have a `posts` array) and preserves every key.
   *
   * @param {string} week - the `YYYY-Www` week id
   * @param {string} [explicitStateFile] - override path (`--state <path>`)
   * @returns {ScheduleState}
   * @throws {Error} on a missing file, malformed JSON, or missing `posts`
   */
  static load(week, explicitStateFile) {
    const stateFile = explicitStateFile || config.stateFilePath(week);
    let raw;
    try {
      raw = fs.readFileSync(stateFile, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read state file ${stateFile}: ${error.message}. ` +
          'Run from a batch directory, or pass --batch <path to batch.json>.'
      );
    }
    let doc;
    try {
      doc = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `State file ${stateFile} is not valid JSON: ${error.message}`
      );
    }
    if (!doc || !Array.isArray(doc.posts)) {
      throw new Error(
        `State file ${stateFile} is missing a "posts" array.`
      );
    }
    return new ScheduleState(doc, stateFile, week || doc.week);
  }

  /**
   * Seed a fresh state store from a loaded manifest (first run). Each post starts
   * `pending`; the post text + absolute asset paths + optional doc title are
   * carried on the record. Persists immediately, then returns the store. On a
   * later run the existing state file is loaded instead (resume) — delete the
   * working directory to re-seed from a changed manifest.
   *
   * @param {{batchId:string, timezone:(string|null), posts:object[]}} manifest
   * @param {string} stateFile - absolute path to persist the state document to
   * @returns {ScheduleState}
   */
  static fromManifest(manifest, stateFile) {
    const doc = {
      week: manifest.batchId,
      timezone: manifest.timezone || null,
      posts: manifest.posts.map((p) => ({
        postId: p.postId,
        platform: p.platform,
        template: p.template,
        assets: p.assets,
        target: p.target,
        status: 'pending',
        attempts: 0,
        lastError: '',
        postText: p.postText,
        docTitle: p.docTitle || null,
      })),
    };
    const state = new ScheduleState(doc, stateFile, manifest.batchId);
    state.persist();
    return state;
  }

  /**
   * All post records (the live array — mutating a record mutates the mirror;
   * call `persist()` to flush). Each is the raw post object from the document.
   *
   * @returns {object[]}
   */
  posts() {
    return this.doc.posts;
  }

  /**
   * Find one post record by id.
   *
   * @param {string} postId - the post id
   * @returns {(object|undefined)}
   */
  getPost(postId) {
    return this.doc.posts.find((p) => p.postId === postId);
  }

  /**
   * Whether a post is already `verified` (skip on start).
   *
   * @param {string} postId - the post id
   * @returns {boolean}
   */
  isVerified(postId) {
    const post = this.getPost(postId);
    return Boolean(post && post.status === 'verified');
  }

  /**
   * Assert every asset listed for a post exists at its absolute path.
   * Returns the resolved absolute paths; does NOT write anything. A post with a
   * missing asset is reported (caller marks it ineligible, NOT `failed`).
   *
   * @param {string} postId - the post id
   * @returns {{ok: boolean, paths: string[], missing: string[]}}
   * @throws {Error} if the post id is unknown
   */
  resolveAssets(postId) {
    const post = this.getPost(postId);
    if (!post) {
      throw new Error(`Unknown post "${postId}" in ${this.stateFile}.`);
    }
    // Assets are stored as ABSOLUTE paths, resolved from the manifest at load.
    const paths = [];
    const missing = [];
    for (const abs of post.assets || []) {
      paths.push(abs);
      if (!fs.existsSync(abs)) {
        missing.push(abs);
      }
    }
    return { ok: missing.length === 0, paths, missing };
  }

  /**
   * Validate + apply a state transition for a post, then persist. The
   * transition is checked against TRANSITIONS; an illegal move throws. An
   * optional `patch` merges extra fields (e.g. `scheduledLocalTime`,
   * `screenshotIds`, `verifiedAt`, `lastError`) onto the post — additive only.
   *
   * @param {string} postId - the post id
   * @param {string} toState - the target state
   * @param {object} [patch] - additive fields to merge onto the post record
   * @returns {object} the updated post record
   * @throws {Error} on an unknown post or an illegal transition
   */
  transition(postId, toState, patch = {}) {
    const post = this.getPost(postId);
    if (!post) {
      throw new Error(`Unknown post "${postId}" in ${this.stateFile}.`);
    }
    if (!STATES.includes(toState) && toState !== 'failed') {
      throw new Error(`Unknown target state "${toState}".`);
    }
    const from = post.status || 'pending';
    const allowed = TRANSITIONS[from] || [];
    if (!allowed.includes(toState)) {
      throw new Error(
        `Illegal transition for ${postId}: ${from} → ${toState} ` +
          `(allowed from ${from}: ${allowed.join(', ')}).`
      );
    }

    post.status = toState;
    // Additive patch — never removes preserved keys.
    for (const key of Object.keys(patch)) {
      post[key] = patch[key];
    }
    this.persist();
    return post;
  }

  /**
   * Record a failure on a post: increments `attempts`, sets `lastError`, and
   * moves it to `failed` (failure at any gate after retries).
   *
   * @param {string} postId - the post id
   * @param {string} message - the failure reason
   * @returns {object} the updated post record
   */
  markFailed(postId, message) {
    const post = this.getPost(postId);
    if (!post) {
      throw new Error(`Unknown post "${postId}" in ${this.stateFile}.`);
    }
    post.attempts = (post.attempts || 0) + 1;
    post.lastError = String(message || '');
    return this.transition(postId, 'failed', {});
  }

  /**
   * Crash-safe persist: serialize the document, write to a temp file
   * in the same directory, fsync-free rename over the target (atomic on the same
   * filesystem). Retries up to 3 times; on total failure it keeps the in-memory
   * mirror (sets `dirty`) and throws so the caller can decide — it never leaves a
   * half-written file at the target path.
   *
   * @returns {void}
   * @throws {Error} if every write attempt fails (mirror is still intact)
   */
  persist() {
    const serialized = JSON.stringify(this.doc, null, 2) + '\n';
    const dir = path.dirname(this.stateFile);
    const tempFile = path.join(
      dir,
      `.schedule-state.${process.pid}.${Date.now()}.tmp`
    );
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        fs.writeFileSync(tempFile, serialized, 'utf8');
        fs.renameSync(tempFile, this.stateFile);
        this.dirty = false;
        return;
      } catch (error) {
        lastError = error;
        // Clean up a stray temp file before retrying.
        try {
          if (fs.existsSync(tempFile)) {
            fs.unlinkSync(tempFile);
          }
        } catch (cleanupError) {
          void cleanupError;
        }
      }
    }
    // All attempts failed — keep the in-memory mirror, flag dirty, surface it.
    this.dirty = true;
    throw new Error(
      `Failed to persist state file ${this.stateFile} after 3 attempts: ` +
        `${lastError ? lastError.message : 'unknown error'}. ` +
        'In-memory state preserved.'
    );
  }
}

module.exports = {
  ScheduleState,
  STATES,
  TRANSITIONS,
  PRESERVED_TOP_KEYS,
  PRESERVED_POST_KEYS,
};
