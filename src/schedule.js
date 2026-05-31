#!/usr/bin/env node
'use strict';

/**
 * Thin entry: `node src/schedule.js --batch <path> [--dry-run|--live] [--only id]`.
 * Forwards to the CLI's `run` dispatch (dry-run by default unless --live).
 */

const { main, EXIT } = require('./cli');

Promise.resolve()
  .then(() => main(process.argv.slice(2)))
  .then((code) => process.exit(code))
  .catch((error) => {
    process.stderr.write(`Scheduler encountered an error: ${error.message}\n`);
    process.exit(EXIT.TOOLCHAIN_ERROR);
  });
