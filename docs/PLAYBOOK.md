# Operator Playbook

The step-by-step you follow each time you schedule a batch. The README has the
first-time quick-start; this is the repeatable procedure + troubleshooting.

## Prerequisites (one-time)

- Node ≥ 18, `npm install` done.
- A **dedicated** Chrome profile you've logged into LinkedIn + X with (see
  README Step 2). You reuse this profile every week.

## The procedure

### Step 0 — Launch the debuggable Chrome

Start Chrome with `--remote-debugging-port=9222 --user-data-dir=<your scheduler profile>`
and leave it open. Confirm:

```bash
node src/cli.js connect-check
```

### Step 1 — Pre-flight your batch

In your batch directory, check:

1. **Text + assets exist** and the manifest validates (a dry-run will tell you).
2. **X posts are within the character limit.** Over-limit disables X's Schedule
   button and the post silently won't go. Quick check for X posts using `textFile`:
   ```bash
   for f in my-week/posts/x-*.md; do
     n=$(node -e "process.stdout.write(String(require('fs').readFileSync('$f','utf8').trim().length))")
     [ "$n" -gt 280 ] && echo "OVER ($n): $f" || echo "ok ($n): $f"
   done
   ```
   (X's limit is 280 for standard accounts.)

### Step 2 — Dry-run (schedules nothing)

```bash
node src/cli.js --batch ./my-week --dry-run
```

Outcome should be **COMPLETE**, every post `dry-run-rehearsed`. Read
`./my-week/.scheduler/schedule-report.md`. If a step fails, the run aborts safely
(nothing scheduled) — see Troubleshooting.

### Step 3 — Go live (one post at a time recommended)

```bash
node src/cli.js --batch ./my-week --live --only <postId>   # repeat per post
# or the whole batch at once:
node src/cli.js --batch ./my-week --live
```

Per post you want **`verified`**. Other statuses:

| Status | Meaning | Action |
|---|---|---|
| `verified` | scheduled AND found in the live queue | done |
| `scheduled-unverified` | action fired, no live-publish, but queue check didn't confirm | **don't blindly re-run** — check the queue (Step 4); re-run only if truly absent |
| `failed` (aborted at set-schedule) | aborted **before** scheduling | clean — re-run that post |
| ALERT / live-publish | possible publish-now | the batch halts itself; verify in the feed |

### Step 4 — Double-check BOTH live queues (mandatory)

Per-post `verified` can occasionally be a false positive. Always finish by
confirming in the browser:

- **X:** open `https://x.com/compose/post/unsent/scheduled` (navigate from
  `x.com/home` first). Confirm each post + its "Will send on …" time.
- **LinkedIn:** Start a post → the clock (**Schedule**) → **View all scheduled
  posts**. Confirm each post + its "Posting …" date.

Count them; match every date/time. Anything missing → Step 5.

### Step 5 — Fix exceptions

- **Over-limit X post** → trim the text, then re-run that post.
- **Missing from queue** (despite a `verified`) → delete `./my-week/.scheduler/`
  (or reset that post's `status` to `pending` in
  `./my-week/.scheduler/schedule-state.json`) and re-run it.
- **`ERR_NAME_NOT_RESOLVED` / transient** → just re-run.
- **Logged out / 2FA** → log in manually in the debuggable Chrome window, re-run.

## Safety recap

Dry-run is the default. A live-publish (instead of schedule) aborts the whole
batch. Verified posts are skipped and the queue is reconciled before acting, so a
re-run never double-posts. No credentials are ever entered.

## Troubleshooting

Hit something not listed here? [`DEBUG-LOG.md`](./DEBUG-LOG.md) records every error
encountered building/running this, with root cause + fix, grouped by area
(attach, LinkedIn, X text, X schedule, verify/safety, content/ops). Most
surprises are already in there.
