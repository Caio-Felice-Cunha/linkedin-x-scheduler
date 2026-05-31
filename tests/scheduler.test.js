'use strict';

/**
 * Unit tests — pure logic + mocked browser. NO live browser, NO live LinkedIn/X.
 * Live UI behaviour is validated by the operator (see docs/PLAYBOOK.md); these
 * tests cover the input layer (manifest → state → packet), the state machine,
 * config, connect (mocked), the orchestrator wiring with stubbed adapters, and
 * guard rails (no OS-dialog automation, no leaked private data).
 *
 * Run: node tests/scheduler.test.js   (or: npm test)
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
let failed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  PASS  ${name}`);
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    console.error(`  FAIL  ${name}`);
    console.error(`        ${error && error.message}`);
  }
}

/** Create a temp batch directory (batch.json + posts + tiny assets) + a workdir. */
function makeBatchFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-test-'));
  fs.mkdirSync(path.join(dir, 'posts'));
  fs.mkdirSync(path.join(dir, 'assets'));
  const asset = (name) => {
    fs.writeFileSync(path.join(dir, 'assets', name), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return `assets/${name}`;
  };
  const post = (name, body) => {
    fs.writeFileSync(path.join(dir, 'posts', name), body);
    return `posts/${name}`;
  };
  const batch = {
    id: 'test-week',
    timezone: 'America/Los_Angeles',
    accounts: { linkedin: { displayName: 'Test User' }, x: { handle: '@test' } },
    posts: [
      { id: 'li-doc', platform: 'linkedin', kind: 'document', title: 'Doc title', textFile: post('li-doc.md', 'LI doc first line.\n\nbody\n'), assets: [asset('doc.pdf')], scheduledAt: '2026-06-09 09:00' },
      { id: 'li-img', platform: 'linkedin', kind: 'image', textFile: post('li-img.md', 'LI image first line.\n\nbody\n'), assets: [asset('li.png')], scheduledAt: '2026-06-11 09:00' },
      { id: 'x-img', platform: 'x', kind: 'image', text: 'X single first line.\n\nbody', assets: [asset('x.png')], scheduledAt: '2026-06-09 08:00' },
      { id: 'x-car', platform: 'x', kind: 'carousel', textFile: post('x-car.md', 'X carousel first line.\n\nbody\n'), assets: [asset('1.png'), asset('2.png'), asset('3.png'), asset('4.png')], scheduledAt: '2026-06-10 17:00' },
    ],
  };
  fs.writeFileSync(path.join(dir, 'batch.json'), JSON.stringify(batch, null, 2));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lxs-work-'));
  return {
    dir,
    workDir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) { void e; }
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch (e) { void e; }
    },
  };
}

/** Minimal mock page (only what connect/orchestrator stubs touch). */
function makePage() {
  return {
    url: () => 'https://www.linkedin.com/feed/',
    goto: async () => {},
    evaluate: async () => '',
    screenshot: async () => {},
    bringToFront: async () => {},
  };
}

function makeChromiumMock(cfg = {}) {
  const log = cfg.log || {};
  const page = makePage();
  const context = { pages: () => [page], newPage: async () => page };
  return {
    connectOverCDP: async (endpoint) => {
      log.connectEndpoint = endpoint;
      if (cfg.connectFails) throw new Error('ECONNREFUSED 127.0.0.1:9222');
      return { contexts: () => (cfg.noContexts ? [] : [context]), close: async () => { log.closed = true; } };
    },
    launch: async () => { log.launchCalled = true; throw new Error('must never launch'); },
  };
}

async function run() {
  const helpers = require('../src/helpers');
  const config = require('../src/config');
  const manifest = require('../src/manifest');
  const { ScheduleState } = require('../src/state');
  const { SchedulerCore, MODE } = require('../src/core');
  const connect = require('../src/connect');
  const packets = require('../src/packets');
  const { Orchestrator } = require('../src/orchestrator');
  const { LivePublishError } = require('../src/platforms/linkedin');

  // ---------------- helpers ----------------
  await test('formatDateMDY → M/D/YYYY', () => {
    assert.strictEqual(helpers.formatDateMDY(helpers.parsePacificTarget('2026-06-09 09:00')), '6/9/2026');
  });
  await test('formatTime12h → h:mm AM/PM', () => {
    assert.strictEqual(helpers.formatTime12h({ hour: 9, minute: 0 }), '9:00 AM');
    assert.strictEqual(helpers.formatTime12h({ hour: 17, minute: 0 }), '5:00 PM');
    assert.strictEqual(helpers.formatTime12h({ hour: 0, minute: 30 }), '12:30 AM');
  });
  await test('label has no hard-coded "Pacific"', () => {
    const label = helpers.pacificLabel('2026-06-09 09:00');
    assert.ok(/Jun 9/.test(label) && /9:00 AM/.test(label), `got "${label}"`);
    assert.ok(!/Pacific/i.test(label), `label must not hard-code a timezone, got "${label}"`);
  });
  await test('parsePacificTarget rejects malformed', () => {
    assert.throws(() => helpers.parsePacificTarget('June 9 2026'), /Invalid target time/);
  });
  await test('firstLine → first non-empty trimmed line', () => {
    assert.strictEqual(helpers.firstLine('\n\n  Hello  \nnext'), 'Hello');
  });
  await test('withRetry stops after maxAttempts', async () => {
    let calls = 0;
    await assert.rejects(() => helpers.withRetry(async () => { calls += 1; throw new Error('boom'); }, { maxAttempts: 2 }), /failed after 2 attempt/);
    assert.strictEqual(calls, 2);
  });
  await test('verify throws on false predicate', async () => {
    await assert.rejects(() => helpers.verify(() => false, 'nope'), /Verification failed: nope/);
    await assert.doesNotReject(() => helpers.verify(() => true, 'ok'));
  });

  // ---------------- config ----------------
  await test('config.buildConfig defaults + overrides', () => {
    const c = config.buildConfig();
    assert.strictEqual(c.cdpEndpoint, 'http://localhost:9222');
    assert.strictEqual(c.maxRetries, 2);
    const c2 = config.buildConfig({ cdpEndpoint: 'http://x:1', maxRetries: 5, accounts: { x: { handle: '@a' } } });
    assert.strictEqual(c2.cdpEndpoint, 'http://x:1');
    assert.strictEqual(c2.maxRetries, 5);
    assert.deepStrictEqual(c2.accounts, { x: { handle: '@a' } });
  });
  await test('config.setWorkDir drives the path helpers', () => {
    const fx = makeBatchFixture();
    try {
      config.setWorkDir(fx.workDir);
      assert.ok(config.stateFilePath().startsWith(fx.workDir));
      assert.ok(config.reportPath().endsWith('schedule-report.md'));
      assert.ok(config.screenshotDir().endsWith('scheduler-logs'));
    } finally { fx.cleanup(); }
  });
  await test('config.isValidBatchId', () => {
    assert.ok(config.isValidBatchId('my-week'));
    assert.ok(!config.isValidBatchId('a/b'));
    assert.ok(!config.isValidBatchId(''));
  });

  // ---------------- manifest ----------------
  await test('loadManifest: valid sample → correct templates + resolved assets', () => {
    const fx = makeBatchFixture();
    try {
      const m = manifest.loadManifest(fx.dir);
      assert.strictEqual(m.batchId, 'test-week');
      assert.strictEqual(m.timezone, 'America/Los_Angeles');
      assert.strictEqual(m.posts.length, 4);
      const byId = Object.fromEntries(m.posts.map((p) => [p.postId, p]));
      assert.strictEqual(byId['li-doc'].template, 'LI-CAROUSEL');
      assert.strictEqual(byId['li-doc'].docTitle, 'Doc title');
      assert.strictEqual(byId['li-img'].template, 'LI-SINGLE');
      assert.strictEqual(byId['x-img'].template, 'X-SINGLE');
      assert.strictEqual(byId['x-car'].template, 'X-CAROUSEL');
      assert.strictEqual(byId['x-car'].assets.length, 4);
      assert.ok(path.isAbsolute(byId['x-car'].assets[0]));
      assert.ok(byId['x-img'].postText.startsWith('X single first line.'));
    } finally { fx.cleanup(); }
  });
  await test('loadManifest: friendly errors', () => {
    const base = makeBatchFixture();
    const write = (mutate) => {
      const doc = JSON.parse(fs.readFileSync(path.join(base.dir, 'batch.json'), 'utf8'));
      mutate(doc);
      fs.writeFileSync(path.join(base.dir, 'batch.json'), JSON.stringify(doc));
    };
    try {
      write((d) => { d.posts[0].platform = 'facebook'; });
      assert.throws(() => manifest.loadManifest(base.dir), /platform/);
      write((d) => { d.posts[0].platform = 'x'; d.posts[0].kind = 'document'; });
      assert.throws(() => manifest.loadManifest(base.dir), /kind/);
      write((d) => { d.posts[0].kind = 'carousel'; d.posts[0].assets = ['assets/1.png']; });
      assert.throws(() => manifest.loadManifest(base.dir), /2.4 images|expects/);
      write((d) => { d.posts[0].assets = ['assets/missing.png', 'assets/1.png']; });
      assert.throws(() => manifest.loadManifest(base.dir), /not found/);
      write((d) => { d.posts[0].assets = ['assets/1.png']; d.posts[0].kind = 'image'; d.posts[0].scheduledAt = 'soon'; });
      assert.throws(() => manifest.loadManifest(base.dir), /scheduledAt/);
    } finally { base.cleanup(); }
  });
  await test('loadManifest: missing manifest → clear error', () => {
    assert.throws(() => manifest.loadManifest(path.join(os.tmpdir(), 'no-such-dir-xyz')), /No manifest found/);
  });

  // ---------------- state (seeded from manifest) ----------------
  const seed = (fx) => {
    config.setWorkDir(fx.workDir);
    const m = manifest.loadManifest(fx.dir);
    return ScheduleState.fromManifest(m, config.stateFilePath());
  };
  await test('fromManifest seeds pending posts + persists', () => {
    const fx = makeBatchFixture();
    try {
      const st = seed(fx);
      assert.strictEqual(st.posts().length, 4);
      assert.ok(st.posts().every((p) => p.status === 'pending'));
      assert.ok(fs.existsSync(config.stateFilePath()));
    } finally { fx.cleanup(); }
  });
  await test('state transitions: legal forward OK, illegal throws', () => {
    const fx = makeBatchFixture();
    try {
      const st = seed(fx);
      st.transition('li-doc', 'composing');
      st.transition('li-doc', 'texted');
      assert.throws(() => st.transition('li-doc', 'verified'), /Illegal transition/);
    } finally { fx.cleanup(); }
  });
  await test('verified-skip + resolveAssets (abs paths, missing detection)', () => {
    const fx = makeBatchFixture();
    try {
      const st = seed(fx);
      for (const s of ['composing', 'texted', 'attached', 'timed', 'scheduled', 'verified']) st.transition('li-img', s);
      assert.ok(st.isVerified('li-img'));
      assert.ok(!st.isVerified('x-img'));
      const ra = st.resolveAssets('x-car');
      assert.ok(ra.ok && ra.paths.length === 4);
      // Break an asset path → reported missing, no throw.
      st.getPost('x-img').assets = ['/nope/missing.png'];
      const bad = st.resolveAssets('x-img');
      assert.ok(!bad.ok && bad.missing.length === 1);
    } finally { fx.cleanup(); }
  });
  await test('persist retries on transient write failure then succeeds', () => {
    const fx = makeBatchFixture();
    try {
      const st = seed(fx);
      const realWrite = fs.writeFileSync;
      let calls = 0;
      fs.writeFileSync = function p(...a) { calls += 1; if (calls === 1) throw new Error('EBUSY'); return realWrite.apply(fs, a); };
      try { st.transition('li-doc', 'composing'); } finally { fs.writeFileSync = realWrite; }
      assert.ok(calls >= 2);
    } finally { fx.cleanup(); }
  });

  // ---------------- packets ----------------
  await test('buildPacket assembles text + assets + docTitle; throws on missing asset', () => {
    const fx = makeBatchFixture();
    try {
      const st = seed(fx);
      const pk = packets.buildPacket(st, 'li-doc');
      assert.strictEqual(pk.platform, 'linkedin');
      assert.strictEqual(pk.template, 'LI-CAROUSEL');
      assert.strictEqual(pk.docTitle, 'Doc title');
      assert.strictEqual(pk.assets.length, 1);
      assert.ok(pk.firstLine.length > 0);
      st.getPost('li-img').assets = ['/nope/x.png'];
      assert.throws(() => packets.buildPacket(st, 'li-img'), /missing asset/);
    } finally { fx.cleanup(); }
  });

  // ---------------- connect (mocked) ----------------
  await test('connect uses connectOverCDP, never launch', async () => {
    const log = {};
    const { browser, page } = await connect.connectToRunningChrome({ endpoint: 'http://localhost:9222', chromium: makeChromiumMock({ log }) });
    assert.strictEqual(log.connectEndpoint, 'http://localhost:9222');
    assert.ok(!log.launchCalled && browser && page);
  });
  await test('connect failure → message about --remote-debugging-port', async () => {
    await assert.rejects(() => connect.connectToRunningChrome({ chromium: makeChromiumMock({ connectFails: true }) }), /--remote-debugging-port=9222/);
  });

  // ---------------- orchestrator (stubbed adapters) ----------------
  const buildCore = (fx, mode) => { seed(fx); return new SchedulerCore({ week: 'test-week', mode, screenshots: false }); };
  const stubAdapter = (platform, behavior) => Object.assign({ platform, queueContains: async () => false, validationRegister: () => [] }, behavior);

  await test('G3 batch abort: a live-publish stops subsequent posts', async () => {
    const fx = makeBatchFixture();
    try {
      const core = buildCore(fx, 'live');
      core.assertLoggedIn = async () => ({ loggedIn: true });
      const calls = [];
      const li = stubAdapter('linkedin', { schedulePost: async (p) => { calls.push(p.postId); throw new LivePublishError(p.postId, 'feed publish'); } });
      const x = stubAdapter('x', { schedulePost: async (p) => { calls.push(p.postId); return { postId: p.postId, status: 'verified', scheduledLocalTime: 'x' }; } });
      const orch = new Orchestrator({ week: 'test-week' }, { core, connectFn: async () => ({ browser: {}, context: {}, page: makePage() }), linkedinAdapter: li, xAdapter: x });
      const result = await orch.run();
      assert.strictEqual(result.outcome, 'aborted');
      assert.ok(/PUBLISHED LIVE/i.test(result.report.abortReason));
      assert.ok(calls.length === 1, 'batch must stop after the live-publish');
    } finally { fx.cleanup(); }
  });

  await test('idempotent resume: verified skipped; queued post reconciled (not re-scheduled)', async () => {
    const fx = makeBatchFixture();
    try {
      const core = buildCore(fx, 'live');
      core.assertLoggedIn = async () => ({ loggedIn: true });
      for (const s of ['composing', 'texted', 'attached', 'timed', 'scheduled', 'verified']) core.state.transition('li-doc', s);
      const attempted = [];
      const li = stubAdapter('linkedin', { queueContains: async (page, fl) => /LI image first line/.test(fl), schedulePost: async (p) => { attempted.push(p.postId); return { postId: p.postId, status: 'verified', scheduledLocalTime: 'x' }; } });
      const x = stubAdapter('x', { schedulePost: async (p) => { attempted.push(p.postId); return { postId: p.postId, status: 'verified', scheduledLocalTime: 'x' }; } });
      const orch = new Orchestrator({ week: 'test-week' }, { core, connectFn: async () => ({ browser: {}, context: {}, page: makePage() }), linkedinAdapter: li, xAdapter: x });
      await orch.run();
      assert.ok(!attempted.includes('li-doc'), 'verified post skipped');
      assert.ok(!attempted.includes('li-img'), 'reconciled-from-queue post not re-scheduled');
      assert.ok(core.state.isVerified('li-img'));
      assert.ok(attempted.includes('x-img'));
    } finally { fx.cleanup(); }
  });

  await test('--only restricts the run without shrinking the state file', async () => {
    const fx = makeBatchFixture();
    try {
      const core = buildCore(fx, 'dry-run');
      core.assertLoggedIn = async () => ({ loggedIn: true });
      const attempted = [];
      const mk = (pl) => stubAdapter(pl, { schedulePost: async (p) => { attempted.push(p.postId); return { postId: p.postId, status: 'dry-run-ok', scheduledLocalTime: 'x' }; } });
      const orch = new Orchestrator({ week: 'test-week', only: 'li-img' }, { core, connectFn: async () => ({ browser: {}, context: {}, page: makePage() }), linkedinAdapter: mk('linkedin'), xAdapter: mk('x') });
      await orch.run();
      assert.deepStrictEqual(attempted, ['li-img']);
      assert.strictEqual(JSON.parse(fs.readFileSync(config.stateFilePath(), 'utf8')).posts.length, 4);
    } finally { fx.cleanup(); }
  });

  await test('dry-run full batch: report has every post', async () => {
    const fx = makeBatchFixture();
    try {
      const core = buildCore(fx, 'dry-run');
      core.assertLoggedIn = async () => ({ loggedIn: true });
      const mk = (pl) => stubAdapter(pl, { schedulePost: async (p) => ({ postId: p.postId, status: 'dry-run-ok', scheduledLocalTime: 'x' }) });
      const orch = new Orchestrator({ week: 'test-week' }, { core, connectFn: async () => ({ browser: {}, context: {}, page: makePage() }), linkedinAdapter: mk('linkedin'), xAdapter: mk('x') });
      const result = await orch.run();
      assert.strictEqual(result.report.mode, 'dry-run');
      assert.strictEqual(result.report.posts.length, 4);
    } finally { fx.cleanup(); }
  });

  // ---------------- guard rails ----------------
  await test('guard: no OS-dialog automation in src/', () => {
    const banned = /SendKeys|#32770|AutoIt|robotjs/;
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && banned.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepStrictEqual(offenders, []);
  });
  await test('guard: no leaked private identifiers in src/', () => {
    const banned = /caio-cunha|@Caio_Cunha|RUNBOOK|EPIC-E|\bAIOX\b/i;
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith('.js') && banned.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.basename(full));
      }
    };
    walk(path.join(__dirname, '..', 'src'));
    assert.deepStrictEqual(offenders, [], `private refs leaked in: ${offenders.join(', ')}`);
  });

  console.log(`\nTests: ${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    for (const f of failures) console.error(`  - ${f.name}: ${f.error && f.error.stack ? f.error.stack : f.error}`);
    process.exitCode = 1;
  }
}

run().catch((error) => {
  console.error('Test harness crashed:', error);
  process.exitCode = 1;
});
