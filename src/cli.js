#!/usr/bin/env node
'use strict';

/**
 * linkedin-x-scheduler CLI — entrypoint.
 *
 * Three-tier exit codes:
 *   0  success
 *   1  validation / usage failure (also unknown commands)
 *   2  toolchain / environment error (e.g. cannot connect to Chrome)
 *
 * Subcommands:
 *   run            schedule a batch (LIVE only with --live; dry-run otherwise)
 *   dry-run        force a rehearsal (terminal Schedule click stubbed)
 *   connect-check  attach to the running Chrome over CDP and report (no scheduling)
 *   doctor         alias for connect-check
 *
 * Flags: --batch <path> | --dry-run | --live | --only <postId> | --cdp <url> |
 *        --json | --no-screenshots
 *
 * IMPORTANT: this NEVER launches a browser and NEVER handles credentials. A live
 * run requires you to have launched Chrome with --remote-debugging-port=9222 on
 * a profile where you are logged in to LinkedIn + X (see README.md).
 */

const fs = require('fs');
const path = require('path');
const { Orchestrator, MODE } = require('./orchestrator');
const { SchedulerCore } = require('./core');
const { loadManifest } = require('./manifest');
const { ScheduleState } = require('./state');
const { runReschedule } = require('./reschedule');
const helpers = require('./helpers');
const connect = require('./connect');
const config = require('./config');

/** Three-tier exit codes. */
const EXIT = Object.freeze({ SUCCESS: 0, VALIDATION_FAILURE: 1, TOOLCHAIN_ERROR: 2 });

/** The registered subcommands. */
const COMMANDS = Object.freeze({
  run: "Schedule a batch (LIVE only with --live; dry-run otherwise).",
  'dry-run': 'Rehearse a batch with the terminal Schedule click stubbed.',
  reschedule: "Change existing X posts' times in place to the manifest's scheduledAt (X only; --live to save).",
  'connect-check': 'Attach to the running Chrome over CDP and report (no scheduling).',
  doctor: 'Environment + CDP connectivity summary (no scheduling).',
});

/**
 * Parse argv into a flag/arg bag.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {object}
 */
function parseArgs(argv) {
  const opts = {
    command: null,
    batch: null,
    mode: MODE.DRY_RUN, // default is the SAFE dry-run.
    only: null,
    cdp: null,
    jsonMode: false,
    screenshots: true,
    helpRequested: false,
  };
  let liveSeen = false;
  let dryRunSeen = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') {
      opts.jsonMode = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.helpRequested = true;
    } else if (arg === '--dry-run') {
      dryRunSeen = true;
    } else if (arg === '--live') {
      liveSeen = true;
    } else if (arg === '--no-screenshots') {
      opts.screenshots = false;
    } else if (arg === '--batch') {
      opts.batch = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--batch=')) {
      opts.batch = arg.slice('--batch='.length);
    } else if (arg === '--only') {
      opts.only = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--only=')) {
      opts.only = arg.slice('--only='.length);
    } else if (arg === '--cdp') {
      opts.cdp = argv[i + 1] || null;
      i += 1;
    } else if (arg.startsWith('--cdp=')) {
      opts.cdp = arg.slice('--cdp='.length);
    } else if (!arg.startsWith('-')) {
      // First bare token: a subcommand if it matches one, else a batch path.
      if (opts.command === null && Object.prototype.hasOwnProperty.call(COMMANDS, arg)) {
        opts.command = arg;
      } else if (opts.batch === null) {
        opts.batch = arg;
      }
    }
  }

  opts.mode = liveSeen && !dryRunSeen ? MODE.LIVE : MODE.DRY_RUN;
  return opts;
}

/** Print root help. */
function printHelp() {
  const lines = [
    'linkedin-x-scheduler — bulk-schedule LinkedIn + X posts from your own browser.',
    '',
    'Usage:',
    '  npx linkedin-x-scheduler <command> --batch <path> [options]',
    '  node src/cli.js --batch ./my-batch/batch.json --dry-run',
    '',
    'Commands:',
  ];
  for (const name of Object.keys(COMMANDS)) {
    lines.push(`  ${name.padEnd(14)} ${COMMANDS[name]}`);
  }
  lines.push('');
  lines.push('Options:');
  lines.push('  --batch <path>     Path to a batch.json (or a directory holding one).');
  lines.push('  --dry-run          Rehearse — stub the terminal Schedule click (DEFAULT, safe).');
  lines.push('  --live             Arm the terminal Schedule click (real scheduling).');
  lines.push('  --only <postId>    Restrict the run to a single post.');
  lines.push('  --cdp <url>        CDP endpoint (default http://127.0.0.1:9222).');
  lines.push('  --json             Emit the structured report as JSON.');
  lines.push('  --no-screenshots   Disable per-step screenshots.');
  lines.push('');
  lines.push('SAFETY: dry-run is the default. A live run needs Chrome started with');
  lines.push('--remote-debugging-port=9222 on a profile logged in to LinkedIn + X (README.md).');
  process.stdout.write(lines.join('\n') + '\n');
}

/**
 * Handle `run` / `dry-run`.
 *
 * @param {object} opts - parsed args
 * @returns {Promise<number>} exit code
 */
async function handleRun(opts) {
  const batchArg = opts.batch || 'batch.json';

  // 1. Load + validate the manifest.
  let manifest;
  try {
    manifest = loadManifest(batchArg);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  // 2. Working directory: <batch-dir>/.scheduler/ holds state + logs + report.
  const workDir = path.join(manifest.batchDir, '.scheduler');
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch (error) {
    process.stderr.write(`Error: cannot create working dir ${workDir}: ${error.message}\n`);
    return EXIT.TOOLCHAIN_ERROR;
  }
  config.setWorkDir(workDir);

  // 3. Seed the state on first run; otherwise the existing state file is the
  //    resume source of truth (delete <batch-dir>/.scheduler to re-seed).
  const stateFile = config.stateFilePath();
  if (!fs.existsSync(stateFile)) {
    try {
      ScheduleState.fromManifest(manifest, stateFile);
    } catch (error) {
      process.stderr.write(`Error: cannot seed state: ${error.message}\n`);
      return EXIT.TOOLCHAIN_ERROR;
    }
  }

  // 4. Build the run context.
  let core;
  try {
    const cfg = {};
    if (opts.cdp) cfg.cdpEndpoint = opts.cdp;
    if (manifest.accounts) cfg.accounts = manifest.accounts;
    core = new SchedulerCore({
      week: manifest.batchId,
      mode: opts.mode,
      screenshots: opts.screenshots,
      config: cfg,
    });
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  if (opts.only && !core.state.getPost(opts.only)) {
    process.stderr.write(`Error: --only ${opts.only} is not a post id in this batch.\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  const orchestrator = new Orchestrator({ week: manifest.batchId, only: opts.only || null }, { core });
  const result = await orchestrator.run();

  if (opts.jsonMode) {
    process.stdout.write(JSON.stringify(result.report, null, 2) + '\n');
  } else {
    process.stdout.write(result.markdown);
    if (result.reportPath) {
      process.stdout.write(`\nReport written → ${result.reportPath}\n`);
    }
  }

  if (result.outcome === 'complete') return EXIT.SUCCESS;
  if (result.outcome === 'partial') return EXIT.VALIDATION_FAILURE;
  return EXIT.TOOLCHAIN_ERROR;
}

/**
 * Handle `connect-check` / `doctor`.
 *
 * @param {object} opts - parsed args
 * @returns {Promise<number>} exit code
 */
async function handleConnectCheck(opts) {
  const endpoint = opts.cdp || config.DEFAULT_CDP_ENDPOINT;
  try {
    const { browser } = await connect.connectToRunningChrome({ endpoint });
    const contexts = browser.contexts ? browser.contexts() : [];
    const pageCount = contexts[0] && contexts[0].pages ? contexts[0].pages().length : 0;
    if (opts.jsonMode) {
      process.stdout.write(
        JSON.stringify({ status: 'ok', endpoint, contexts: contexts.length, pages: pageCount }) + '\n'
      );
    } else {
      process.stdout.write(
        `connect-check: attached to Chrome at ${endpoint} ` +
          `(${contexts.length} context(s), ${pageCount} page(s) in context[0]).\n` +
          'Ready. Run `dry-run --batch <path>` to rehearse a batch.\n'
      );
    }
    try {
      if (browser && typeof browser.close === 'function') {
        await browser.close();
      }
    } catch (closeError) {
      void closeError;
    }
    return EXIT.SUCCESS;
  } catch (error) {
    if (opts.jsonMode) {
      process.stdout.write(
        JSON.stringify({ status: 'error', endpoint, message: error.message }) + '\n'
      );
    } else {
      process.stderr.write(`connect-check FAILED: ${error.message}\n`);
    }
    return EXIT.TOOLCHAIN_ERROR;
  }
}

/**
 * Handle `reschedule` — change existing X posts' times in place to the
 * manifest's scheduledAt (X only). Dry-run unless --live.
 *
 * @param {object} opts - parsed args
 * @returns {Promise<number>} exit code
 */
async function handleReschedule(opts) {
  const batchArg = opts.batch || 'batch.json';

  let manifest;
  try {
    manifest = loadManifest(batchArg);
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  const workDir = path.join(manifest.batchDir, '.scheduler');
  try {
    fs.mkdirSync(workDir, { recursive: true });
  } catch (error) {
    process.stderr.write(`Error: cannot create working dir ${workDir}: ${error.message}\n`);
    return EXIT.TOOLCHAIN_ERROR;
  }
  config.setWorkDir(workDir);
  const stateFile = config.stateFilePath();
  if (!fs.existsSync(stateFile)) {
    try {
      ScheduleState.fromManifest(manifest, stateFile);
    } catch (error) {
      process.stderr.write(`Error: cannot seed state: ${error.message}\n`);
      return EXIT.TOOLCHAIN_ERROR;
    }
  }

  let core;
  try {
    const cfg = {};
    if (opts.cdp) cfg.cdpEndpoint = opts.cdp;
    if (manifest.accounts) cfg.accounts = manifest.accounts;
    core = new SchedulerCore({ week: manifest.batchId, mode: opts.mode, screenshots: opts.screenshots, config: cfg });
  } catch (error) {
    process.stderr.write(`Error: ${error.message}\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  // Each post is matched in the live queue by its first line; scheduledAt is the
  // NEW desired time.
  const packets = manifest.posts.map((p) => ({
    postId: p.postId,
    platform: p.platform,
    target: p.target,
    firstLine: helpers.firstLine(p.postText),
  }));
  if (opts.only && !packets.find((p) => p.postId === opts.only)) {
    process.stderr.write(`Error: --only ${opts.only} is not a post id in this batch.\n`);
    return EXIT.VALIDATION_FAILURE;
  }

  let result;
  try {
    result = await runReschedule({ core, packets, only: opts.only || null });
  } catch (error) {
    process.stderr.write(`Reschedule error: ${error.message}\n`);
    return EXIT.TOOLCHAIN_ERROR;
  }

  if (opts.jsonMode) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } else {
    const lines = [
      `# Reschedule report — ${manifest.batchId}`,
      '',
      `- Mode: **${core.isDryRun ? 'dry-run' : 'live'}**`,
      `- Outcome: **${result.outcome.toUpperCase()}**`,
      '',
      `Summary: ${result.summary.verified} verified, ${result.summary.failed} failed, ` +
        `${result.summary.unverified} unverified (of ${result.summary.total}).`,
      '',
      '| Post | Status | New time | Reason |',
      '|------|--------|----------|--------|',
    ];
    for (const r of result.results) {
      lines.push(`| ${r.postId} | ${r.status} | ${r.scheduledLocalTime || '—'} | ${(r.reason || '').replace(/\|/g, '/')} |`);
    }
    process.stdout.write(lines.join('\n') + '\n');
  }

  if (result.outcome === 'complete') return EXIT.SUCCESS;
  if (result.outcome === 'partial') return EXIT.VALIDATION_FAILURE;
  return EXIT.TOOLCHAIN_ERROR;
}

/**
 * Main dispatch.
 *
 * @param {string[]} argv - process.argv.slice(2)
 * @returns {Promise<number>} exit code
 */
async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.helpRequested || (!opts.command && !opts.batch)) {
    printHelp();
    return EXIT.SUCCESS;
  }

  const command = opts.command || 'run';

  if (command === 'run' || command === 'dry-run') {
    if (command === 'dry-run') {
      opts.mode = MODE.DRY_RUN;
    }
    return handleRun(opts);
  }
  if (command === 'reschedule') {
    return handleReschedule(opts);
  }
  if (command === 'connect-check' || command === 'doctor') {
    return handleConnectCheck(opts);
  }

  process.stderr.write(`Unknown command: ${command}. Run with --help for usage.\n`);
  return EXIT.VALIDATION_FAILURE;
}

module.exports = { main, parseArgs, handleRun, handleReschedule, handleConnectCheck, EXIT, COMMANDS };

if (require.main === module) {
  Promise.resolve()
    .then(() => main(process.argv.slice(2)))
    .then((code) => process.exit(code))
    .catch((error) => {
      process.stderr.write(`Scheduler encountered an error: ${error.message}\n`);
      process.exit(EXIT.TOOLCHAIN_ERROR);
    });
}
