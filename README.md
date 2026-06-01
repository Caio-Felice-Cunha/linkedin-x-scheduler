# linkedin-x-scheduler

**Bulk-schedule a week of LinkedIn and X (Twitter) posts from your own browser — no API keys, no OAuth, no SaaS.**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen)
![Playwright](https://img.shields.io/badge/built%20with-Playwright-blue)

You write one `batch.json` describing a week of posts (text + images/PDF +
times). The tool attaches to your **already-running, already-logged-in Chrome**
over the Chrome DevTools Protocol, drives each site's real **native Schedule UI**,
and verifies every post landed in the scheduled queue. It never asks for a
password, never touches an API, and never opens a native file dialog.

> Proven on a real 13-post week (3 LinkedIn + 5 X singles + 5 four-image X
> carousels), all scheduled and verified in-queue.

---

## Why this exists

Scheduling a week of content to LinkedIn + X usually means one of:

- **Platform APIs** — OAuth apps, approval, tokens, and X's API isn't free. Overkill for one person posting their own content.
- **Paid SaaS schedulers** — a subscription, and you hand a third party posting rights to your accounts.
- **Doing it by hand** — open each composer, paste, upload, set the time, repeat 13×.

This tool is the fourth option: **drive your own browser.** You're already logged
in; it just automates the clicks you'd do anyway. The hardest part — attaching
local image/PDF files — is solved without the native OS file dialog (which is
what makes browser automation flaky and disruptive): files are handed straight to
the page's upload input.

---

## How it works

```
your batch.json  ─►  scheduler  ──CDP──►  your logged-in Chrome  ─►  LinkedIn / X native "Schedule" UI
                         │
                         └─ dry-run by default · verifies each post in the queue · screenshots every step
```

- **Attaches, never launches.** You start Chrome with a debug port; the tool
  connects to it. Your session/cookies are yours; no credentials are handled.
- **Native scheduling.** It uses each platform's own "Schedule" feature, so posts
  go out exactly as if you'd scheduled them by hand.
- **No file dialogs.** Images/PDFs are attached via the page's file input directly.
- **Safe by default.** `--dry-run` rehearses everything and schedules nothing.

---

## Quick start

### 1. Install

```bash
git clone https://github.com/Caio-Felice-Cunha/linkedin-x-scheduler.git
cd linkedin-x-scheduler
npm install      # installs playwright-core only — NO browser download needed
```

(The tool uses *your* Chrome, so it does not download Playwright's bundled
browsers.)

### 2. Launch Chrome with a debug port

Close Chrome, then start it with remote debugging on a **dedicated profile** and
log in to LinkedIn and X **in that window** (recent Chrome ignores the debug port
on your default profile, so use a separate `--user-data-dir`):

**Windows (PowerShell)**
```powershell
& "C:\Program Files\Google\Chrome\Application\chrome.exe" `
  --remote-debugging-port=9222 `
  --user-data-dir="$env:LOCALAPPDATA\Google\Chrome\scheduler-profile"
```

**macOS**
```bash
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-scheduler-profile"
```

**Linux**
```bash
google-chrome --remote-debugging-port=9222 \
  --user-data-dir="$HOME/chrome-scheduler-profile"
```

Verify it's up:
```bash
npm run connect-check
```

### 3. Try the bundled sample (dry-run — schedules nothing)

```bash
npm run gen-sample          # creates placeholder images/PDF for the example
node src/cli.js --batch examples/sample-batch --dry-run
```

Read the report it prints (and `examples/sample-batch/.scheduler/sample-week/schedule-report.md`).

### 4. Make your own batch and go live

Copy `examples/sample-batch`, replace the assets + post text, edit `batch.json`,
then:

```bash
# rehearse first
node src/cli.js --batch ./my-week --dry-run
# then schedule for real, one post at a time (recommended), e.g.:
node src/cli.js --batch ./my-week --live --only x-single
# or the whole batch:
node src/cli.js --batch ./my-week --live
```

Then **double-check both scheduled queues** in your browser (see the
[PLAYBOOK](./docs/PLAYBOOK.md) — this catches the rare false "done").

---

## The `batch.json` manifest

```json
{
  "id": "my-week",
  "timezone": "America/Los_Angeles",
  "accounts": {
    "linkedin": { "displayName": "Your Name" },
    "x": { "handle": "@your_handle" }
  },
  "posts": [
    {
      "id": "x-single",
      "platform": "x",
      "kind": "image",
      "textFile": "posts/x-single.md",
      "assets": ["assets/x-image.png"],
      "scheduledAt": "2026-06-09 08:00"
    },
    {
      "id": "li-doc",
      "platform": "linkedin",
      "kind": "document",
      "title": "A 3-slide teardown",
      "text": "Inline text works too.",
      "assets": ["assets/li-doc.pdf"],
      "scheduledAt": "2026-06-11 09:00"
    }
  ]
}
```

**Top-level**

| Field | Required | Notes |
|---|---|---|
| `id` | no | Label used in logs/report. Defaults to the folder name. |
| `timezone` | no | Documents which zone `scheduledAt` is in (see note below). |
| `accounts` | no | Enables a logged-in name check before scheduling. |
| `posts` | **yes** | Array of posts (below). |

**Per post**

| Field | Required | Notes |
|---|---|---|
| `id` | no | Unique id (used with `--only`). Defaults to `post-N`. |
| `platform` | **yes** | `"linkedin"` or `"x"`. |
| `kind` | **yes** | LinkedIn: `image`, `document` (PDF carousel). X: `image`, `carousel` (2–4 images). |
| `text` / `textFile` | **yes** | Inline string, or a path to a text file (e.g. `.md`/`.txt`), relative to the manifest. |
| `assets` | **yes** | Paths relative to the manifest. Counts: image=1, document=1, carousel=2–4. |
| `scheduledAt` | **yes** | `"YYYY-MM-DD HH:mm"`, local wall-clock (see note). |
| `title` | no | LinkedIn `document` only — the document's title. |

> **Timezone:** LinkedIn and X schedule in your **browser's** local timezone, and
> this tool sets the wall-clock you give in `scheduledAt` directly (no
> conversion). So set your machine's timezone to match `timezone`. Keep X posts
> within the platform's character limit, or X disables its Schedule button.

---

## Safety model

- **Dry-run is the default.** Live scheduling requires `--live`.
- **Live-publish guard:** if a post ever looks like it published *now* instead of
  being scheduled, the whole batch **stops** and alerts you.
- **Duplicate-safe:** before acting it reconciles against the live scheduled
  queue; a post already there is skipped; an unconfirmed result is reported, never
  silently re-scheduled.
- **No credentials, ever.** It attaches to your session; it cannot see or enter
  your password.
- **Read-only on your content.** It only writes a working dir
  (`<batch>/.scheduler/<id>/`: state, run-log, report, screenshots).

---

## Commands

```bash
node src/cli.js --batch <path> [--dry-run | --live] [--only <id>] [--cdp <url>] [--json]
node src/cli.js connect-check          # verify the CDP attach
node src/cli.js dry-run --batch <path> # force a rehearsal
node src/cli.js reschedule --batch <path> --live  # move existing X posts to new times (in place)
```

### Rescheduling existing posts (X)

Already scheduled a batch and want to shift the times? Edit the `scheduledAt`
values in your `batch.json`, then run **`reschedule`**. It finds each post in your
live X queue by its first line, opens it, and changes only the time. It edits in
place (no delete, no re-create, so no duplicates), is dry-run by default, and is
G3-safe (it only saves via the "Schedule" button, never "Post").

```bash
node src/cli.js reschedule --batch ./my-week --dry-run   # preview (sets + verifies, saves nothing)
node src/cli.js reschedule --batch ./my-week --live      # apply the new times
```

Match-by-first-line means the post text in `batch.json` must still match what's
in your queue. Reschedule is **X-only** today (LinkedIn is on the roadmap).

| Flag | Meaning |
|---|---|
| `--dry-run` | Rehearse; stub the final Schedule click (default). |
| `--live` | Arm the final Schedule click. |
| `--only <id>` | Restrict to one post id. |
| `--cdp <url>` | CDP endpoint (default `http://localhost:9222`). |
| `--json` | Emit the report as JSON. |

---

## Limitations (read before relying on it)

- It drives **web UIs**, so a LinkedIn/X redesign can break selectors until they're
  updated — this is not an API client. The X adapter is the most UI-sensitive.
- Requires Chrome started with a debug port and you logged in (one-time per session).
- Media posts only for now (image / document / carousel); text-only posts are on
  the roadmap.
- One browser session at a time; respects the platforms — it doesn't hammer.

---

## How it was built (the engineering story)

This started as a private tool and was extracted into this repo through a small
**Story Development Cycle**. The process docs are included as a worked example:

- [`docs/PRD.md`](./docs/PRD.md) — product requirements
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — module map + the manifest design
- [`docs/PLAYBOOK.md`](./docs/PLAYBOOK.md) — the operator runbook (step by step)
- [`docs/DEBUG-LOG.md`](./docs/DEBUG-LOG.md) — **every real bug hit and how it was fixed** (the most useful read if you're hacking on the adapters)
- [`docs/STORIES.md`](./docs/STORIES.md) — the extraction stories + acceptance criteria

---

## Contributing

Issues and PRs welcome — especially platform selector fixes and new platform
adapters. See [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) for where things
live.

## License

[MIT](./LICENSE) © Caio Di Felice Cunha
