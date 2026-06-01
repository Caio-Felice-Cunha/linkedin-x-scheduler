# Architecture

How the pieces fit, what each module owns, and where to extend.

## Data flow

```
batch.json ──► manifest.js ──► state.fromManifest ──► orchestrator ──► core ──► platform adapter
  (input)       load+validate    seed schedule-state    order + loop    attach    compose→attach→
                resolve text+      (pending)             reconcile       (CDP)     schedule→verify
                assets, map kind                         per platform
                → template
```

1. **`manifest.js`** reads `batch.json`, validates it with friendly errors,
   resolves each post's text (`text` or `textFile`) and asset paths (relative to
   the manifest), and maps the public `kind` to an internal `template`
   (`LI-SINGLE`, `LI-CAROUSEL`, `X-SINGLE`, `X-CAROUSEL`).
2. **`state.js`** seeds a runtime `schedule-state.json` (each post `pending`) on
   the first run, or loads the existing one to **resume**. It owns the per-post
   state machine and crash-safe persistence.
3. **`orchestrator.js`** computes execution order, reconciles against each
   platform's live scheduled queue (idempotency), then drives one post at a time
   through its adapter.
4. **`core.js`** is the shared run context: config, the loaded state, the
   run-log, the screenshotter, the bounded-retry/verify helpers, the CDP
   connection, and the dry-run/live mode.
5. **`platforms/<platform>.js`** is a self-contained adapter that knows that
   site's compose + schedule UI.

## Directory map

```
src/
  cli.js          # arg parsing + dispatch (run / dry-run / connect-check)
  schedule.js     # thin entry → cli.main
  config.js       # tunables (CDP, timeouts, accounts) + working-dir paths
  manifest.js     # batch.json loader/validator  ← the public input layer
  packets.js      # assembles the per-post object an adapter consumes
  state.js        # schedule-state.json: state machine + resume + persistence
  core.js         # shared run context; CDP connect; retry/verify; reconcile
  orchestrator.js # batch order, per-post loop, abort/report
  reschedule.js   # change existing X posts' times in place (no delete/recreate)
  connect.js      # chromium.connectOverCDP attach + optional login-name guard
  helpers.js      # date/label formatting, withRetry, verify-with-poll, firstLine
  runlog.js       # append-only schedule-runlog.md
  screenshot.js   # per-step screenshots → scheduler-logs/
  report.js       # final schedule-report.md (+ JSON)
  platforms/
    linkedin.js   # LinkedIn adapter
    x.js          # X (Twitter) adapter
examples/sample-batch/   # a runnable example (manifest + posts + placeholder assets)
docs/             # PRD, this file, PLAYBOOK, DEBUG-LOG, STORIES
tests/            # pure-logic unit tests (browser mocked)
```

## The per-post state machine

```
pending → composing → texted → attached → timed → scheduled → verified
   └──────────────────────── failed (from any state) ───────────────────┘
```

Each transition is validated and persisted to `schedule-state.json` immediately,
so a crash/stop resumes from the true state. `verified` is reachable directly
from `pending` for the queue-reconcile short-circuit (a post already in the live
queue is marked verified without re-driving).

## Platform adapter contract

An adapter is a class constructed with the `core`. To add a platform, implement:

- `async schedulePost(packet)` → `{ postId, status, scheduledLocalTime, reason? }`.
  Drive the full flow (compose → attach → set schedule → **G3 confirm
  scheduled-mode** → terminal action honouring `core.isDryRun` → verify in queue).
  Throw `LivePublishError` if a live publish is detected (aborts the batch).
- `async queueContains(page, firstLine)` → `boolean`. True iff a post whose first
  line matches is in the live scheduled queue. Powers dedupe + verification.

`packet` (from `packets.buildPacket`) has: `postId, platform, template, target`
(`"YYYY-MM-DD HH:mm"`), `assets` (absolute paths), `postText`, `docTitle`,
`firstLine`.

Register the adapter in `orchestrator.js`'s `adapterFor(post)` and add the
`platform`/`kind`→`template` mapping in `manifest.js`'s `KIND_TEMPLATE`.

### Non-negotiable invariants for any adapter

- **No native OS file dialog** — attach via `setInputFiles` / the `filechooser`
  event only.
- **G3:** positively confirm the terminal action *schedules* (not posts now)
  before taking it; detect a live publish after and abort the batch if seen.
- **Duplicate-safe:** never re-take the terminal action on an inconclusive
  verify — report `scheduled-unverified` instead.
- **Read-only** on the user's content; write only the working directory.

## Rescheduling (X)

The `reschedule` command (`reschedule.js` + `XAdapter.reschedulePost`) changes an
existing post's time without deleting/recreating it. Flow:

1. `gotoScheduledQueue` → the X scheduled queue.
2. `openScheduledPost(page, firstLine)` finds the post by its first line (emoji +
   curly-quote normalized; requires EXACTLY ONE match, else it refuses) and opens
   it in the edit composer.
3. It then reuses the **same** schedule machinery as creating a post —
   `openScheduleControl` → `setSchedule` → `confirmScheduledMode` (G3) →
   `performScheduleAction` → `waitForScheduleEffect` — to set the new time and
   save via the "Schedule" button.
4. Verifies the new "Will send on …" time in the queue.

Editing in place keeps the queue count unchanged (no duplicate). Dry-run sets +
verifies the new time in the overlay, then closes without saving. It is
idempotent (a post already at the target time is skipped). X-only for now.

## Working directory

All runtime artifacts for a batch live in `<batch-dir>/.scheduler/<id>/` (keyed by
the manifest `id`, so two manifests in one directory never share state):
`schedule-state.json` (resume), `schedule-runlog.md`, `schedule-report.md`,
`scheduler-logs/*.png`. Delete it to re-seed from a changed manifest. It is
gitignored.

## Configuration

`config.buildConfig()` centralises the CDP endpoint, bounded-retry ceiling,
per-step/upload/verify timeouts, and the optional expected account identities
(from the manifest's `accounts`). `config.setWorkDir()` points all path helpers
at the batch's working directory.

## Why CDP attach (not Playwright-launched)

The tool connects to *your* Chrome (`chromium.connectOverCDP`) so it reuses your
real logged-in session and never handles credentials. That's why the dependency
is `playwright-core` (the library) with **no bundled-browser download**.
