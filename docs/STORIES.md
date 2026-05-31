# Extraction stories

This repo was extracted from a private tool through a small Story Development
Cycle (PRD → architecture → stories → build → QA). The stories below are what
that extraction actually delivered — included as a worked example of shipping a
focused open-source release.

> See also: [`PRD.md`](./PRD.md) · [`ARCHITECTURE.md`](./ARCHITECTURE.md) ·
> [`PLAYBOOK.md`](./PLAYBOOK.md) · [`DEBUG-LOG.md`](./DEBUG-LOG.md)

---

## Story 1 — Lift the proven engine, untouched

**As** the maintainer, **I want** the battle-tested scheduling engine and both
platform adapters copied verbatim, **so that** the public tool behaves exactly
like the version proven on a real 13-post week.

**Acceptance criteria**
- [x] `core`, `orchestrator`, `connect`, `state`, `helpers`, `report`, `runlog`,
  `screenshot`, and `platforms/{linkedin,x}` are carried over with no logic
  changes.
- [x] Comments are sanitized of internal/private references, with **no behavioral
  edits** (verified by diffing against the originals — only comment lines differ).
- [x] `node --check` passes on every module.

## Story 2 — Replace the private input with a public manifest

**As** a new user, **I want** to describe a batch in one simple `batch.json`,
**so that** I don't have to mirror anyone's private folder layout.

**Acceptance criteria**
- [x] `manifest.js` loads + validates `batch.json` with friendly, post-scoped
  errors (bad platform/kind, missing asset, wrong asset count, missing text, bad
  `scheduledAt`).
- [x] `text` (inline) and `textFile` (path) both supported; assets resolve
  relative to the manifest.
- [x] Public `kind` (`image`/`document`/`carousel`) maps to the engine's
  template; LinkedIn document `title` is honoured.
- [x] First run **seeds** the runtime state; later runs **resume** from it.
- [x] No hard-coded account names or paths anywhere (config-driven).

## Story 3 — Make it installable + runnable by anyone

**As** a cloner, **I want** `npm install` + a bundled example, **so that** I can
dry-run in minutes.

**Acceptance criteria**
- [x] `package.json` with a `bin`, scripts, MIT license, and a **`playwright-core`**
  dependency (no bundled-browser download — the tool uses your Chrome).
- [x] `examples/sample-batch/` runs end-to-end in dry-run, including a generator
  for valid placeholder assets.
- [x] `.gitignore` excludes the per-run `.scheduler/` working dir.

## Story 4 — Document it as a worked example

**As** a reader, **I want** the product thinking, the architecture, the operator
runbook, and the real bug-fix log, **so that** I can use it *and* learn from how
it was built.

**Acceptance criteria**
- [x] README front-door with quick-start, manifest reference, and safety model.
- [x] `docs/`: PRD, ARCHITECTURE, PLAYBOOK, DEBUG-LOG, STORIES.
- [x] The DEBUG-LOG preserves every real failure + fix (the most useful artifact
  for anyone hacking the adapters).

## Story 5 — Quality gate before going public

**As** the maintainer, **I want** an independent check, **so that** nothing
private leaks and a fresh clone works.

**Acceptance criteria**
- [x] No secrets, credentials, or personal identifiers in shipped code/docs.
- [x] Unit tests (browser mocked) pass.
- [x] The manifest → state → packet path works on the sample with no browser.
