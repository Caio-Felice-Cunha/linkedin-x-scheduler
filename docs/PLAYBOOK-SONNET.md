# Operator Runbook — Sonnet Edition

**What this is:** A low-inference, step-by-step operating and self-repair manual for
the LinkedIn + X scheduler in this repo (`src/cli.js`), covering a full batch run and the
diagnosis/repair of platform-UI-drift breakages.

**Who it is for:** A Claude Sonnet agent (or any operator who wants literal, unambiguous
steps) executing the scheduling workflow autonomously. This document infers little: every
step is atomic, numbered, and provides an exact command, an exact expected output, and an
explicit branch for each outcome. Do not skip steps, do not combine steps, and do not
substitute commands.

**Golden rule:** Follow this document literally. When you reach a STOP condition or a
NEVER-DO item, STOP immediately and report to the operator. Do not improvise.

**Relationship to the other docs:** [`README.md`](../README.md) is the first-time
quick-start. [`PLAYBOOK.md`](./PLAYBOOK.md) is the concise repeatable procedure. THIS file
is the exhaustive, branch-for-everything version plus the self-repair loop and manual
fallbacks. [`DEBUG-LOG.md`](./DEBUG-LOG.md) is the failure history this runbook references
by section id (A–G).

---

## SECTION 1 — NEVER-DO / STOP CONDITIONS

Read this section in full before taking any action.

```
+----------------------------------------------------------------------+
| NEVER-DO LIST — any of these is an IMMEDIATE STOP + report to the     |
| operator                                                             |
+----------------------------------------------------------------------+
| 1. NEVER allow a native OS file-open dialog to appear and stay open. |
|    Any code path that attaches a file MUST register the persistent   |
|    page.on('filechooser') handler BEFORE any click that could open   |
|    an upload picker (LinkedIn document attach), or run the           |
|    filechooser race BEFORE the click (LinkedIn image attach). A      |
|    leaked native dialog orphans the session and can modal-lock the   |
|    desktop (DEBUG-LOG A3, G4). The agent NEVER drives a native OS    |
|    file picker by hand — if a flow ever requires hand-driving the    |
|    native "Open" dialog, that is HUMAN-ONLY (see Section 8a).        |
|                                                                       |
| 2. NEVER blindly re-run a LinkedIn post. The LI scheduled-queue read |
|    is broken (DEBUG-LOG G6): the "View all scheduled posts" view is  |
|    no longer machine-readable, so the dedupe is BLIND — the tool     |
|    CANNOT confirm a LI post is absent. An automated re-run CAN       |
|    CREATE A DUPLICATE post on LinkedIn. Only re-run a LI post after  |
|    a HUMAN has visually confirmed it is absent from the LI scheduled |
|    queue (Phase 4 / Section 8b). Never trust the state file or the   |
|    tool alone to decide a LI re-run.                                  |
|                                                                       |
| 3. NEVER let the run auto-publish live (the G3 guard). The           |
|    live-publish STOP triggers on the REAL signal: the tool's         |
|    output/run-log contains the substring "CRITICAL" or "PUBLISHED    |
|    LIVE" (the LivePublishError message), OR the process exits        |
|    non-zero (exit code 2 on a G3 abort). On ANY of those: STOP the   |
|    whole batch, do not run any more posts, check the LinkedIn and X  |
|    feeds, and report to the operator immediately. (The Markdown      |
|    report also prints "Outcome: ABORTED" and an "ABORT reason" line  |
|    — uppercased by report.js — but do NOT key the STOP on that prose |
|    alone; the authoritative triggers are the CRITICAL / PUBLISHED-   |
|    LIVE substrings and the non-zero exit code.)                      |
|                                                                       |
| 4. NEVER auto-publish. `--live` is ONLY ever used together with      |
|    `--only <id>` in this runbook. The bare `--live` (whole batch in  |
|    one shot) is FORBIDDEN here — it arms the terminal Schedule click |
|    for every pending post with no per-post STOP gate. Schedule one   |
|    post at a time, check its status, then move to the next.          |
|                                                                       |
| 5. NEVER re-schedule or re-run a post whose status is "verified" —   |
|    UNLESS a human check proves it is a FALSE verified (DEBUG-LOG     |
|    F2/E4: status says verified but the post is genuinely absent from |
|    the live queue). Verified posts are skipped automatically by the  |
|    tool. Do not manually reset a genuinely-scheduled verified post.  |
|    The ONLY carve-out is the false-verified case, confirmed by a     |
|    human visual queue check (Section 8b).                            |
|                                                                       |
| 6. NEVER take any irreversible or public action (post, push,         |
|    publish, live-schedule, blind LI re-run) without an explicit STOP |
|    + confirm-with-operator step.                                     |
+----------------------------------------------------------------------+
```

---

## SECTION 2 — ENVIRONMENT FACTS (baked in, never guess these)

| Fact | Value |
|---|---|
| Chrome profile for the scheduler | a DEDICATED `--user-data-dir` you log in to once (this runbook calls it `scheduler-profile`). Recent Chrome ignores `--remote-debugging-port` on the default profile (DEBUG-LOG A4/A6) — you MUST use a separate profile dir. |
| Chrome launch flag | `--remote-debugging-port=9222` |
| CDP endpoint (default) | `http://127.0.0.1:9222` — use `127.0.0.1`, NOT `localhost` (on some systems `localhost` resolves to IPv6 `::1` while Chrome binds the port on IPv4, which refuses the connection — DEBUG-LOG A5) |
| Verify CDP is live | `node src/cli.js connect-check` (or open `http://127.0.0.1:9222/json/version` in any browser — must return a JSON blob) |
| LinkedIn account | your LinkedIn account, logged in inside the scheduler profile |
| X account | your X handle, logged in inside the scheduler profile |
| Timezone for all scheduling | your account's timezone. LinkedIn and X schedule in the BROWSER's local timezone, and the tool sets the wall-clock you give in `scheduledAt` DIRECTLY (no conversion). **GATE:** before trusting any wall-clock target, confirm your account/browser timezone is what you intend. In the X schedule overlay the panel shows the active zone; if it shows anything other than your intended zone, STOP and fix it — the `scheduledAt` values would otherwise land at the wrong wall-clock time. (Note: the report column is labelled "Intended (Pacific)" because the formatter is hard-coded to a Pacific label; the ACTUAL scheduling uses your browser timezone regardless of that label.) |
| Batch input | a batch directory containing `batch.json` (+ its `posts/` text and `assets/` files). See `examples/sample-batch/`. |
| Working dir (per batch) | `<batch-dir>/.scheduler/<batchId>/` — created by the tool |
| State file | `<batch-dir>/.scheduler/<batchId>/schedule-state.json` |
| Run log | `<batch-dir>/.scheduler/<batchId>/schedule-runlog.md` |
| Report | `<batch-dir>/.scheduler/<batchId>/schedule-report.md` |
| Per-step screenshots | `<batch-dir>/.scheduler/<batchId>/scheduler-logs/*.png` |
| X scheduled-queue URL | `https://x.com/compose/post/unsent/scheduled` |
| LinkedIn scheduled queue | NOT a stable URL — open via composer: Start a post → clock icon → "View all scheduled posts" (and it is not machine-readable — G6) |

`<batch-dir>` is the directory holding your `batch.json` (e.g. `./my-week`). `<batchId>` is
the manifest's `id` field (defaults to the batch directory name). `<id>` for `--only` is a
post's `id` from `batch.json` (e.g. `x-single`, `li-doc`) — there is NO week prefix in this
repo.

---

## SECTION 3 — PREREQUISITES CHECKLIST

Run these checks in order. Do not proceed past a failing check. `cd` into the repo root
first (the directory holding `src/cli.js`).

### Check 1: Chrome is running with the debug port

**Command:**
```bash
node src/cli.js connect-check
```

**Pass signal (exact text):**
```
connect-check: attached to Chrome at http://127.0.0.1:9222 (N context(s), N page(s) in context[0]).
Ready. Run `dry-run --batch <path>` to rehearse a batch.
```

**If it fails with `connect-check FAILED` (exit code 2):**
Chrome is not running with the debug port. Launch it now on a DEDICATED profile and log in
to LinkedIn + X in that window:

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

Wait 5 seconds, then repeat Check 1. If it still fails after Chrome is confirmed running on
that profile, try an explicit endpoint: `node src/cli.js connect-check --cdp http://127.0.0.1:9222`.
If still failing, STOP and report that Chrome will not attach on port 9222.

### Check 2: Both accounts are logged in inside the scheduler profile

**How to verify:** In the Chrome window that opened from Check 1, navigate manually to
`https://www.linkedin.com/feed/` — you must see your feed, not a login page. Then navigate
to `https://x.com/home` — you must see your home timeline.

**If either account shows a login page or a 2FA prompt:** STOP. Log in manually in that
Chrome window. The tool NEVER enters credentials. Re-verify after logging in.

### Check 3: The batch manifest validates and assets exist

The authoritative check is the dry-run (Phase 2): the manifest loader validates `batch.json`
and asserts every asset exists at load. A missing asset fails with a message that names the
offending post, e.g. `posts[3] (id "li-doc"): asset not found: <abs path>`. You do NOT need
to re-implement the resolver — a clean dry-run proves the manifest + assets are good.

**Optional fast pre-check (APPROXIMATION):** confirm the manifest parses and list the post
ids before the dry-run:

```bash
node -e "const {loadManifest}=require('./src/manifest'); const m=loadManifest(process.argv[1]); console.log('posts:',m.posts.length); m.posts.forEach(p=>console.log(p.postId, p.platform, p.template, '->', p.target));" ./my-week
```

**Pass signal:** prints `posts: N` and one line per post. **If it throws:** read the message
(it names the offending post + reason), fix `batch.json` or the missing file, and re-run.

### Check 4: X posts are within the character limit

**Why:** X disables its Schedule button when the post text exceeds the platform limit (280
for standard accounts), and the post then silently will not schedule (DEBUG-LOG F1). The
limit applies to the text the tool PASTES into the composer — the trimmed body of the post.

**Command (cross-platform, via Node — measures each X post's trimmed text length):**
```bash
node -e "const {loadManifest}=require('./src/manifest'); const m=loadManifest(process.argv[1]); for(const p of m.posts){ if(p.platform!=='x') continue; const len=(p.postText||'').trim().length; console.log((len>280?'OVER':'ok  ')+' '+len+' '+p.postId); }" ./my-week
```

**Pass signal:** every line starts with `ok`. No line starts with `OVER`.

**If any line starts with `OVER`:** STOP. Trim that post's text (the operator approves the
final wording) to within the limit. The asset image does not change. Re-run this check after
trimming. (If a post sits within a few chars of 280, glance at the exact text — emoji and
links can shift the platform-counted length.)

---

## SECTION 4 — OPERATING PROCEDURE (Phase by Phase)

### Phase 1: Pre-flight

All 4 checks in Section 3 must pass before proceeding. Do not proceed with any failing
check.

**Phase 1 gate:** All checks pass. Proceed to Phase 2.

---

### Phase 2: Dry-run validation

The dry-run drives every step through the G3 pre-click label read — compose, attach, set
schedule, confirm the "Schedule" button label — but STUBS the terminal Schedule click.
Nothing is scheduled. This is the safe verification pass and dry-run is the DEFAULT mode.

**About `--only <id>`:** the id is the post's `id` from `batch.json` exactly (e.g.
`x-single`, `li-image`, `li-doc`). There is no week prefix. To list the exact ids:
```bash
node -e "const {loadManifest}=require('./src/manifest'); loadManifest(process.argv[1]).posts.forEach(p=>console.log(p.postId));" ./my-week
```

**About the dry-run success tokens (verify these, case-robust):** in dry-run the adapter
returns status `dry-run-ok` for each rehearsed post. The CLI's batch outcome is one of
`complete` / `partial` / `aborted`, and the Markdown report prints it as
`Outcome: **COMPLETE**` (uppercased by `report.js`). The report's per-post Status column
shows `dry-run-rehearsed` (the report-only label for an attempted-in-dry-run post). When
checking text, match the TOKEN case-insensitively (e.g. `/outcome:\s*\*?\*?complete/i`,
`/dry-run-ok/i`, `/dry-run-rehearsed/i`) — never key on an exact prose casing.

**Step 2.1 — Rehearse the whole batch (safe, schedules nothing):**

```bash
node src/cli.js dry-run --batch ./my-week
```

**Expected output:** Exit code 0, batch outcome `complete` (report shows `Outcome: COMPLETE`,
case-insensitive), every post `dry-run-rehearsed`.

**Step 2.2 — (optional) Rehearse one specific post:**

```bash
node src/cli.js dry-run --batch ./my-week --only li-doc
```

**Expected output:** Same as 2.1. Exit code 0. If the id does not exist, the CLI exits 1
with `Error: --only <id> is not a post id in this batch.` — do NOT invent an id; list them
with the command above.

**Step 2.3 — Read the dry-run report:**

```bash
node -e "console.log(require('fs').readFileSync('./my-week/.scheduler/<batchId>/schedule-report.md','utf8'));"
```

Substitute `<batchId>` (your manifest `id`). Or open the file directly. Every post run in the
dry-run should show report Status `dry-run-rehearsed`; the per-post adapter status returned
during the run is `dry-run-ok`.

**Phase 2 decision table (every branch covered):**

| Result | Action |
|---|---|
| All posts rehearsed (adapter `dry-run-ok`, report Status `dry-run-rehearsed`), outcome `complete`, exit 0 | Proceed to Phase 3 |
| Any post shows report Status `failed` — read its `Reason` cell / `lastError` | Go to Section 6, match the symptom, apply the fix, then re-run the dry-run for that post |
| Outcome `partial` (exit 1) but no `failed` post visible | A post was attempted but neither verified nor failed (`incomplete`). Read the report + run-log, identify the post, treat it like a failure (Section 6) |
| Exit code 2 (`aborted`) with NO `CRITICAL` / `PUBLISHED LIVE` in output | Chrome lost connection or pre-flight stopped. Repeat Check 1, read the run-log / `ABORT reason` line, then re-run |
| Exit code 2 AND output/run-log contains `CRITICAL` or `PUBLISHED LIVE` | This must NOT happen in dry-run (terminal click is stubbed). STOP, treat as a code/safety bug, report to the operator — do NOT proceed to live |
| Any native OS dialog appeared (file-open dialog visible on desktop) | STOP. Close the dialog (Section 8c), then go to Section 7 self-repair |

---

### Phase 3: Go-live per post

**HARD RULE — always per-post: `--live` is ONLY ever used together with `--only <id>`.**
NEVER run a bare `--live`. The whole-batch `node src/cli.js --batch ./my-week --live` form
arms the terminal Schedule click for EVERY pending post in one shot — an irreversible action
with no per-post STOP gate. That escape hatch is FORBIDDEN in this runbook. Schedule one post
at a time, check its status, then move to the next. (The CLI technically accepts a bare
`--live`; this runbook does not use it.)

The ONLY live command pattern — one post, by its manifest id:

```bash
node src/cli.js --batch ./my-week --live --only <id>
```

**Get the real id list first** (do not assume the shape — batches differ):

```bash
node -e "const {loadManifest}=require('./src/manifest'); loadManifest(process.argv[1]).posts.forEach(p=>console.log(p.postId));" ./my-week
```

Then run one line per post, checking status after each, in a safe order (LinkedIn before X).
Example for the bundled `sample-batch` ids (yours will differ):

```bash
node src/cli.js --batch ./my-week --live --only li-image
node src/cli.js --batch ./my-week --live --only li-doc
node src/cli.js --batch ./my-week --live --only x-single
node src/cli.js --batch ./my-week --live --only x-carousel
```

**After each post command, check its status in the state file:**

```bash
node -e "const s=JSON.parse(require('fs').readFileSync('./my-week/.scheduler/<batchId>/schedule-state.json','utf8')); const p=s.posts.find(x=>x.postId==='<id>'); console.log(p.postId, p.status, p.lastError||'');"
```

**Per-post status lookup table.** "Status" below is the post's `status` field in the state
file (one of: `pending`, `composing`, `texted`, `attached`, `timed`, `scheduled`,
`verified`, `failed`) AND/OR the adapter's returned status string for the run (`verified`,
`dry-run-ok`, `scheduled-unverified`, `failed`). The G3 row is keyed on the tool's
OUTPUT/exit, not on a state field. Match every token case-insensitively.

| Status / signal | Meaning | Exact action |
|---|---|---|
| `verified` | Scheduled AND confirmed in the live queue (X) or via dedupe/queue match | Done for this post. Proceed to the next. (LI rarely reaches `verified` automatically — see G6.) |
| `scheduled-unverified` (X post) | Tool took the schedule action but the queue read was inconclusive | Go to Phase 4 to visually confirm in the X queue. Do NOT re-run unless Phase 4 proves it ABSENT. |
| `scheduled-unverified` (LI post) | Tool took the schedule action but the LI queue is not machine-readable (G6) | **EXPECTED for LI — this is the normal LI outcome.** Do NOT re-run. The tool CANNOT confirm presence OR absence. Confirm by HUMAN visual check in Phase 4 only. |
| `failed` | Stopped before the terminal Schedule click (safe — nothing was posted live) | Check the `lastError` field. Match to Section 6. Fix, then re-run ONLY this post (LI: re-run only after a human confirms absence — NEVER-DO #2). |
| **G3 live-publish: output/run-log contains `CRITICAL` or `PUBLISHED LIVE`, OR the process exits non-zero (code 2 on a G3 abort)** | A live-publish signal was detected during a live click | **STOP THE ENTIRE BATCH.** Do not run any more posts. Check LinkedIn and X feeds. Report to the operator immediately. (Do NOT key this on the report's `Outcome: ABORTED` prose alone — the authoritative triggers are the `CRITICAL` / `PUBLISHED LIVE` substrings and the non-zero exit.) |
| `dry-run-ok` (during a `--live` run) | The adapter returned the DRY-RUN status while you intended a live run | NOTHING was scheduled — the run was not actually live. The mode resolved to dry-run (e.g. `--dry-run` was also present, or you used the `dry-run` subcommand). INVESTIGATE: re-issue as `--batch ./my-week --live --only <id>` with NO `--dry-run` flag. Do not assume the post is scheduled. |
| `dry-run-ok` (during a dry-run) | EXPECTED success of a rehearsal; terminal click was never made | Normal Phase 2 outcome. To go live, run the post with `--live --only <id>`. No reset needed — the adapter resets a non-pending post to pending after the blind-safe dedupe check before re-driving. |
| `scheduled` (state field, no adapter result) / `timed` / `composing` / other mid-states | A run stopped partway (left the post mid-machine) | Read the run-log + report Reason. Treat as a failure: match Section 6, fix, then re-run this one post (LI: human-confirm absence first). |

**NOTE on LinkedIn `document` (LI-CAROUSEL) posts specifically:**
Due to DEBUG-LOG G5 (document finalization is flaky run-to-run), if a `document` post fails
at `attach-document` or the `Done` step, do NOT loop the tool on it. Attempt the tool ONCE.
If it fails, use the manual document-scheduling procedure in Section 8a — which is HUMAN-ONLY
(a human drives the native file picker; the agent must not). If it SUCCEEDS, treat it like
any other LI post (Phase 4 human visual check).

---

### Phase 4: Verify both queues (mandatory)

This phase is mandatory regardless of per-post statuses. Run it after all posts have been
attempted. Per-post `verified` can occasionally be a false positive (F2/E4) — the queue is
the source of truth.

**X queue verification (automated — X IS machine-readable):**

This is a READ-ONLY probe. IMPORTANT: do NOT call `browser.close()` on a `connectOverCDP`
connection — that would close your real Chrome. Detach by letting the node process END. The
print captures the FULL queue text (not a slice) so a later entry is never falsely reported
missing (E4).

```bash
node -e "
const { chromium } = require('playwright-core');
(async () => {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.goto('https://x.com/home', { waitUntil: 'commit' });
  await new Promise(r => setTimeout(r, 1000));
  await page.goto('https://x.com/compose/post/unsent/scheduled', { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise(r => setTimeout(r, 2500));
  for (let i = 0; i < 6; i++) {
    await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
    await new Promise(r => setTimeout(r, 600));
  }
  const body = await page.evaluate(() => document.body.innerText || '');
  console.log('--- X SCHEDULED QUEUE (full) ---');
  console.log(body);
  console.log('--- queue chars:', body.length, '---');
  // Do NOT browser.close() — that would close your Chrome. End the process instead.
  process.exit(0);
})();
"
```

**Pass signal:** the output contains the first line of EACH expected X post with a "Will
send on" date. Cross-check the count against the X posts in the id list.

**If any X post is missing from the output:** first re-run THIS read once (the list can
lazy-load) and re-count. If a post is still genuinely absent, reset its state to pending and
re-run that one post (Section 5b).

**If every expected X post is present:** X queue is confirmed. Move to the LinkedIn check.

**LinkedIn queue verification (HUMAN VISUAL CHECK REQUIRED):**

Due to DEBUG-LOG G6, the LI scheduled-posts view is not machine-readable. Verify LinkedIn
posts by human visual check. Do NOT run automated verification for LI.

**Manual LinkedIn queue check steps:**
1. In the scheduler Chrome window, navigate to `https://www.linkedin.com/feed/`
2. Click "Start a post"
3. In the composer, click the clock icon (Schedule post)
4. Click "View all scheduled posts"
5. Confirm each expected LinkedIn post appears with its scheduled date
6. Count them. Every LI post for the batch must appear.

**If a LI post is present in the queue:** it is confirmed — done.

**If a LI post is missing from the queue:**
- Check its status in the state file. If it is `verified` but absent here, it is a
  false-verified artifact (F2) — the NEVER-DO #5 carve-out applies.
- Do NOT re-run the tool on it on the tool's word alone. This HUMAN visual check IS the
  confirmation of absence (the tool cannot confirm absence for LI — G6).
- Once a human has confirmed it is genuinely absent, schedule it manually using Section 8a
  (HUMAN-ONLY), then mark it via 8a step 19.

**Phase 4 completion signal:** All X posts confirmed present in the X queue; all LI posts
confirmed present by human visual check. Any post NOT confirmed is listed in the final report
under ITEMS REQUIRING ATTENTION.

---

## SECTION 5 — POST-STATUS ACTIONS AND STATE RESETS

### 5a. Re-running a failed post

**X posts — re-run is dedupe-protected (X queue IS machine-readable):**

```bash
node src/cli.js --batch ./my-week --live --only <id>
```

The tool resets a non-pending, non-verified post and runs the dedupe queue-read before
acting. For X, that queue-read works, so if the post is already in the X scheduled queue
(from a prior partial run) it is matched, marked `verified`, and skipped without
double-posting.

**LinkedIn posts — re-run is NOT dedupe-protected. Hard rule (overrides any "re-run is
safe" wording elsewhere):** the LinkedIn dedupe queue-read is BLIND (G6 — the "View all
scheduled posts" view is no longer machine-readable). The tool CANNOT confirm a LI post is
absent, so an automated re-run CAN CREATE A DUPLICATE. Therefore:

- NEVER blindly re-run a LI post.
- Only re-run a LI post after a HUMAN has visually confirmed (Phase 4 / Section 8b) that it
  is ABSENT from the LI scheduled queue.
- If you cannot get a human confirmation of absence, do NOT re-run — leave it and report.
  "The tool didn't find it" is NOT proof it is absent for LinkedIn.

### 5b. Manually reset a post to pending (for re-runs after partial failures)

**Note on the snippet:** it sets the `status` field directly (not via the state machine), so
it is safe regardless of the prior state — every state is allowed to return to `pending`.
After a dry-run the post's state field is typically `scheduled` with `dryRun: true` (the
report describes that post as `dry-run-rehearsed` / the adapter returned `dry-run-ok`).

**Use this ONLY when ONE of these holds:**
- The status is `failed` and you have fixed the underlying issue.
- The state field is `scheduled`/`timed`/etc. left by a prior DRY-RUN and you now need to go
  live.
- X post: status is `scheduled-unverified` and the Phase 4 X-queue check confirmed it is
  ABSENT from the X queue.
- LI post: a HUMAN Phase 4 visual check confirmed the post is ABSENT from the LI scheduled
  queue AND no duplicate exists (NEVER reset/re-run a LI post on the tool's word alone — G6).

**Do NOT use this when:** the status is a genuinely-scheduled `verified` confirmed present in
the live queue (NEVER-DO #5) — the only `verified` exception is the false-verified case
proven absent by a human check.

Alternatively, the simplest reset is to delete the whole working dir and re-seed from the
manifest: `rm -rf ./my-week/.scheduler` then re-run. Use the per-post reset below when you
want to keep the other posts' verified status.

**Reset command (one post):**
```bash
node -e "
const fs = require('fs');
const p = './my-week/.scheduler/<batchId>/schedule-state.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const post = s.posts.find(o => o.postId === '<id>');
if (!post) { console.error('Post not found'); process.exit(1); }
post.status = 'pending';
post.dryRun = false;
post.verifiedAt = '';
post.attempts = 0;
post.lastError = '';
delete post.reconciled;
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
console.log('Reset to pending:', post.postId);
"
```

Replace `<batchId>` and `<id>` with the actual values.

### 5c. Transient DNS/network error

**Symptom:** output contains `ERR_NAME_NOT_RESOLVED`.

**Action:** re-run the exact same command. This is a transient network blip (DEBUG-LOG F3).
No state change needed.

### 5d. Logged out or 2FA checkpoint

**Symptom:** output contains `logged out`, `sign in`, or `checkpoint` in the run log.

**Action:** do not re-run the tool. Navigate manually in the scheduler Chrome window to the
platform URL and log back in. Then re-run the command.

---

## SECTION 6 — FAILURE LOOKUP TABLE

Match the symptom exactly. Apply the exact fix shown. Do not improvise. "Ref" points at the
matching entry in [`DEBUG-LOG.md`](./DEBUG-LOG.md).

| Symptom | Ref | Diagnostic | Fix |
|---|---|---|---|
| `Composed text length mismatch … got 0` on LinkedIn | G1 | Read `schedule-runlog.md` for `li-insert` actions | The Quill editor ignored insertion. `linkedin.js insertText` uses clipboard-paste as primary with 3 fallbacks (synthetic InputEvent → DataTransfer paste → `pressSequentially`). If you see this, the chain exhausted — likely `.ql-editor` changed. Run the DOM probe (Section 7). |
| `attach-image` timed out on LinkedIn | G2 | Check screenshot `media-attached` / the `attach-image` step | `ensureComposerToolbar` did not find the `^add media$` button (toolbar mounts a beat after the editor, or its label changed). Run the DOM probe (Section 7) to enumerate toolbar buttons. |
| `set-schedule` verify failed (mentions a time) on LinkedIn | G3 | Read `schedule-runlog.md` for `set-schedule` | Old code looked for the literal "Pacific" label which LinkedIn removed. Current `linkedin.js setSchedule` reads field VALUES from `#share-post__scheduled-date` and `#share-post__scheduled-time`. If you see this with current code, those field ids changed. Run the DOM probe. |
| Native OS file dialog appeared; `attach-document` timed out on LinkedIn | G4 | Close the dialog (Section 8c) immediately | The persistent `page.on('filechooser')` handler was not registered before the "Add a document" flow, OR the `#interop-outlet` overlay intercepted the menu clicks. Current `linkedin.js attachDocument` registers a PERSISTENT handler and DOM-dispatches the "More"/"Add a document" clicks. Do NOT reintroduce a one-shot `waitForEvent` — it leaves an interception gap. See Section 7. |
| LI `document` `Done` button never enables / `document processed (Done enabled)` verify times out | G5 | Read screenshots for the `attach-document` step | KNOWN OPEN ISSUE. Do not attempt a code fix. This document post is scheduled by a HUMAN manually — Section 8a (HUMAN-ONLY). |
| `scheduled-unverified` on any LinkedIn post | G6 | Human visual check in Phase 4 | EXPECTED — the LI queue view is not machine-readable. Confirm by HUMAN visual check. Do NOT re-run the tool (dedupe is blind → duplicate risk). |
| Output/run-log contains `CRITICAL` or `PUBLISHED LIVE`, or the process exited non-zero on a live click | E3 (G3 guard) | Check feeds immediately; read the run-log / `ABORT reason` | A live-publish was detected (`LivePublishError`). The batch already STOPPED itself (outcome `aborted`, exit 2). STOP all further posts, check LinkedIn + X feeds, report, offer to delete the live post. Do NOT key this on the report `Outcome: ABORTED` prose alone. |
| `strict mode violation: resolved to 2 elements` on X | C1 | Check which selector in `x.js` triggered it | X overlays the compose modal on the home timeline — two of every control exist. Selectors must be scoped to `[role="dialog"]`. Check the editor/schedule selectors in `x.js`. |
| `goto` hung / timeout on `/compose/post` on X | C2 | Read `schedule-runlog.md` for the open-composer step | `openComposer` in `x.js` resets via `/home` first, then `/compose/post` with `waitUntil:'commit'`. If this recurs, check whether X changed its SPA routing. |
| X text inserted but editor shows wrong/duplicated content | C3/C4/C5 | Read `schedule-runlog.md` for the X insert method used | Clipboard-paste is the proven method; the alnum matcher rejects typed duplication. Confirm `clipboard-paste` is primary in `x.js`. |
| X editor text accumulated across posts (draft restored) | C6 | Read `schedule-runlog.md` for X clear actions | `reliableClear` loops up to 8 times to clear. If text still accumulates, X may have a new draft-persistence mechanism. Run the DOM probe. |
| `schedule control absent/disabled` on X | D1 | Check the X schedule-step screenshot | The `[data-testid="scheduleOption"]` button was not found, or a Playwright actionability-checked click timed out during media upload. Current code dispatches the click in-page. If the button exists visually but was not found, run the DOM probe for the exact testid. |
| X schedule selects not set / verify failed | D2/D3 | Check the X schedule-step screenshot | The 5 `<select>`s (Month/Day/Year/Hour/Minute) had not rendered, or Hour is AM/PM not 24h. Current code polls for the selects and reads `selectedIndex`. Check the screenshot for the actual select values. |
| Composer closed but post not scheduled (silent no-op) | D4 | Read `schedule-runlog.md` for the X schedule-effect step | The terminal click did not register. The code polls for the dialog to close and re-clicks once (duplicate-safe). If it still did not take, verify in Phase 4 whether the post actually scheduled. |
| X queue navigate hung | E1 | Check run log for the X queue step | The queue read navigates via `/home` first. If it still hangs, X's SPA is in a bad state. Restart the check manually (Phase 4 command). |
| Post WAS scheduled but the queue check returned false | E2/E4 | Run the Phase 4 X queue check manually | Emoji or curly quotes in the first line caused a mismatch (the matcher strips emoji + normalizes quotes; the truncation fallback requires an 80-char prefix). Read the full queue text to confirm. |
| X post over the char limit, Schedule button disabled | F1 | Re-run Check 4 | Trim the post text to within the limit (operator approves wording). Re-run that post after trimming. |
| Post shows `verified` in state file but absent from live queue | F2/E4 | Phase 4 human check | False verified (stale rehearsal/reconcile artifact). For X: reset to pending (Section 5b), then re-run. For LI: only after a HUMAN confirms absence, then reset + manual schedule (Section 8a). |
| `ERR_NAME_NOT_RESOLVED` | F3 | None needed | Transient DNS. Re-run the same command. |
| `Illegal transition: scheduled → composing` | B6 | Read the state file for that post | A prior dry-run left the post `scheduled`. Current code auto-resets to `pending` after the dedupe check. If it still appears, manually reset (Section 5b). |
| State file missing a `posts` array / not valid JSON | — | `node -e "JSON.parse(require('fs').readFileSync('./my-week/.scheduler/<batchId>/schedule-state.json','utf8'))"` | State file is malformed. Delete the working dir (`rm -rf ./my-week/.scheduler`) and re-run to re-seed from the manifest. |
| `Error: --only <id> is not a post id in this batch.` (exit 1) | — | Check the exact post id | The id must match a `batch.json` post `id` exactly (no week prefix). List them: `node -e "const {loadManifest}=require('./src/manifest'); loadManifest(process.argv[1]).posts.forEach(p=>console.log(p.postId));" ./my-week` |
| `No manifest found at …` (exit 1) | — | Check the `--batch` path | Point `--batch` at a `batch.json` file or a directory containing one. |

---

## SECTION 7 — SELF-REPAIR FOR A NEW UI-DRIFT BREAK

Use this section when a Section 6 symptom says "run the DOM probe" OR when you encounter a
new failure not in the table. Follow the numbered steps EXACTLY in order.

### Step 7.1 — Read the failure artifacts

```bash
node -e "console.log(require('fs').readFileSync('./my-week/.scheduler/<batchId>/schedule-report.md','utf8'));"
node -e "console.log(require('fs').readFileSync('./my-week/.scheduler/<batchId>/schedule-runlog.md','utf8'));"
```

List the screenshots for the failing step:
```bash
node -e "require('fs').readdirSync('./my-week/.scheduler/<batchId>/scheduler-logs').forEach(f=>console.log(f));"
```

Read the screenshot whose name matches the failing step (e.g. `media-attached`,
`schedule-set`, `g3-label-confirmed`). Write down: what step failed, what the error says, and
what the screenshot shows.

### Step 7.2 — Write and run a READ-ONLY DOM probe

CRITICAL: register the persistent filechooser handler FIRST, before any click. This prevents
a native OS dialog from leaking.

CRITICAL: this probe attaches to your real Chrome over CDP (`connectOverCDP`). At the end of
a read-only probe, DETACH by ending the node process (`process.exit(0)`) — do NOT close the
browser inside the probe. End the process to release the connection.

Save the following as a temporary file `probe.js` in the repo root (NOT under `src/`):

```javascript
// probe.js — READ-ONLY DOM probe for UI-drift diagnosis.
// Run: node probe.js
// This script NEVER schedules, NEVER writes, NEVER clicks Schedule/Post.
'use strict';
const { chromium } = require('playwright-core');

const PLATFORM = 'linkedin'; // Change to 'x' for X diagnosis

async function probe() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || await ctx.newPage();

  // ALWAYS register the persistent filechooser handler FIRST.
  // Keeps CDP file-chooser interception ON continuously, so a stray upload
  // picker is intercepted and no native OS dialog appears.
  const onChooser = async () => {
    console.log('FILECHOOSER intercepted — NOT setting files (probe mode)');
  };
  page.on('filechooser', onChooser);

  try {
    if (PLATFORM === 'linkedin') {
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      await new Promise(r => setTimeout(r, 2000));

      const starter = page.getByRole('button', { name: /start a post/i });
      if (await starter.count() > 0) {
        await starter.first().click({ timeout: 10000 });
        await new Promise(r => setTimeout(r, 2000));
      }

      console.log('\n--- COMPOSER BUTTONS ---');
      const buttons = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('button,[role=button]'))
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => ({
            text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80),
            testid: el.getAttribute('data-testid') || '',
            id: el.id || '',
            class: String(el.className).slice(0, 60),
          }));
      });
      buttons.forEach(b => console.log(JSON.stringify(b)));

      console.log('\n--- EDITOR SELECTORS ---');
      for (const sel of ['.ql-editor', '[role="textbox"][contenteditable]', '[contenteditable="true"]']) {
        console.log(sel, '->', await page.locator(sel).count(), 'element(s)');
      }

      console.log('\n--- SCHEDULE DIALOG FIELDS (if open) ---');
      console.log('#share-post__scheduled-date:', await page.locator('#share-post__scheduled-date').count());
      console.log('#share-post__scheduled-time:', await page.locator('#share-post__scheduled-time').count());
    } else {
      await page.goto('https://x.com/home', { waitUntil: 'commit' });
      await new Promise(r => setTimeout(r, 800));
      await page.goto('https://x.com/compose/post', { waitUntil: 'commit' });
      await new Promise(r => setTimeout(r, 2000));

      console.log('\n--- X DIALOG BUTTONS ---');
      const buttons = await page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]') || document;
        return Array.from(dialog.querySelectorAll('button,[role=button]'))
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => ({
            text: (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 80),
            testid: el.getAttribute('data-testid') || '',
          }));
      });
      buttons.forEach(b => console.log(JSON.stringify(b)));

      console.log('\n--- X EDITOR SELECTORS ---');
      for (const sel of [
        '[role="dialog"] div[data-testid="tweetTextarea_0"]',
        '[role="dialog"] div[role="textbox"][contenteditable="true"]',
        'div[data-testid="tweetTextarea_0"]',
      ]) {
        console.log(sel, '->', await page.locator(sel).count(), 'element(s)');
      }

      console.log('\n--- X SCHEDULE CONTROL ---');
      console.log('[data-testid="scheduleOption"]:', await page.locator('[role="dialog"] [data-testid="scheduleOption"]').count());
    }

    console.log('\n--- PROBE COMPLETE (no scheduling performed) ---');
  } finally {
    page.off('filechooser', onChooser);
    // Do NOT call browser.close() — this is your real Chrome over CDP.
    // Detach by ending the process below.
  }
}

probe()
  .then(() => process.exit(0))
  .catch(err => { console.error('Probe error:', err.message); process.exit(1); });
```

**Run the probe:**
```bash
node probe.js 2>&1
```

**Read the output.** It prints every visible button (text, testid, id, class) and the
selector counts. Use this to identify what changed (e.g. the button that used to have
`aria-label="Add media"` now has a different label, or `#share-post__scheduled-date` is now
a different id).

### Step 7.3 — Patch ONLY the failing method

Open the relevant file:
- LinkedIn breakage: `src/platforms/linkedin.js`
- X breakage: `src/platforms/x.js`

Patch ONLY the single method that broke. Do not restructure the file, do not rename
functions, do not change methods that are working.

**Filechooser principle — you must NOT violate this:**
Any method that triggers an upload picker MUST use one of these two patterns:

**Pattern A (persistent handler, used for document attach):**
```javascript
// Register BEFORE the click that triggers the picker
const onChooser = async (fc) => { await fc.setFiles(filePath); };
page.on('filechooser', onChooser);
try {
  // ... all the clicks that might trigger the picker ...
} finally {
  page.off('filechooser', onChooser); // Remove in finally, not before
}
```

**Pattern B (race, used for image attach):**
```javascript
// Start the race BEFORE the click
const [chooser] = await Promise.all([
  page.waitForEvent('filechooser', { timeout: stepTimeoutMs }),
  page.getByRole('button', { name: /^add media$/i }).first().click({ timeout: stepTimeoutMs }),
]);
await chooser.setFiles(pngPath);
```

NEVER do: click the upload button first, then call `setInputFiles`/`waitForEvent` after. That
gap leaks a native OS dialog.

### Step 7.4 — Verify the patch with a dry-run on the failing post

```bash
node src/cli.js dry-run --batch ./my-week --only <id>
```

**Pass signal:** the post's adapter status is `dry-run-ok` (case-insensitive), no errors,
exit code 0, outcome `complete`.

**HARD ATTEMPT COUNTER — this is a number, not a judgment call:** you get AT MOST **ONE**
focused fix attempt per failing step. That is: one probe (7.2) + one patch (7.3) + this one
verifying dry-run. Keep a literal counter for the step you are fixing, starting at 0:

- After the verifying dry-run, if it FAILED, increment the counter.
- If the counter is now `>= 1` (you have used your one attempt), STOP — do NOT probe or patch
  again for this step. Go to the manual fallback (Step 7.5 → Section 8).
- If at ANY point a native OS dialog leaks (the desktop shows a file-open dialog), STOP
  immediately regardless of the counter — close the dialog (Section 8c) and go to the manual
  fallback.

Do NOT define "still failing" by whether it is the "same failure path" — that is fuzzy and
can loop. Use the counter: one attempt, then stop.

### Step 7.5 — Hard stop if the break is intractable

STOP and stop looping if EITHER is true:
- the attempt counter for this step has reached 1 (your single fix attempt did not pass the
  verifying dry-run), OR
- the probe/run ever leaked a native OS dialog (filechooser interception gap).

Do not loop further on this post. Apply the manual fallback (Section 8) for that specific post
— and remember any manual `document` upload is HUMAN-ONLY (Section 8a). Report to the operator
with:
1. The exact error message from the run log
2. The DOM probe output (what changed vs. what the code expects)
3. The patch you attempted (diff)

---

## SECTION 8 — MANUAL FALLBACK PROCEDURES

### 8a. Manual scheduling for a LinkedIn `document` post (G5 fallback) — HUMAN-ONLY

> **HUMAN-ONLY.** This procedure drives the native "Add a document" file picker — exactly the
> native OS file-open dialog that NEVER-DO #1 forbids the agent from driving. The AGENT MUST
> NOT perform steps 5–7 (or any step that opens/operates that native picker). A HUMAN performs
> this manual upload in the browser. The agent's ONLY role here is: (a) tell the human this
> `document` post needs manual scheduling and why (G5), (b) hand over the post text and the
> asset path, and (c) AFTER the human confirms the post is scheduled and visible in the queue,
> run the state-file update in step 19. The agent does NOT click "Add a document", does NOT
> touch the native file picker, and does NOT retry the tool on a `document` post after one
> failed attempt.

Use this when the tool fails on a `document` (LI-CAROUSEL) post at `attach-document` or
`Done`. The tool is attempted ONCE; on failure, a human schedules it by hand.

**The human does steps 1–18 in the scheduler Chrome window:**
1. Navigate to `https://www.linkedin.com/feed/`
2. Click "Start a post"
3. Open the post's text (its `textFile` from `batch.json`, or the inline `text`). Read it in
   full. (The agent can paste this text into chat for the human.)
4. Paste the post text into the LinkedIn composer. Do NOT type it — paste it.
5. Click the "More" button in the composer toolbar (the overflow "..." or "+" icon)
6. Click "Add a document"
7. In the NATIVE file picker dialog, navigate to the post's PDF asset and select it
8. Wait for the PDF to upload and show a page count
9. Enter the document title in the "Add a title" field (use the post's `title` from
   `batch.json` if present)
10. Click "Done"
11. Click the clock icon (Schedule post) in the composer toolbar
12. Set the date in `M/D/YYYY` format (e.g. `6/16/2026`)
13. Set the time in `h:mm AM/PM` format (e.g. `9:00 AM`) — in your account timezone, no
    conversion needed
14. Click "Next"
15. Verify the primary button now reads "Schedule" (NOT "Post")
16. Click "Schedule"
17. Confirm the "Post scheduled" toast appears
18. Click the clock icon again, then "View all scheduled posts" to confirm the post appears

**The agent does step 19 ONLY after the human confirms steps 1–18 are done and the post is
visible in the queue** — update the state file to reflect manual scheduling:

```bash
node -e "
const fs = require('fs');
const p = './my-week/.scheduler/<batchId>/schedule-state.json';
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
const post = s.posts.find(o => o.postId === '<id>');
post.status = 'verified';
post.verifiedAt = new Date().toISOString();
post.lastError = 'manually-scheduled-G5-fallback';
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n', 'utf8');
console.log('Marked verified:', post.postId);
"
```

### 8b. Visual LinkedIn queue confirmation (Phase 4)

1. In the scheduler Chrome window, go to `https://www.linkedin.com/feed/`
2. Click "Start a post"
3. In the composer, click the clock icon (Schedule post)
4. Click "View all scheduled posts"
5. For each expected LI post: confirm its first line appears and the "Posting on [date]"
   label shows the correct date
6. Count: total LI posts visible must equal total LI posts in this batch

**If a post is missing:**
- Check its state-file status.
- If status is `verified` but the post is absent: it is a false-verified artifact (F2).
  Follow Section 8a to schedule it manually.
- If status is `scheduled-unverified`: schedule it manually via Section 8a.
- NEVER run the tool again on a LI post without first confirming it is absent from this view.

### 8c. Recovering from a leaked native dialog

If a native OS file-open dialog appeared and is stuck open, close it manually:

- **Windows:** click the dialog's Cancel button, or press `Esc`, or `Alt+F4` on the dialog
  window.
- **macOS:** click Cancel, or press `Esc` / `Cmd+.`.
- **Linux:** click Cancel, or press `Esc`.

After closing the dialog, go to Section 7 self-repair to identify and fix the root cause
before retrying. A leaked dialog means a file-attach method skipped the filechooser
interception (Pattern A/B in Step 7.3) — that is the bug to fix.

---

## SECTION 9 — COMMIT AND PUSH A FIX

Use this section after making a code fix in `src/platforms/linkedin.js` or
`src/platforms/x.js` that passed the Section 7 dry-run verification. This is a standard
single-repo OSS git flow — there is no special push gate.

### 9a. Commit on a branch

```bash
git checkout -b fix/scheduler-ui-drift-<short-description>
git add src/platforms/linkedin.js
# or: git add src/platforms/x.js
git commit -m "fix(scheduler): <describe what changed> [UI-drift <date>]"
```

Example: `fix(scheduler): update LI attachDocument selector for composer overhaul [UI-drift 2026-06-20]`

### 9b. Merge to the default branch (no-fast-forward)

```bash
git checkout main
git merge --no-ff fix/scheduler-ui-drift-<short-description> -m "fix(scheduler): merge UI-drift fix"
```

### 9c. Push

```bash
git push origin main
```

(If your default branch is not `main`, push that branch by name.) Then open a PR if you work
through pull requests — selector fixes and new platform adapters are exactly the kind of
contribution called out in the README.

---

## SECTION 10 — CURRENT MECHANICS REFERENCE

This section summarizes what the adapters CURRENTLY do (post-June-2026 LinkedIn composer
overhaul). Read it to understand current behavior, not legacy behavior. Full failure history
is in [`DEBUG-LOG.md`](./DEBUG-LOG.md) sections A–G.

### LinkedIn (`src/platforms/linkedin.js`)

**Text insert:** Clipboard paste is the PRIMARY method (`navigator.clipboard.writeText` +
Ctrl+V after `bringToFront` + a clipboard-permission grant for `https://www.linkedin.com`).
`execCommand('insertText')` was removed — it no-ops in the current Quill editor (G1). Fallback
chain: clipboard-paste → synthetic `InputEvent('insertText')` → synthetic DataTransfer paste →
`pressSequentially`. Verified by trimmed-length match (within 5% tolerance) AND a first-line
includes check (only throws if ALL methods fail).

**Image attach:** `ensureComposerToolbar` waits for the `^add media$` button, then a
`Promise.all` race between `waitForEvent('filechooser')` and clicking "Add media", then
`setFiles(pngPath)` on the chooser. No native dialog (G2).

**Document/PDF attach (LI-CAROUSEL):** a PERSISTENT `page.on('filechooser', fc => fc.setFiles(pdf))`
is registered BEFORE the clicks. The "More" + "Add a document" clicks are DOM-dispatched via
`page.evaluate` (bypasses the `#interop-outlet` overlay), with a `setInputFiles` fallback to a
hidden file input. The title field is filled by placeholder `/title/i`. Then it waits for the
`^done$` button to be enabled, clicks it, and verifies the share dialog closed AND `.ql-editor`
is back (G4). KNOWN FLAKY: `Done` enablement is inconsistent run-to-run (G5 — manual fallback,
Section 8a).

**Schedule dialog:** opened via the `^schedule post$` button. Date field
`#share-post__scheduled-date` filled `M/D/YYYY`; time field `#share-post__scheduled-time`
filled `h:mm AM/PM`. Verified by reading the field VALUES directly, not by scraping body text
(the "Pacific" label was removed — G3). Timezone is the browser/account default.

**G3 guard:** after "Next", the primary button must read exactly "Schedule" (not "Post") — the
terminal click is taken only then. After clicking Schedule, a live-publish detector checks for
a "published live" signal vs "scheduled"; a live publish raises `LivePublishError` (message
contains `CRITICAL` + `PUBLISHED LIVE`) and the orchestrator ABORTS the batch.

**Queue verification:** navigate to feed → "Start a post" → clock → "View all scheduled
posts"; `queueContains` reads `document.body.innerText` for the post's first line. KNOWN
BROKEN: this view returns the feed in the current LinkedIn version (G6). The tool reports
`scheduled-unverified` — EXPECTED; confirm by human visual check. The dedupe read is blind, so
NEVER blindly re-run a LI post.

### X (`src/platforms/x.js`) — proven end-to-end

**Open composer:** navigate to `https://x.com/home` (`waitUntil: 'commit'`), then
`https://x.com/compose/post` (`waitUntil: 'commit'`). The `/home` reset prevents stale overlay
state; a same-URL goto with `domcontentloaded` hangs on X's SPA (C2).

**Selector scoping:** ALL selectors are scoped to `[role="dialog"]`. X overlays the compose
modal on the home timeline — every control has a duplicate in the timeline column. Unscoped
selectors hit both → strict-mode violations (C1).

**Text insert:** primary is clipboard paste (`navigator.clipboard.writeText` + `bringToFront`
+ clipboard permission for `https://x.com` + click editor + Ctrl+V). Fallback is
`pressSequentially`. Before each method, `reliableClear` loops up to 8 times
(click → Ctrl+A → Delete) to clear X's draft restoration. The match uses an alnum-only
comparison (strips emoji, which X renders as Twemoji `<img>` that `innerText` drops — C3).

**Image attach:** `[role="dialog"] input[data-testid="fileInput"]` via `setInputFiles`. For a
carousel: a single multi-file `setInputFiles([paths])` is attempted first, then falls back to
one-at-a-time. Verifies the thumbnail count.

**Schedule control:** `[role="dialog"] [data-testid="scheduleOption"]` opened via a DISPATCHED
in-page click (a Playwright actionability-checked click times out when the toolbar shifts
during media upload — D1). Polls for the 5 `<select>` elements before proceeding.

**Date/time selects:** 5 `<select>`s in document order — Month (full name, e.g. "June"), Day,
Year, Hour (24h, NO AM/PM), Minute (zero-padded). Set by label first, fallback by index. UI
timezone = the browser/account default; set wall-clock times directly, no conversion (D2/D3).

**Confirm + G3:** `[data-testid="scheduledConfirmationPrimaryAction"]` dispatched click, then
poll for the primary button to read "Schedule" (not "Post"), then the terminal click on
`[data-testid="tweetButton"]`. After the click, poll for the compose dialog to close; re-click
once if still open (a no-op if already closed — duplicate-safe, D4).

**Queue verification:** `https://x.com/compose/post/unsent/scheduled` (navigate via `/home`
first to avoid the SPA hang — E1). `queueContains` strips emoji from both needle and body,
normalizes curly quotes, and matches by first line (80-char prefix for long first lines, to
avoid the E4 cross-post false match). The X queue IS machine-readable; `verified` is reliable
for X.

---

## SECTION 11 — FINAL REPORT TEMPLATE

After completing the run (all posts attempted, Phase 4 queue verification done), output this
filled-in block:

```
=== SCHEDULER RUN REPORT ===
Batch: <batchId>
Run date: <date>
Operator: Sonnet (automated)

PER-POST STATUS:
| Post ID     | Platform | Template    | Status                                            | Confirmed via          |
|-------------|----------|-------------|---------------------------------------------------|------------------------|
| li-image    | linkedin | LI-SINGLE   | verified / scheduled-unverified / manual / failed | tool / visual / manual |
| li-doc      | linkedin | LI-CAROUSEL | ...                                               | ...                    |
| x-single    | x        | X-SINGLE    | ...                                               | ...                    |
| x-carousel  | x        | X-CAROUSEL  | ...                                               | ...                    |

QUEUE CONFIRMATION:
- X queue: confirmed [N] posts via automated read of /compose/post/unsent/scheduled
- LinkedIn queue: requires human visual check (G6) — [confirmed N posts / pending visual check]

MANUAL ACTIONS TAKEN (if any):
- <list any posts scheduled manually and why>

FIXES APPLIED (if any):
- <file patched, what changed, dry-run pass/fail, commit hash if pushed>

ITEMS REQUIRING ATTENTION:
- <any posts not confirmed, any open issues, any G3 alerts>

=== END REPORT ===
```

---

## APPENDIX A — COMMAND REFERENCE

**Primary interface — `src/cli.js`.** A subcommand is optional: with no subcommand the tool
defaults to `run`, and `run` is dry-run unless `--live` is present.

```
node src/cli.js [run|dry-run|reschedule|connect-check|doctor] --batch <path> [options]
```

| Command | What it does |
|---|---|
| `--batch <path> --live --only <id>` | Schedule ONE post LIVE — the ONLY live form this runbook uses |
| `--batch <path> --live` | (FORBIDDEN here) arms the Schedule click for ALL pending posts at once — no per-post STOP gate. See Phase 3 HARD RULE. |
| `dry-run --batch <path>` | Rehearse the whole batch (safe, nothing scheduled) |
| `dry-run --batch <path> --only <id>` | Rehearse one post (safe) |
| `--batch <path>` | Same as `dry-run --batch <path>` (dry-run is the DEFAULT when `--live` is absent) |
| `reschedule --batch <path> [--live]` | Change existing X posts' times in place to the manifest's `scheduledAt` (X only; dry-run unless `--live`; G3-safe — only saves via "Schedule", never "Post") |
| `connect-check` | Attach to the running Chrome over CDP and report (no scheduling) |
| `doctor` | Environment + CDP connectivity summary (no scheduling); same connect path as `connect-check` |

| Flag | Meaning |
|---|---|
| `--batch <path>` | Path to a `batch.json` file OR a directory containing one |
| `--dry-run` | Rehearse — stub the terminal Schedule click (DEFAULT — safe) |
| `--live` | Arm the Schedule click (real scheduling). In THIS runbook, ONLY with `--only`. |
| `--only <id>` | Restrict to one post; the post's `id` from `batch.json` (no week prefix), e.g. `li-doc` |
| `--cdp <url>` | CDP endpoint (default `http://127.0.0.1:9222`) |
| `--json` | Emit the structured report as JSON |
| `--no-screenshots` | Disable per-step screenshots |

**Mode resolution (important):** the parser sets LIVE only when `--live` is present AND
`--dry-run` is NOT. If both are present, or the `dry-run` subcommand is used, the mode is
dry-run. So a stray `--dry-run` on a "live" command silently keeps it a rehearsal — which is
why a `dry-run-ok` status during an intended live run means nothing was scheduled (Phase 3).

**Exit codes:**
- `0` — complete success (batch outcome `complete`)
- `1` — validation/usage failure: bad/missing manifest, `--only` id not found, unknown
  command, OR a `partial` batch outcome
- `2` — toolchain/environment error: Chrome not reachable, OR a batch that `aborted`
  (including a G3 live-publish abort)

---

## APPENDIX B — RUNTIME PATHS QUICK REFERENCE

For a batch at `./my-week` with `batch.json` `id: "my-week"`:

| Artifact | Path |
|---|---|
| Working dir | `./my-week/.scheduler/my-week/` |
| State file | `./my-week/.scheduler/my-week/schedule-state.json` |
| Run log | `./my-week/.scheduler/my-week/schedule-runlog.md` |
| Report | `./my-week/.scheduler/my-week/schedule-report.md` |
| Screenshots | `./my-week/.scheduler/my-week/scheduler-logs/*.png` |

To re-seed from a changed manifest, delete the working dir (`rm -rf ./my-week/.scheduler`) and
re-run — the state is reseeded from `batch.json` on the next run.
```
