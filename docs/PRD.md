# linkedin-x-scheduler — Product Requirements Document

> **Bulk-schedule a week of LinkedIn and X posts from your own browser — no API keys, no OAuth, no SaaS.**

`linkedin-x-scheduler` is a local, open-source command-line tool that schedules LinkedIn and X (Twitter) posts in bulk by attaching to your *own* already-running, already-logged-in Chrome over the Chrome DevTools Protocol (CDP). It drives each site's real compose and native **Schedule** UI, so it works with personal accounts that have no API access. It never handles credentials, never logs in for you, and by default schedules nothing until you ask it to.

- **License:** MIT
- **Built on:** Node.js + Playwright
- **Status:** Working. Has reliably scheduled a real 13-post week (3 LinkedIn posts, 5 single-image X posts, and 5 four-image X carousels), each verified in the platform's scheduled queue.

---

## 1. Overview

| | |
|---|---|
| **Name** | `linkedin-x-scheduler` |
| **One-line pitch** | Batch-schedule a week of LinkedIn + X posts locally and for free, using your existing logged-in browser session — no API keys, no SaaS subscription. |
| **What it is** | A run-on-demand CLI that reads a simple `batch.json` manifest and places each listed post into the native scheduled queue of LinkedIn and X. |
| **What it is not** | An API client, a hosted service, a content generator, or anything that stores your passwords. |

This tool was originally built for a personal weekly-content workflow and then generalized into a standalone, reusable scheduler.

---

## 2. Problem / Motivation

Creators who post consistently to LinkedIn and X face a recurring "last mile" problem: they have a batch of finished posts ready for the week, but getting each one onto each platform at the right time is slow, manual, and error-prone.

The existing options are all unsatisfying:

- **Official APIs** require app registration, OAuth flows, and access tiers that personal accounts frequently do not have. Posting media (especially multi-image carousels) through the API is fiddly and, for many account types, simply unavailable.
- **Paid scheduling SaaS** works, but it means a subscription, handing a third party access to your accounts, and trusting an external service with your content and your audience.
- **Doing it by hand** means logging in, composing, attaching files, and setting a schedule time one post at a time — repeated for every post, every week.

A specific, stubborn failure point in any homegrown browser-automation attempt is **file upload**. Driving the operating system's native file-open dialog is unreliable: keystrokes can leak into the wrong window, automation tools often reject local file paths, and the dialog behavior changes across OS and browser versions. Most naive automation breaks here.

`linkedin-x-scheduler` solves this by attaching files **directly to the page's `<input type="file">` element** via Playwright's `setInputFiles` / `filechooser` handling. The native OS dialog never opens. That single architectural choice is what makes the tool reliable and non-disruptive — and it is the difference between a fragile script and something that schedules a full week without supervision.

---

## 3. Who It's For

**Target users:** creators, founders, indie developers, and solo marketers who post regularly to LinkedIn and X and want to schedule a week's worth of content at once — locally, for free, and without setting up API access or paying for a SaaS.

### Jobs to be done

- *When I have finished this week's posts,* I want to **queue them all in one command** so I do not have to schedule each one by hand.
- *When my account has no API access,* I want to **schedule through the normal web UI** so I am not blocked by platform API tiers or app-review processes.
- *When I care about my real, public account,* I want a tool that **never handles my password and cannot accidentally post live,** so I can run it without fear.
- *When I post image carousels or PDF documents,* I want **media to attach reliably** so multi-asset posts are not the thing that breaks.
- *When a run is interrupted,* I want to **re-run safely** without double-posting so a crash or a closed laptop is recoverable.
- *When something looks off,* I want a **screenshot and a clear log of every step** so I can see exactly what happened.

---

## 4. Goals and Non-Goals

### Goals

- Schedule many LinkedIn and X posts from a single declarative manifest in one command.
- Use the user's own logged-in browser session — **zero credential handling, zero API keys, zero OAuth.**
- Make accidental live-publishing structurally impossible by default (safe-by-default; see Section 7).
- Support the common post shapes: plain text, single image, multi-image carousel, and LinkedIn document (PDF) posts.
- Be idempotent and duplicate-safe so re-running a partially completed batch is always safe.
- Produce an auditable trail: a screenshot and a log entry for every meaningful step.
- Be free, local, and self-contained — clone, configure a manifest, run.

### Non-Goals

- **Not** an official-API client. The tool drives the web UI; it does not call platform REST/GraphQL APIs.
- **Not** a hosted service, daemon, or cron scheduler. It runs on demand; the platform's own scheduled queue holds the schedule.
- **Not** a content generator, writer, or image renderer. It schedules content you already have.
- **Not** a credential manager. It never sees, stores, or transmits your login.
- **Not** an analytics, engagement, cross-posting, or auto-reply tool. Its job ends when a post is verified in the scheduled queue.
- **Not** a browser launcher or profile manager. You start your own Chrome; the tool attaches to it.

---

## 5. Core Features

- **CDP attach to your own Chrome.** Connects to an already-running, already-logged-in Chrome over the DevTools Protocol. No new browser window, no fresh profile, no re-login, no 2FA prompt.
- **Drives the real native Schedule UI.** Composes into each site's actual editor and uses the platform's own "Schedule" flow — so scheduled posts behave exactly like ones you scheduled by hand.
- **No-dialog file attachment.** Images and PDFs are attached straight to the page's `<input type="file">` via Playwright `setInputFiles` / the `filechooser` event. The OS file picker never appears.
- **One manifest, whole batch.** A single `batch.json` describes every post for the run (see Section 6).
- **Multi-platform, multi-format.** LinkedIn and X; text, single image, multi-image carousel, and LinkedIn document (PDF) posts.
- **Dry-run by default.** The first thing the tool does for free is rehearse the entire batch and schedule nothing (see Section 7).
- **Live-publish abort guard (G3).** A hard safety gate that aborts the whole batch if it ever detects it is about to publish live instead of schedule (see Section 7).
- **Idempotent and duplicate-safe.** Reconciles against the live scheduled queue before acting and skips anything already done — re-runs never double-post.
- **Screenshot + log every step.** Each action is recorded with a screenshot and a log line for full auditability and easy debugging.
- **Timezone-aware scheduling.** Schedule times are interpreted in a timezone you declare, and the exact local time set is recorded.
- **Read-only on your content.** The tool only reads your text and asset files; it never modifies or deletes them.

---

## 6. Input Model — `batch.json`

A run is fully described by one `batch.json` manifest plus an assets folder sitting next to it. The manifest is intentionally small and declarative.

**Top-level fields**

| Field | Description |
|-------|-------------|
| `timezone` | IANA timezone (e.g. `America/Los_Angeles`) in which all `scheduledAt` values are interpreted. |
| `accounts` | Expected account identities per platform, used as a pre-flight safety check that the attached browser is logged into the right account. |
| `posts` | Ordered array of post objects (below). |

**Per-post fields**

| Field | Required | Description |
|-------|----------|-------------|
| `id` | yes | Stable, unique identifier for the post (used for idempotency and the run log). |
| `platform` | yes | `"linkedin"` or `"x"`. |
| `kind` | yes | `"image"`, `"document"`, `"carousel"`, or `"text"`. |
| `text` | yes | Post copy — either inline, or a path to a `.md` file holding the copy. |
| `assets` | for media posts | Array of image/PDF paths (relative to the manifest's folder). |
| `scheduledAt` | yes | Target time as `"YYYY-MM-DD HH:mm"`, interpreted in the top-level `timezone`. |
| `title` | optional | Document title (LinkedIn document/PDF posts only). |

**Example**

```json
{
  "timezone": "America/Los_Angeles",
  "accounts": {
    "linkedin": "your-name",
    "x": "@yourhandle"
  },
  "posts": [
    {
      "id": "li-mon-doc",
      "platform": "linkedin",
      "kind": "document",
      "title": "The 3-step framework",
      "text": "posts/li-mon.md",
      "assets": ["assets/framework.pdf"],
      "scheduledAt": "2026-06-01 09:00"
    },
    {
      "id": "x-mon-single",
      "platform": "x",
      "kind": "image",
      "text": "One change that doubled our reply rate. Thread below.",
      "assets": ["assets/reply-rate.png"],
      "scheduledAt": "2026-06-01 09:30"
    },
    {
      "id": "x-tue-carousel",
      "platform": "x",
      "kind": "carousel",
      "text": "4 slides on why retries are the most expensive line of code.",
      "assets": [
        "assets/retry-1.png",
        "assets/retry-2.png",
        "assets/retry-3.png",
        "assets/retry-4.png"
      ],
      "scheduledAt": "2026-06-02 09:00"
    }
  ]
}
```

**Folder layout**

```
my-week/
├── batch.json
├── posts/
│   └── li-mon.md
└── assets/
    ├── framework.pdf
    ├── reply-rate.png
    └── retry-1.png … retry-4.png
```

---

## 7. Safety Model

The tool is designed so that its default failure mode is **"did nothing,"** never **"published something live."** Four properties enforce this.

1. **Dry-run by default.** With no live flag, the tool rehearses the entire batch end to end — opening composers, attaching files, filling text, and walking the schedule UI — but stops short of the final commit. It schedules nothing. You see exactly what *would* happen, with screenshots, before anything is real. A live run is an explicit, deliberate opt-in.

2. **Live-publish abort guard (G3).** This is the one non-negotiable safety property. Before the final click, the tool verifies that the action it is about to take is **"Schedule"** and not **"Post"/"Post now."** After the click, it verifies the post landed in the **scheduled queue** and is **absent from the live feed.** If it ever detects it is about to publish live — or that a post went live instead of scheduled — it **aborts the entire batch** and alerts you. The whole tool is built so that this guard, not the user's vigilance, is what prevents accidents.

3. **Idempotent and duplicate-safe.** The tool reconciles against the live scheduled queue before acting and tracks per-post status in a local state file. Anything already scheduled and verified is skipped. A crash, an interrupted run, or a plain re-run **never double-posts** — the live queue is the ultimate source of truth for what already exists.

4. **No credentials, ever.** The tool attaches to a browser *you* already logged into. It never sees, stores, types, or transmits a password. It does not handle 2FA. If the session is logged out or hits a verification challenge mid-run, the tool **stops and asks you** rather than guessing — and idempotent resume picks up exactly where it left off.

On top of these, every meaningful step writes a screenshot and a log line, so any run is fully auditable after the fact.

---

## 8. Success Criteria

For a new user who clones the repository, "it works" means:

- They can install dependencies, start Chrome with a remote debugging port, log into LinkedIn and X normally, and have the tool **attach to that session** without any API key or OAuth setup.
- They can write a `batch.json` for a week of posts and run a **dry-run that completes cleanly**, producing a per-post rehearsal report and screenshots — with nothing scheduled.
- A **live run schedules every post** in the manifest into the correct platform's scheduled queue at the declared local times, and each post is **verifiable in that queue** through the normal web UI.
- Media attaches reliably for all supported shapes — single image, multi-image carousel, and LinkedIn PDF document — **without the OS file dialog ever appearing.**
- **Re-running the same batch is safe:** already-scheduled posts are skipped and nothing is duplicated.
- **No post is ever published live by accident.** A simulated live-publish condition triggers the G3 abort instead of posting.
- The whole flow runs **locally and for free,** with no subscription and no third party ever touching the user's credentials.

A concrete proof point: the tool has scheduled a real 13-post week — 3 LinkedIn posts, 5 single-image X posts, and 5 four-image X carousels — with every post verified in-queue.

---

## 9. Out of Scope / Known Limitations

These are deliberate boundaries and honest constraints, not bugs.

- **Requires Chrome with a debug port, logged in by you.** You must start your own Chrome with remote debugging enabled and be logged into both platforms. The tool attaches to that session; it does not launch, configure, or authenticate the browser for you. (This is a one-time setup step, documented in the README.)
- **Web-UI automation, not an API.** Because it drives the real site UI, **platform UI changes can break selectors.** When LinkedIn or X redesigns its composer or schedule dialog, the tool's selectors may need updating. This is the trade-off for needing no API access. The defensive design (verify-before-advance, screenshots, robust accessible-name/role selectors) makes such breakages diagnosable rather than silent.
- **The X flow is the more fragile of the two** and benefits from extra validation, since X's composer internals change more often. The tool treats it defensively and logs verbosely.
- **No official-API features.** Anything that only the API exposes (e.g. certain analytics, programmatic media variants) is out of scope.
- **No hosted scheduling, no daemon.** The tool runs on demand. The schedule itself lives in each platform's own scheduled queue, not in a server this tool runs.
- **No content creation.** It schedules content you supply; it does not write copy or render images.
- **Single-machine, single-session.** It targets one local browser session at a time; it is not a multi-tenant or team-orchestration system.
- **Best-effort on rate limits.** If a platform rate-limits or warns about posting frequency, the tool pauses or stops and reports rather than forcing through.

---

## 10. Possible Roadmap

Directional ideas, not commitments. Community input welcome.

- **More platforms.** Extend the same CDP-attach + native-UI + no-dialog-upload pattern to additional networks (e.g. Threads, Mastodon, Bluesky, Instagram, Facebook Pages) via pluggable platform adapters.
- **Other Chromium browsers.** Support attaching to Edge, Brave, and other Chromium-based browsers.
- **Manifest ergonomics.** A schema/validator for `batch.json`, helpful error messages, and optional generation of a manifest from a folder of assets.
- **Recurring cadences.** Helpers for common weekly/biweekly posting patterns, while keeping the on-demand, no-daemon model.
- **Selector resilience.** A community-maintained selector pack per platform so UI changes can be patched quickly without a full release.
- **Richer reporting.** Exportable run reports (e.g. CSV/JSON of every scheduled post with its verified queue status and screenshot links).
- **Preview/diff mode.** A clearer "here is exactly what each post will look like" preview built on the existing dry-run.
- **Optional thread/multi-tweet support** for X beyond single posts and carousels.

---

*This PRD is the front-door planning document for the `linkedin-x-scheduler` open-source project. Contributions, issues, and platform-adapter PRs are welcome.*
