# Debug log — every real bug hit, and how it was fixed

This tool was hardened against a live LinkedIn + X account, not in theory. Below
is the actual list of failures encountered and the fix for each, as
**symptom → root cause → fix → where**. If you're extending the adapters and hit
something weird, read this first — most surprises are already here.

"Where" = file under `src/`.

---

## A. Attaching files (the original blocker)

| # | Symptom | Root cause | Fix | Where |
|---|---|---|---|---|
| A1 | Typed file path **leaked into another app** | Global keystroke automation (SendKeys) only lands in the foreground window; the OS blocks a background script from forcing foreground | Don't use keystroke automation at all | — |
| A2 | Upload helper **rejected the file path** | Browser upload tooling restricts which paths it accepts | Drive the page's `<input type=file>` directly via Playwright `setInputFiles` — **no native dialog** | adapters |
| A3 | Native "Open" dialog **orphaned → desktop locked** | Clicking the media button opens the OS chooser; setting the input afterward leaves the modal chooser open | Use the **filechooser event** (`page.waitForEvent('filechooser')` then `chooser.setFiles`) or set the hidden input directly — never click-then-race | `platforms/linkedin.js` |
| A4 | Debug port unreachable | Recent Chrome **ignores `--remote-debugging-port` on the default profile** | Launch a **dedicated `--user-data-dir`** and log in there once | README / PLAYBOOK |
| A5 | Port up in a browser but `connectOverCDP` refuses (`ECONNREFUSED ::1:9222`) | `localhost` resolved to IPv6 `::1` while Chrome binds the port on IPv4 | Connect to `127.0.0.1:9222`, not `localhost` (now the default endpoint) | `config.js` |
| A6 | Relaunching Chrome with the flag still doesn't bind the port | A Chrome already running for that profile is reused and the flag is silently ignored | Use a SEPARATE `--user-data-dir` — it starts its own instance and binds the port even alongside your normal Chrome | PLAYBOOK |

## B. LinkedIn adapter

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| B1 | "composer not present" immediately | The verify did a single check, no polling | Poll until timeout |
| B2 | Composer **closed mid-insert** | An `Escape` (meant to dismiss a popup) triggered the discard/close path | Remove the `Escape` |
| B3 | Schedule step clicked a **calendar day** | A broad `/schedule/i` matched day buttons | Use the precise `"Schedule post"` control + id-based date/time inputs |
| B4 | Document attach hung | A LinkedIn **document** requires a title before it can be added | Fill the required title field |
| B5 | A **live** run was mislabeled "dry-run" | The report read a stale dry-run flag left by a prior rehearsal | Report by the actual run mode |
| B6 | `Illegal transition: scheduled → composing` | A prior dry-run left the post `scheduled`; the machine has no such edge | Reset any non-`pending` post to `pending` before composing (dedupe ran first, so it can't double-post) |
| B7 | verify-in-queue race → false "unverified" | The queue view lags right after the Schedule click | Settle ~3.5 s before reading the queue |

## C. X adapter — text insertion

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| C1 | `strict mode violation: resolved to 2 elements` | X overlays the compose modal on the home timeline → **two** of every control | **Scope every selector to `[role="dialog"]`** (+ `.first()` guard) |
| C2 | `goto` **hung ~30 s** | A same-URL goto with `domcontentloaded` never re-fires on X's SPA | Use `waitUntil:'commit'`; and in `openComposer` **reset via `/home` first** |
| C3 | "all insertion methods mismatched" (text was there) | The match used `includes(firstLine)`, but the first line ended in an **emoji** that X renders as a Twemoji `<img>` (innerText drops it) | Match on **alphanumeric content**, not raw includes |
| C4 | `execCommand insertText` produced **garbage** | execCommand mis-fires on X's Draft.js; the `#` triggers hashtag autocomplete that re-inserts the suggestion | **Removed execCommand**; insert via **clipboard paste** |
| C5 | Typing **duplicated trailing #hashtags** | Per-keystroke hashtag autocomplete | Clipboard **paste** (one shot) — autocomplete never fires; paste also preserves emoji |
| C6 | Text **accumulated** across attempts | X **persists drafts** and restores them; one Ctrl+A/Delete didn't clear | `reliableClear`: loop click→select-all→delete until the editor is empty |
| C7 | Clipboard write failed (`document not focused`) | `navigator.clipboard.writeText` needs focus | `bringToFront()` + grant clipboard permission; fall back to typing (the matcher rejects any duplication → safe) |

## D. X adapter — schedule control + date/time

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| D1 | "schedule control absent/disabled" — but it existed | Playwright's actionability-checked click **timed out (~30 s)** because the toolbar shifts / is briefly obscured during media upload | Use a **dispatched JS click** (`el.click()` in `page.evaluate`) |
| D2 | selects not set / verify failed on later posts | The date/time `<select>`s hadn't rendered when set | **Poll** for the selects before setting |
| D3 | set-schedule verify failed though the time *was* set | The verify scraped body text for the full month name, but the summary uses the abbreviation; also render-timing flaky | **Read the selects' selected values directly** (deterministic); body text is only a fallback |
| D4 | clicking "Schedule" was a **silent no-op** | The terminal click didn't always register | Poll for the **composer to close** (success signal); re-click once if still open (a no-op when already closed → duplicate-safe) |

## E. Verify-in-queue + safety

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| E1 | scheduled-queue URL `goto` hung | Same SPA/same-URL issue | Navigate `/home` first, then the queue URL; retry once |
| E2 | post WAS scheduled but the queue check missed it | The queue preview drops emoji and may render curly quotes | Strip emoji + **normalize quotes/apostrophes** before matching |
| E3 | **double-post risk** on a verify miss | The original code re-scheduled when verify was inconclusive | **Removed the re-schedule.** Report `scheduled-unverified`; never auto-redo |
| E4 | a post reconciled `verified` (attempts: 0) but was **never scheduled** | The queue body is **every** scheduled post's full text concatenated; the matcher's 30-char-prefix fallback matched the post's opening phrase **quoted inside another scheduled post** (two same-batch posts quoting the same phrase) | Full-line match stays primary; the truncation fallback now requires an **80-char** prefix. Same rule applied to the reschedule matchers (`scheduledTimeFor`/`openScheduledPost`), whose per-tile 30-char needles could read/open the WRONG post when the target was absent and one other tile quoted its opening |

## F. Content + operational

| # | Symptom | Root cause | Fix |
|---|---|---|---|
| F1 | X post wouldn't schedule; Schedule button effectively dead | **Post text > the platform character limit** disables X's Schedule button | Keep X posts within the limit (pre-flight check) |
| F2 | a post reported `verified` but was **never actually scheduled** | A stale `verified` from an earlier rehearsal/reconcile (or the E4 reconcile false-match); it was never in the queue | **Always double-check both live queues at the end**; reset state to `pending` + re-run the missing one |
| F3 | run aborted: `ERR_NAME_NOT_RESOLVED` | Transient DNS/network blip in preflight | Just re-run |

---

## The five meta-lessons

1. **No native OS file dialogs — ever.** Drive `<input type=file>` directly. (A)
2. **X renders two of every control** (modal over timeline) → scope to `[role="dialog"]`. (C1, D, E2)
3. **Paste text on X, never type** — typing duplicates #hashtags and breaks on emoji. (C3–C5)
4. **Verify by reading state directly** (select values, composer-closed, queue contents), not by scraping rendered prose — and double-check the live queues at the end. (D3, D4, E4, F2)
5. **Be duplicate-safe:** dedupe before acting, reset-to-pending for re-runs, never auto-re-schedule on a verify miss. (B6, D4, E3)
