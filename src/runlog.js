'use strict';

/**
 * Scheduler run-log.
 *
 * Appends every action + result + optional screenshot id to the batch's
 * run-log file so any failure is diagnosable and a run is resumable.
 * Append-only Markdown; each entry is one timestamped line. The run-log file is
 * alongside the state file (NOT inside a per-post asset folder), so this never
 * touches a post's individual asset directory.
 *
 * Browser-free, OS-dialog-free.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');

/**
 * A run-logger bound to one batch's run-log file. Holds an in-memory mirror of
 * every entry so a disk-write failure never loses the diagnostic trail.
 */
class RunLog {
  /**
   * @param {string} week - the `YYYY-Www` week id
   * @param {string} [explicitPath] - override run-log path
   */
  constructor(week, explicitPath) {
    /** @type {string} */
    this.week = week;
    /** @type {string} */
    this.filePath = explicitPath || config.runLogPath(week);
    /** @type {Array<object>} in-memory mirror of every appended entry. */
    this.entries = [];
    /** @type {boolean} */
    this.headerWritten = false;
  }

  /**
   * Write the run-log header once (run start). Records the active mode so a log
   * file unambiguously states whether this was a dry-run or a live run.
   *
   * @param {{mode:string, cdpEndpoint?:string}} meta - run metadata
   * @returns {void}
   */
  start(meta) {
    const stamp = new Date().toISOString();
    const lines = [
      `\n## Scheduler run — ${stamp}`,
      `- week: ${this.week}`,
      `- mode: **${meta.mode}**`,
    ];
    if (meta.cdpEndpoint) {
      lines.push(`- cdp: ${meta.cdpEndpoint}`);
    }
    lines.push('');
    this.appendRaw(lines.join('\n') + '\n');
    this.headerWritten = true;
  }

  /**
   * Append one structured action entry. Mirrors in memory, then best-effort
   * appends to disk (a disk failure is logged to stderr but never throws — the
   * run continues with the in-memory mirror).
   *
   * @param {object} entry
   * @param {string} entry.action - what happened (e.g. "compose-text")
   * @param {string} [entry.postId] - the post id, if applicable
   * @param {string} [entry.result] - "ok" | "fail" | "skip" | freeform
   * @param {string} [entry.detail] - extra context
   * @param {string} [entry.screenshotId] - associated screenshot id, if any
   * @returns {void}
   */
  append(entry) {
    const stamp = new Date().toISOString();
    const record = Object.assign({ timestamp: stamp }, entry);
    this.entries.push(record);

    const parts = [`- ${stamp}`];
    if (entry.postId) {
      parts.push(`[${entry.postId}]`);
    }
    parts.push(entry.action || 'action');
    if (entry.result) {
      parts.push(`→ ${entry.result}`);
    }
    if (entry.detail) {
      parts.push(`— ${entry.detail}`);
    }
    if (entry.screenshotId) {
      parts.push(`(screenshot: ${entry.screenshotId})`);
    }
    this.appendRaw(parts.join(' ') + '\n');
  }

  /**
   * Best-effort raw append to the run-log file. Creates the parent dir if
   * needed. Swallows write errors (mirror is authoritative) but reports them to
   * stderr so a misconfigured path is visible.
   *
   * @param {string} text - the exact text to append
   * @returns {void}
   */
  appendRaw(text) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.appendFileSync(this.filePath, text, 'utf8');
    } catch (error) {
      process.stderr.write(
        `runlog: could not append to ${this.filePath}: ${error.message} ` +
          '(continuing with in-memory mirror)\n'
      );
    }
  }
}

module.exports = { RunLog };
