'use strict';

/**
 * Final-report builder.
 *
 * Produces the end-of-run report listing EVERY post with: postId, platform,
 * template, intended scheduled target, the local time actually set, and the
 * queue-verified status (`verified` / `failed` / `skipped-already-verified`
 * / `not-attempted`), plus the reason for any non-`verified` post. It also
 * surfaces the X NEEDS-LIVE-VALIDATION register with each item's observed
 * outcome. Rendered to Markdown (written under the batch's output) and to a JSON
 * object (for `--json`).
 *
 * Pure formatting — no browser/OS/state mutation.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const helpers = require('./helpers');

/**
 * Map a post's state-file status into the report's verified-status vocabulary.
 *
 * @param {object} post - a state-file post record
 * @param {Set<string>} attempted - postIds the orchestrator attempted this run
 * @returns {string} the report status token
 */
function reportStatus(post, attempted, mode) {
  if (post.status === 'verified') {
    return post.reconciled || !attempted.has(post.postId)
      ? 'skipped-already-verified'
      : 'verified';
  }
  if (post.status === 'failed') {
    return 'failed';
  }
  if (!attempted.has(post.postId)) {
    return 'not-attempted';
  }
  // Attempted but not verified/failed. Label by the ACTUAL run mode (not a
  // stale dryRun flag left on the record by a prior rehearsal).
  if (mode === 'dry-run') {
    return 'dry-run-rehearsed';
  }
  // Live: the Schedule click happened (state 'scheduled') but the queue check
  // did not confirm it — flag for a manual look, NOT a re-schedule.
  return post.status === 'scheduled' ? 'scheduled-unverified' : 'incomplete';
}

/**
 * Build the structured report object for a run.
 *
 * @param {object} params
 * @param {import('./state').ScheduleState} params.state - the loaded state store
 * @param {string} params.mode - 'dry-run' | 'live'
 * @param {string} params.outcome - 'complete' | 'partial' | 'aborted'
 * @param {Set<string>} params.attempted - postIds attempted this run
 * @param {Array<object>} [params.validationRegister] - X NEEDS-LIVE-VALIDATION
 * @param {string} [params.abortReason] - why the batch aborted, if it did
 * @returns {object} the structured report
 */
function buildReport(params) {
  const { state, mode, outcome, attempted } = params;
  const posts = state.posts().map((post) => ({
    postId: post.postId,
    platform: post.platform,
    template: post.template,
    intendedTarget: post.target,
    intendedPacific: safePacific(post.target),
    scheduledLocalTime: post.scheduledLocalTime || null,
    status: reportStatus(post, attempted, mode),
    reason: post.status === 'failed' ? post.lastError || '' : '',
  }));

  const summary = {
    total: posts.length,
    verified: posts.filter((p) => p.status === 'verified').length,
    skipped: posts.filter((p) => p.status === 'skipped-already-verified').length,
    failed: posts.filter((p) => p.status === 'failed').length,
    notAttempted: posts.filter((p) => p.status === 'not-attempted').length,
    rehearsed: posts.filter((p) => p.status === 'dry-run-rehearsed').length,
    scheduledUnverified: posts.filter((p) => p.status === 'scheduled-unverified').length,
  };

  return {
    week: state.week,
    mode,
    outcome,
    generatedAt: new Date().toISOString(),
    abortReason: params.abortReason || null,
    summary,
    posts,
    needsLiveValidation: params.validationRegister || [],
  };
}

/**
 * Safely format a target as a Pacific label; returns the raw target on a parse
 * error (never throws inside report generation).
 *
 * @param {string} target - the target timestamp
 * @returns {string}
 */
function safePacific(target) {
  try {
    return helpers.pacificLabel(target);
  } catch (error) {
    void error;
    return String(target || '');
  }
}

/**
 * Render the structured report to Markdown.
 *
 * @param {object} report - a buildReport() result
 * @returns {string} the Markdown report
 */
function renderMarkdown(report) {
  const lines = [];
  lines.push(`# Scheduler report — ${report.week}`);
  lines.push('');
  lines.push(`- Mode: **${report.mode}**`);
  lines.push(`- Outcome: **${report.outcome.toUpperCase()}**`);
  lines.push(`- Generated: ${report.generatedAt}`);
  if (report.abortReason) {
    lines.push(`- **ABORT reason:** ${report.abortReason}`);
  }
  lines.push('');
  lines.push(
    `Summary: ${report.summary.verified} verified, ` +
      `${report.summary.skipped} skipped, ${report.summary.failed} failed, ` +
      `${report.summary.rehearsed} rehearsed (dry-run), ` +
      `${report.summary.scheduledUnverified || 0} scheduled-unverified, ` +
      `${report.summary.notAttempted} not attempted ` +
      `(of ${report.summary.total}).`
  );
  lines.push('');
  lines.push('| Post | Platform | Template | Intended (Pacific) | Scheduled set | Status | Reason |');
  lines.push('|------|----------|----------|--------------------|---------------|--------|--------|');
  for (const p of report.posts) {
    lines.push(
      `| ${p.postId} | ${p.platform} | ${p.template} | ${p.intendedPacific} | ` +
        `${p.scheduledLocalTime || '—'} | ${p.status} | ${escapeCell(p.reason)} |`
    );
  }
  lines.push('');

  if (report.needsLiveValidation && report.needsLiveValidation.length > 0) {
    lines.push('## X — NEEDS-LIVE-VALIDATION register');
    lines.push('');
    lines.push('| ID | Assumption | Observed this run |');
    lines.push('|----|------------|-------------------|');
    for (const item of report.needsLiveValidation) {
      lines.push(
        `| ${item.id} | ${escapeCell(item.assumption)} | ${escapeCell(item.observed)} |`
      );
    }
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

/**
 * Escape a value for a Markdown table cell (pipes + newlines).
 *
 * @param {string} value - the raw cell value
 * @returns {string}
 */
function escapeCell(value) {
  return String(value || '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
}

/**
 * Write the Markdown report to the configured report path for the batch.
 * Best-effort directory creation. Returns the path written.
 *
 * @param {string} week - the batch label / `YYYY-Www` id
 * @param {string} markdown - the rendered Markdown
 * @returns {string} the report file path
 */
function writeReport(week, markdown) {
  const reportFile = config.reportPath(week);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, markdown, 'utf8');
  return reportFile;
}

module.exports = {
  buildReport,
  renderMarkdown,
  writeReport,
  reportStatus,
};
