'use strict';

const fs = require('fs');
const path = require('path');
const { DemoAdapter } = require('./demo-adapter');

function resolveManifest(batchPath) {
  const resolved = path.resolve(batchPath);
  return fs.statSync(resolved).isDirectory() ? path.join(resolved, 'batch.json') : resolved;
}

function createDemoReport(manifest, adapter = new DemoAdapter()) {
  if (!manifest || !Array.isArray(manifest.posts) || !manifest.posts.length) {
    throw new Error('demo manifest must contain at least one post');
  }
  const items = manifest.posts.map((post) => adapter.simulate(post));
  return {
    schemaVersion: 1,
    tool: { id: 'linkedin-x-scheduler', name: 'LinkedIn + X Scheduler', platforms: ['linkedin', 'x'] },
    mode: 'demo',
    fixture: manifest.id || 'sample-batch',
    generatedAt: '2026-08-29T00:00:00.000Z',
    items,
    summary: { total: items.length, complete: items.length, failed: 0, externalWrites: 0 },
  };
}

function runDemo({ batchPath, outputDir }) {
  const manifestPath = resolveManifest(batchPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const report = createDemoReport(manifest);
  const destination = path.resolve(outputDir);
  fs.mkdirSync(destination, { recursive: true });
  const reportPath = path.join(destination, 'demo-report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  return { report, reportPath };
}

module.exports = { createDemoReport, runDemo, resolveManifest };
