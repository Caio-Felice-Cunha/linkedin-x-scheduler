'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createDemoReport, runDemo } = require('../src/demo');
const { parseArgs } = require('../src/cli');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'examples', 'sample-batch', 'batch.json'), 'utf8'));

test('demo report uses the common zero-write contract', () => {
  const report = createDemoReport(fixture);
  assert.equal(report.mode, 'demo');
  assert.equal(report.items.length, fixture.posts.length);
  assert.equal(report.summary.externalWrites, 0);
  assert.ok(report.items.every((item) => item.status === 'simulated' && item.steps.every((step) => step.status === 'complete')));
});

test('demo output is deterministic and configurable', () => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-demo-'));
  try {
    const first = runDemo({ batchPath: path.join(__dirname, '..', 'examples', 'sample-batch'), outputDir: output });
    const firstBody = fs.readFileSync(first.reportPath, 'utf8');
    const second = runDemo({ batchPath: path.join(__dirname, '..', 'examples', 'sample-batch'), outputDir: output });
    assert.equal(fs.readFileSync(second.reportPath, 'utf8'), firstBody);
  } finally {
    fs.rmSync(output, { recursive: true, force: true });
  }
});

test('CLI recognizes demo and output without arming live mode', () => {
  const args = parseArgs(['demo', '--batch', 'examples/sample-batch', '--output', 'site']);
  assert.equal(args.command, 'demo');
  assert.equal(args.output, 'site');
  assert.equal(args.mode, 'dry-run');
});
