'use strict';

/**
 * X (x.com) platform adapter (the unproven flow).
 *
 * There is NO validated recipe for X. Every step here is a HYPOTHESIS until
 * confirmed on a live `--dry-run` rehearsal, so the adapter is built
 * defensively:
 *   - robust accessible-name/role selectors (never pixels),
 *   - an ordered text-insertion FALLBACK CHAIN for the Draft.js editor (where
 *     `execCommand insertText` may no-op): clipboard paste → slow `page.type`;
 *     verify after each; STOP if all fail,
 *   - 4-image carousel attach tries one multi-file `setInputFiles` then falls
 *     back to one-at-a-time, asserting exactly four thumbnails,
 *   - the schedule control may be GATED/absent — if so, the adapter does NOT
 *     guess or post now; it marks the post `failed` with a reason and reports,
 *   - the same non-negotiable live-publish guard as LinkedIn,
 *   - a screenshot at EVERY step + a NEEDS_LIVE_VALIDATION register surfaced in
 *     the final report.
 *
 * No native OS file dialog / no global-keystroke automation / read-only on
 * assets — files attach only via `page.setInputFiles`.
 */

const helpers = require('../helpers');
const { LivePublishError } = require('./linkedin');

/**
 * The assumptions that MUST be confirmed on a live run. Surfaced in the
 * orchestrator's final report so the operator knows exactly which X behaviours
 * were verified vs still-unproven on a given run.
 */
const NEEDS_LIVE_VALIDATION = Object.freeze([
  {
    id: 'X-LV-1',
    assumption: 'Which text-insertion method actually works in the Draft.js composer',
    detail: 'execCommand insertText may no-op; the fallback chain records which method succeeded.',
  },
  {
    id: 'X-LV-2',
    assumption: 'Whether 4-image attach accepts a single multi-file setInputFiles or needs one-at-a-time',
    detail: 'The carousel flow tries multi-file first, then falls back; the observed path is recorded.',
  },
  {
    id: 'X-LV-3',
    assumption: 'The schedule control: presence, enabled/gated state, and date/time format',
    detail: 'Native web scheduling is expected free; if the control is gated/absent the post is marked failed (never posted now).',
  },
  {
    id: 'X-LV-4',
    assumption: 'The scheduled/"unsent posts" queue navigation path',
    detail: 'The queue path is unproven; it is screenshotted and confirmed by content, not assumed.',
  },
  {
    id: 'X-LV-5',
    assumption: 'The exact live-publish vs scheduled signals',
    detail: 'Distinguishing "Your post was sent" (live) from a scheduled confirmation needs live confirmation.',
  },
]);

/**
 * Candidate selectors for the X compose editor (Draft.js textbox), MOST-SPECIFIC
 * first. X overlays the compose modal on top of the home timeline, so the page
 * has TWO `tweetTextarea_0` editors (one `[role="dialog"]`, one in
 * `[data-testid="primaryColumn"]`). We must target the dialog one, hence the
 * dialog-scoped selectors lead; `.first()` at the call sites is the final guard.
 */
const X_EDITOR_SELECTORS = Object.freeze([
  '[role="dialog"] div[data-testid="tweetTextarea_0"]',
  '[role="dialog"] div[role="textbox"][contenteditable="true"]',
  'div[data-testid="tweetTextarea_0"]',
  'div[role="textbox"][contenteditable="true"]',
  '.public-DraftEditor-content',
]);

/** Full month names for X's Month <select> (index 1..12). */
const MONTH_FULL = Object.freeze([
  '', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]);

/**
 * The X adapter. One instance per run; reused for every X post. Records each
 * NEEDS_LIVE_VALIDATION item's observed outcome as the run proceeds.
 */
class XAdapter {
  /**
   * @param {import('../core').SchedulerCore} core - the shared run context
   */
  constructor(core) {
    /** @type {import('../core').SchedulerCore} */
    this.core = core;
    /** @type {string} */
    this.platform = 'x';
    /**
     * Observed outcomes for the NEEDS_LIVE_VALIDATION register, keyed by id →
     * 'confirmed' | 'still-unverified' | a freeform observation.
     * @type {Object<string,string>}
     */
    this.observations = {};
    for (const item of NEEDS_LIVE_VALIDATION) {
      this.observations[item.id] = 'still-unverified';
    }
  }

  /**
   * The NEEDS_LIVE_VALIDATION register merged with this run's observations, for
   * the final report.
   *
   * @returns {Array<{id:string, assumption:string, detail:string, observed:string}>}
   */
  validationRegister() {
    return NEEDS_LIVE_VALIDATION.map((item) =>
      Object.assign({}, item, { observed: this.observations[item.id] })
    );
  }

  /**
   * Schedule one X post end to end, driving the state machine. Single image
   * (x-single) or 4-image carousel (x-carousel). Throws LivePublishError on a
   * violation (orchestrator aborts the batch).
   *
   * @param {object} packet - resolved packet (from packets.buildPacket)
   * @returns {Promise<{postId:string, status:string, scheduledLocalTime:string, reason?:string}>}
   * @throws {LivePublishError} on a live-publish detection
   */
  async schedulePost(packet) {
    const { core } = this;
    const { postId } = packet;
    const page = core.page;
    const log = core.runLog;
    const isCarousel = packet.template === 'X-CAROUSEL';
    const scheduledLocalTime = helpers.pacificLabel(packet.target);

    log.append({ postId, action: 'x-schedule-start', detail: packet.template });

    // --- Idempotent dedupe (parity with LinkedIn) ---------------------------
    const already = await this.queueContains(page, packet.firstLine);
    if (already) {
      log.append({ postId, action: 'dedupe', result: 'skip', detail: 'already in scheduled/unsent queue' });
      core.state.transition(postId, 'verified', { verifiedAt: new Date().toISOString(), reconciled: true });
      return { postId, status: 'verified', scheduledLocalTime };
    }

    // A prior rehearsal/partial may have left this post non-pending (e.g.
    // 'scheduled' from a dry-run). The dedupe above confirmed it is NOT in the
    // live queue, so reset to 'pending' for a clean (re)attempt — every state
    // allows → pending, and this cannot double-post (parity with LinkedIn).
    const priorRecord = core.state.getPost(postId);
    if (priorRecord && priorRecord.status !== 'pending') {
      core.state.transition(postId, 'pending', {});
    }

    // --- composing ----------------------------------------------------------
    core.state.transition(postId, 'composing', {});
    await core.withRetry(() => this.openComposer(page), 'x-open-composer', postId);
    await core.screenshot('x-composer-open', postId);
    await core.withRetry(() => this.insertText(page, packet.postText, postId), 'x-insert-text', postId);
    core.state.transition(postId, 'texted', {});
    await core.screenshot('x-text-inserted', postId);

    // --- attached -----------------------------------------------------------
    if (isCarousel) {
      await core.withRetry(() => this.attachImages(page, packet.assets, postId), 'x-attach-carousel', postId);
    } else {
      await core.withRetry(() => this.attachImages(page, [packet.assets[0]], postId), 'x-attach-image', postId);
    }
    core.state.transition(postId, 'attached', {});
    await core.screenshot('x-media-attached', postId);

    // --- timed: schedule control; may be gated ------------------------------
    const scheduleOpened = await this.openScheduleControl(page, postId);
    if (!scheduleOpened) {
      // Gated/absent — do NOT guess, do NOT post now. Mark failed + report.
      core.state.markFailed(postId, 'X schedule control absent or disabled (gated?)');
      await core.screenshot('x-schedule-gated', postId);
      this.observations['X-LV-3'] = 'still-unverified: schedule control not found/enabled';
      return {
        postId,
        status: 'failed',
        scheduledLocalTime,
        reason: 'schedule control absent/disabled — not posted (G3-safe)',
      };
    }
    await core.withRetry(() => this.setSchedule(page, packet.target, postId), 'x-set-schedule', postId);
    core.state.transition(postId, 'timed', { scheduledLocalTime });
    await core.screenshot('x-schedule-set', postId);

    // --- pre-action guard ---------------------------------------------------
    await core.withRetry(() => this.confirmScheduledMode(page, postId), 'x-g3-pre-action', postId);
    await core.screenshot('x-g3-confirmed', postId);

    // --- terminal action honours dry-run/live -------------------------------
    if (core.isDryRun) {
      log.append({ postId, action: 'x-terminal-schedule', result: 'DRY-RUN', detail: 'would schedule' });
      core.state.transition(postId, 'scheduled', { dryRun: true });
      return { postId, status: 'dry-run-ok', scheduledLocalTime };
    }

    await this.performScheduleAction(page);
    // Confirm the schedule actually registered: a successful schedule CLOSES the
    // compose dialog. If the composer is still open after a beat, the click did
    // not land (the silent-miss seen on later batch posts) — re-click ONCE. This
    // is duplicate-safe: performScheduleAction is a no-op when the composer is
    // already closed, so a false-negative retry does nothing.
    let took = await this.waitForScheduleEffect(page);
    if (!took) {
      this.core.runLog.append({ postId, action: 'x-schedule-click', result: 'retry', detail: 'composer still open' });
      await this.performScheduleAction(page);
      took = await this.waitForScheduleEffect(page);
    }
    this.core.runLog.append({ postId, action: 'x-schedule-effect', result: took ? 'composer-closed' : 'composer-still-open' });
    core.state.transition(postId, 'scheduled', {});
    await core.screenshot('x-after-schedule', postId);

    // --- post-action live-publish detection ---------------------------------
    const liveSignal = await this.detectLivePublish(page);
    if (liveSignal) {
      core.state.markFailed(postId, `G3 live publish: ${liveSignal}`);
      this.observations['X-LV-5'] = `confirmed live-publish signal: ${liveSignal}`;
      throw new LivePublishError(postId, liveSignal);
    }

    // --- verify-in-queue ----------------------------------------------------
    // SAFETY: the Schedule action already happened and NO live-publish signal
    // was seen. We do NOT re-schedule when the queue check is inconclusive —
    // re-scheduling would risk a DUPLICATE scheduled post. Give X a beat to
    // persist the post into the unsent/scheduled queue before reading.
    await helpers.sleep(3500);
    const inQueue = await this.queueContains(page, packet.firstLine);
    if (!inQueue) {
      log.append({
        postId,
        action: 'x-verify-in-queue',
        result: 'inconclusive',
        detail:
          'Schedule action completed with no live-publish signal, but the post ' +
          'was not located in the queue view. NOT re-scheduled (duplicate-safe). Verify manually.',
      });
      this.observations['X-LV-4'] = 'still-unverified: scheduled but could not confirm in queue (no re-schedule)';
      return { postId, status: 'scheduled-unverified', scheduledLocalTime };
    }

    core.state.transition(postId, 'verified', { verifiedAt: new Date().toISOString() });
    this.observations['X-LV-4'] = 'confirmed: post found in scheduled queue';
    log.append({ postId, action: 'x-verify-in-queue', result: 'ok' });
    return { postId, status: 'verified', scheduledLocalTime };
  }

  /**
   * Open the X composer on the connected page. Navigates to the compose intent
   * and verifies a Draft.js textbox is present.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async openComposer(page) {
    // Reset to home FIRST, then navigate to compose. A direct same-URL goto to
    // /compose/post does NOT reliably force a clean document reload — stale
    // composer / schedule-overlay state from a prior post or step leaks through
    // and breaks the schedule step on later posts. Routing via home guarantees a
    // real navigation and a fresh composer every time. 'commit' (NOT
    // 'domcontentloaded') avoids the same-URL SPA hang; the editor-presence
    // verify confirms readiness, then a short settle lets the compose machinery
    // (schedule overlay, file input) finish wiring up.
    await page.goto('https://x.com/home', { waitUntil: 'commit' }).catch(() => {});
    await helpers.sleep(800);
    await page.goto('https://x.com/compose/post', { waitUntil: 'commit' }).catch(() => {});
    await this.core.verify(async () => {
      for (const sel of X_EDITOR_SELECTORS) {
        // eslint-disable-next-line no-await-in-loop
        if ((await page.locator(sel).count()) > 0) {
          return true;
        }
      }
      return false;
    }, 'X composer Draft.js textbox present');
    await helpers.sleep(800);
  }

  /**
   * Insert verbatim text into the Draft.js editor via the ORDERED fallback
   * chain. Tries each method, verifying the editor's text after each; the first
   * method whose result matches the expected text wins and is recorded to the
   * NEEDS_LIVE_VALIDATION register. If none succeed, STOPS.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} text - the verbatim post text
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<void>}
   * @throws {Error} if no insertion method produces the expected text
   */
  async insertText(page, text, postId) {
    // Resolve the editor selector.
    let selector = null;
    for (const sel of X_EDITOR_SELECTORS) {
      // eslint-disable-next-line no-await-in-loop
      if ((await page.locator(sel).count()) > 0) {
        selector = sel;
        break;
      }
    }
    if (!selector) {
      throw new Error('X Draft.js editor not found.');
    }

    // Bring the tab to the front so navigator.clipboard.writeText (which needs a
    // focused document) succeeds for the paste method.
    await page.bringToFront().catch(() => {});

    const editor = () => page.locator(selector).first();
    /** Letters+digits only — robust to emoji (X renders them as Twemoji <img>,
     *  so innerText drops the char), hashtag entities, and whitespace/newline
     *  rendering differences. */
    const alnum = (s) => (String(s).toLowerCase().match(/[a-z0-9]/g) || []).join('');

    /** Read the editor's current text content. */
    const readText = async () => {
      try {
        return (await editor().innerText()) || '';
      } catch (error) {
        void error;
        return '';
      }
    };

    /**
     * Reliably empty the editor. X RESTORES unsent drafts on navigation, so a
     * single Ctrl+A/Delete is not enough — loop a real
     * click→select-all→delete until the editor is alnum-empty (max 8).
     */
    const reliableClear = async () => {
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await editor().click().catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.press('Control+A');
        // eslint-disable-next-line no-await-in-loop
        await page.keyboard.press('Delete');
        // eslint-disable-next-line no-await-in-loop
        await helpers.sleep(150);
        // eslint-disable-next-line no-await-in-loop
        if (alnum(await readText()).length === 0) {
          return true;
        }
      }
      return false;
    };

    const expectedAln = alnum(text);
    /** Does the rendered text match the expected (alnum content + prefix)? */
    const matches = (rendered) => {
      const ra = alnum(rendered);
      if (expectedAln.length === 0) {
        return ra.length > 0;
      }
      return (
        ra.includes(expectedAln.slice(0, 30)) &&
        Math.abs(ra.length - expectedAln.length) <= Math.max(8, Math.ceil(expectedAln.length * 0.05))
      );
    };

    // Insertion attempts, best-first. Confirmed on a live X composer:
    //   - clipboard PASTE inserts in one shot, so X's hashtag autocomplete never
    //     fires and emoji survive — the proven-correct method;
    //   - pressSequentially is the fallback (it DUPLICATES trailing #hashtags via
    //     autocomplete, which the alnum matcher rejects → safe abort, never a
    //     garbled post).
    // (execCommand/synthetic-InputEvent/synthetic-paste were removed: they no-op
    // or emit duplicated-hashtag garbage on X's Draft.js.)
    const methods = [
      {
        id: 'clipboard-paste',
        run: async () => {
          await page
            .context()
            .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://x.com' })
            .catch(() => {});
          const wrote = await page.evaluate(async (t) => {
            try {
              await navigator.clipboard.writeText(t);
              return true;
            } catch (e) {
              void e;
              return false;
            }
          }, text);
          if (!wrote) {
            throw new Error('clipboard write failed (document not focused?)');
          }
          await editor().click();
          await page.keyboard.press('Control+V');
          await helpers.sleep(700);
        },
      },
      {
        id: 'slow-type',
        run: async () => {
          await editor().click();
          await editor().pressSequentially(text, { delay: 12 });
          await helpers.sleep(500);
        },
      },
    ];

    let succeeded = null;
    for (const method of methods) {
      // eslint-disable-next-line no-await-in-loop
      await reliableClear();
      try {
        // eslint-disable-next-line no-await-in-loop
        await method.run();
      } catch (error) {
        this.core.runLog.append({
          postId,
          action: `x-insert(${method.id})`,
          result: 'error',
          detail: error.message,
        });
        continue;
      }
      // NB: do NOT press Escape here. On X (as on LinkedIn) Escape in an open
      // composer triggers the discard/close path and wipes the just-inserted
      // text. Our text is bulk-inserted (no per-keystroke @/# autocomplete to
      // dismiss), so no Escape is needed; transient popups are dismissed by the
      // subsequent attach/schedule clicks.
      // eslint-disable-next-line no-await-in-loop
      const rendered = await readText();
      if (matches(rendered)) {
        succeeded = method.id;
        break;
      }
      this.core.runLog.append({
        postId,
        action: `x-insert(${method.id})`,
        result: 'mismatch',
        detail: `rendered length ${rendered.trim().length}`,
      });
    }

    if (!succeeded) {
      this.observations['X-LV-1'] = 'still-unverified: no insertion method matched';
      throw new Error('X text insertion failed — no insertion method produced matching text.');
    }
    this.observations['X-LV-1'] = `confirmed: insertion method "${succeeded}" works`;
    this.core.runLog.append({ postId, action: 'x-insert', result: 'ok', detail: `method=${succeeded}` });
  }

  /**
   * Attach one or four images via setInputFiles. For four images it first tries
   * a single multi-file call, then falls back to one-at-a-time (re-finding the
   * media input between attaches), asserting the expected thumbnail count. NO
   * native dialog.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string[]} paths - 1 or 4 absolute image paths
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<void>}
   * @throws {Error} if the expected thumbnail count is not reached
   */
  async attachImages(page, paths, postId) {
    const expected = paths.length;

    /** Count rendered media thumbnails in the compose dialog (best-effort). */
    const thumbCount = async () => {
      try {
        return await page
          .locator(
            '[role="dialog"] [data-testid="attachments"] img, ' +
              '[role="dialog"] [data-testid^="media"] img, ' +
              '[role="dialog"] div[aria-label*="Image" i] img, ' +
              '[role="dialog"] img[src^="blob:"]'
          )
          .count();
      } catch (error) {
        void error;
        return 0;
      }
    };

    /** Find the media file input WITHIN the compose dialog (the page has a second
     *  identical input in the home-timeline primaryColumn). */
    const fileInput = () =>
      page
        .locator('[role="dialog"] input[data-testid="fileInput"], [role="dialog"] input[type="file"]')
        .first();

    if (expected === 1) {
      await fileInput().setInputFiles(paths[0], { timeout: this.core.config.stepTimeoutMs });
      await this.core.verify(async () => (await thumbCount()) >= 1, 'X single image thumbnail rendered');
      return;
    }

    // 4-image carousel: try a single multi-file call first.
    try {
      await fileInput().setInputFiles(paths, { timeout: this.core.config.stepTimeoutMs });
    } catch (error) {
      this.core.runLog.append({
        postId,
        action: 'x-attach-multi',
        result: 'error',
        detail: error.message,
      });
    }
    await helpers.sleep(500);
    let count = await thumbCount();
    if (count >= expected) {
      this.observations['X-LV-2'] = 'confirmed: multi-file setInputFiles accepted (4 thumbnails)';
    } else {
      // Fall back to one-at-a-time, re-finding the input between attaches.
      this.core.runLog.append({
        postId,
        action: 'x-attach-fallback',
        result: 'one-at-a-time',
        detail: `multi-file produced ${count} thumbnails`,
      });
      for (const p of paths) {
        // eslint-disable-next-line no-await-in-loop
        await fileInput().setInputFiles(p, { timeout: this.core.config.stepTimeoutMs });
        // eslint-disable-next-line no-await-in-loop
        await helpers.sleep(400);
      }
      count = await thumbCount();
      this.observations['X-LV-2'] =
        count >= expected
          ? 'confirmed: one-at-a-time attach needed (4 thumbnails)'
          : `still-unverified: only ${count}/${expected} thumbnails`;
    }

    await this.core.verify(
      async () => (await thumbCount()) >= expected,
      `X carousel: exactly ${expected} thumbnails present`
    );
  }

  /**
   * Open X's schedule control (the compose toolbar calendar/clock icon → date/
   * time inputs). Defensive: returns FALSE if the control is absent/disabled
   * (gated) rather than guessing — the caller marks the post `failed` and never
   * posts now.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<boolean>} true iff a schedule control was opened
   */
  async openScheduleControl(page, postId) {
    try {
      // The schedule affordance is data-testid="scheduleOption" (aria-label
      // "Schedule post"), scoped to the compose dialog (a duplicate exists in
      // the home-timeline primaryColumn behind the modal).
      const scheduleBtn = page.locator('[role="dialog"] [data-testid="scheduleOption"]');
      if ((await scheduleBtn.count()) === 0) {
        this.core.runLog.append({ postId, action: 'x-open-schedule', result: 'absent' });
        return false;
      }
      // Use a DISPATCHED JS click, not Playwright's actionability-checked click:
      // during media upload the toolbar shifts / is briefly obscured by the
      // hashtag-autocomplete popup, so the checked click times out at 30s. A
      // direct el.click() reliably opens the overlay (proven in diagnostics).
      const clicked = await page.evaluate(() => {
        const btn =
          document.querySelector('[role="dialog"] [data-testid="scheduleOption"]') ||
          document.querySelector('[data-testid="scheduleOption"]');
        if (!btn) {
          return false;
        }
        btn.click();
        return true;
      });
      if (!clicked) {
        this.core.runLog.append({ postId, action: 'x-open-schedule', result: 'click-failed' });
        return false;
      }
      // The schedule overlay shows five <select>s (Month/Day/Year/Hour/Minute)
      // and a "Confirm" primary action. POLL for them to render (render lag
      // grows over a multi-post batch; a fixed sleep raced and left the selects
      // absent → set-schedule failed). Wait up to ~6s for >=5 selects.
      let selectCount = 0;
      let confirmPresent = false;
      for (let i = 0; i < 12; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await helpers.sleep(500);
        // eslint-disable-next-line no-await-in-loop
        selectCount = await page.locator('[role="dialog"] select').count();
        // eslint-disable-next-line no-await-in-loop
        confirmPresent =
          (await page.locator('[data-testid="scheduledConfirmationPrimaryAction"]').count()) > 0;
        if (selectCount >= 5 || (confirmPresent && selectCount >= 3)) {
          break;
        }
      }
      const ok = selectCount >= 3 || confirmPresent;
      this.observations['X-LV-3'] = ok
        ? `confirmed: schedule overlay opened (${selectCount} selects)`
        : 'still-unverified: control clicked but no date/time selects appeared';
      this.core.runLog.append({
        postId,
        action: 'x-open-schedule',
        result: ok ? 'ok' : 'no-overlay',
        detail: `selects=${selectCount} confirm=${confirmPresent}`,
      });
      return ok;
    } catch (error) {
      this.core.runLog.append({ postId, action: 'x-open-schedule', result: 'error', detail: error.message });
      return false;
    }
  }

  /**
   * Set the X date/time, READING the UI to decide the format (AM/PM vs 24h;
   * spinner vs typed) rather than assuming. Best-effort: fills any discovered
   * date/time fields with the target, then verifies the target time text is
   * reflected.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} target - "YYYY-MM-DD HH:mm" Pacific-local target
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<void>}
   */
  async setSchedule(page, target, postId) {
    const parts = helpers.parsePacificTarget(target);
    const time12 = helpers.formatTime12h(parts);
    const monthName = MONTH_FULL[parts.month];
    const hh24 = String(parts.hour).padStart(2, '0');
    const mm = String(parts.minute).padStart(2, '0');

    // The visible X schedule controls are five <select>s in document order:
    // Month, Day, Year, Hour (24-hour, NO AM/PM), Minute. The UI time zone is
    // the browser's — when it matches the operator's timezone, the wall-clock
    // target is set directly, no conversion. Each <select> has an empty option
    // at index 0, so the option
    // index for Month == month number, Day == day, Hour == hour+1, Minute ==
    // minute+1. Label is primary; index is the fallback.
    const selects = page.locator('[role="dialog"] select');
    // Ensure the overlay's selects are actually present before setting (poll up
    // to ~5s) — guards against a still-rendering overlay on later batch posts.
    for (let i = 0; i < 12 && (await selects.count()) < 5; i += 1) {
      await helpers.sleep(400);
    }
    const setByLabelOrIndex = async (idx, label, fallbackIndex) => {
      const sel = selects.nth(idx);
      try {
        await sel.selectOption({ label }, { timeout: this.core.config.stepTimeoutMs });
      } catch (error) {
        this.core.runLog.append({
          postId,
          action: `x-select[${idx}]`,
          result: 'label-miss',
          detail: `${label}: ${error.message.split('\n')[0]}`,
        });
        if (typeof fallbackIndex === 'number') {
          await sel.selectOption({ index: fallbackIndex }).catch(() => {});
        }
      }
    };
    await setByLabelOrIndex(0, monthName, parts.month);       // Month
    await setByLabelOrIndex(1, String(parts.day), parts.day); // Day
    await setByLabelOrIndex(2, String(parts.year));           // Year (no index formula)
    await setByLabelOrIndex(3, hh24, parts.hour + 1);         // Hour (24h)
    await setByLabelOrIndex(4, mm, parts.minute + 1);         // Minute

    // Screenshot the overlay state right before verifying (so any verify failure
    // is diagnosable from the run artifacts).
    await this.core.screenshot('x-schedule-presubmit', postId).catch(() => {});

    // Verify the chosen datetime. PRIMARY: read the five <select>s' selected
    // option text directly and compare to expected — deterministic, immune to
    // the "Will send on …" summary's render timing (which made the prior
    // body-scrape verify flaky on later posts). FALLBACK: the summary text.
    await this.core.verify(async () => {
      const r = await page.evaluate((exp) => {
        const sels = Array.from(document.querySelectorAll('[role="dialog"] select'));
        const val = (i) =>
          ((sels[i] && sels[i].options[sels[i].selectedIndex] && sels[i].options[sels[i].selectedIndex].text) || '').trim();
        const selectsOk =
          sels.length >= 5 &&
          val(0) === exp.month &&
          val(1) === exp.day &&
          val(2) === exp.year &&
          val(3) === exp.hour &&
          val(4) === exp.minute;
        const d = document.querySelector('[role="dialog"]');
        const body = (d && d.innerText) || '';
        const bodyOk =
          body.includes(exp.time12) && body.includes(exp.month) && body.includes(`, ${exp.year}`);
        return selectsOk || bodyOk;
      }, { month: monthName, day: String(parts.day), year: String(parts.year), hour: hh24, minute: mm, time12 });
      return r;
    }, `X schedule = ${monthName} ${parts.day} ${parts.year} ${hh24}:${mm}`);
  }

  /**
   * Best-effort spinner setter — set X's date/time <select> elements by option
   * text. Tolerant of absence; logs nothing on a miss (the verify gate in
   * setSchedule is the real check).
   *
   * @param {object} page - the connected Playwright Page
   * @param {{year:number,month:number,day:number,hour:number,minute:number}} parts
   * @returns {Promise<void>}
   */
  async trySetSelects(page, parts) {
    const month12 = helpers.MONTH_ABBR[parts.month];
    const time = helpers.formatTime12h(parts);
    const [h12, rest] = time.split(':');
    const minute = rest.slice(0, 2);
    const meridiem = rest.slice(3);
    const attempts = [
      { label: /month/i, value: month12 },
      { label: /day/i, value: String(parts.day) },
      { label: /year/i, value: String(parts.year) },
      { label: /hour/i, value: h12 },
      { label: /minute/i, value: minute },
      { label: /am|pm|meridiem/i, value: meridiem },
    ];
    for (const a of attempts) {
      try {
        const sel = page.getByRole('combobox', { name: a.label });
        // eslint-disable-next-line no-await-in-loop
        if ((await sel.count()) > 0) {
          // eslint-disable-next-line no-await-in-loop
          await sel.first().selectOption({ label: a.value }).catch(() => {});
        }
      } catch (error) {
        void error;
      }
    }
  }

  /**
   * PRE-ACTION guard: positively confirm the upcoming terminal action SCHEDULES
   * (not posts now). Looks for a confirm control reading "Schedule" / a
   * scheduled-mode indicator; if it cannot positively confirm, it throws so the
   * bounded retry re-checks and a persistent failure STOPS the post (the
   * terminal action is never taken in post-now mode).
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<void>}
   * @throws {Error} if scheduled-mode cannot be positively confirmed
   */
  async confirmScheduledMode(page, postId) {
    // Apply the schedule selection. The overlay's primary action is "Confirm"
    // (testid scheduledConfirmationPrimaryAction); it does NOT post — it returns
    // to the composer with the compose primary button now reading "Schedule".
    // Dispatched JS click (same rationale as openScheduleControl: avoid 30s
    // actionability timeouts on the overlay's primary action).
    await page
      .evaluate(() => {
        const btn =
          document.querySelector('[data-testid="scheduledConfirmationPrimaryAction"]') ||
          Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) =>
            /^(confirm|update|set)$/i.test((b.innerText || '').trim())
          );
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })
      .catch(() => {});
    // Poll for the compose primary button to flip from "Post" to "Schedule"
    // (the overlay → composer transition can lag on later batch posts).
    let label = '';
    for (let i = 0; i < 12; i += 1) {
      await helpers.sleep(350);
      // eslint-disable-next-line no-await-in-loop
      label = await this.readPrimaryButtonLabel(page);
      if (/schedule/i.test(label)) {
        break;
      }
    }
    const scheduled = /schedule/i.test(label);
    this.observations['X-LV-5'] = scheduled
      ? `confirmed: primary action is scheduled-mode ("${label}")`
      : `still-unverified: primary action reads "${label}"`;
    if (!scheduled) {
      throw new Error(
        `G3 pre-action: cannot positively confirm scheduled-mode (button "${label}"). ` +
          'Refusing to act (would post now).'
      );
    }
    this.core.runLog.append({ postId, action: 'x-g3-pre-action', result: 'ok', detail: label });
  }

  /**
   * Read the X composer's primary action-button label (e.g. "Schedule" vs
   * "Post"). Robust by accessible name with a DOM fallback.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<string>} the label text (trimmed), or ''
   */
  async readPrimaryButtonLabel(page) {
    // The compose primary button is data-testid="tweetButton", inside the dialog
    // (a duplicate "tweetButtonInline" lives in the home-timeline composer).
    try {
      const text = await page.evaluate(() => {
        const d = document.querySelector('[role="dialog"]') || document;
        const btn =
          d.querySelector('[data-testid="tweetButton"]') ||
          d.querySelector('[data-testid="tweetButtonInline"]');
        return btn ? (btn.innerText || '').trim() : '';
      });
      if (text) {
        return text;
      }
    } catch (error) {
      void error;
    }
    const dlg = page.locator('[role="dialog"]');
    const schedule = dlg.getByRole('button', { name: /^schedule$/i });
    if ((await schedule.count()) > 0 && (await schedule.first().isVisible())) {
      return 'Schedule';
    }
    const post = dlg.getByRole('button', { name: /^post$|^post now$/i });
    if ((await post.count()) > 0 && (await post.first().isVisible())) {
      return 'Post';
    }
    return '';
  }

  /**
   * Wait for the schedule action to take effect: a successful schedule CLOSES
   * the compose dialog. Returns true once the composer's primary button is gone
   * (scheduled), or false after ~6s (composer still open → click did not land).
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<boolean>} true iff the composer closed (schedule took)
   */
  async waitForScheduleEffect(page) {
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await helpers.sleep(500);
      // eslint-disable-next-line no-await-in-loop
      const dialogOpen = await page.evaluate(
        () => !!document.querySelector('[role="dialog"] [data-testid="tweetButton"]')
      );
      if (!dialogOpen) {
        return true;
      }
    }
    return false;
  }

  /**
   * Perform the terminal schedule action (LIVE only). The caller guarantees
   * scheduled-mode was positively confirmed first.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async performScheduleAction(page) {
    // Click the compose primary button (now "Schedule"). Try the actionability-
    // checked click first (shorter timeout); fall back to a dispatched JS click
    // if it is briefly obscured/shifting (same toolbar instability as the
    // schedule affordance). The caller's pre-action guard has confirmed the
    // button reads "Schedule", so this dispatches the schedule action, never a
    // post-now.
    const byTestId = page.locator('[role="dialog"] [data-testid="tweetButton"]');
    try {
      if ((await byTestId.count()) > 0) {
        await byTestId.first().click({ timeout: 8000 });
        return;
      }
      await page
        .locator('[role="dialog"]')
        .getByRole('button', { name: /^schedule$/i })
        .first()
        .click({ timeout: 8000 });
      return;
    } catch (error) {
      this.core.runLog.append({
        postId: 'x',
        action: 'x-schedule-click',
        result: 'fallback-jsclick',
        detail: error.message.split('\n')[0],
      });
    }
    await page.evaluate(() => {
      const btn =
        document.querySelector('[role="dialog"] [data-testid="tweetButton"]') ||
        Array.from(document.querySelectorAll('[role="dialog"] button')).find((b) =>
          /^schedule$/i.test((b.innerText || '').trim())
        );
      if (btn) {
        btn.click();
      }
    });
  }

  /**
   * POST-ACTION live-publish detection: after the terminal action, look for a
   * live-publish signal ("Your post was sent" / post on the live timeline).
   * Returns a non-empty signal on a live publish, or '' when scheduled.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<string>} the live-publish signal, or '' if scheduled
   */
  async detectLivePublish(page) {
    try {
      const body = await page.evaluate(() => document.body.innerText || '');
      if (typeof body !== 'string') {
        return '';
      }
      if (/your post was scheduled|scheduled for/i.test(body)) {
        return '';
      }
      if (/your post was sent|your tweet was sent|view\s+on\s+profile/i.test(body)) {
        return 'live-publish signal detected';
      }
      return '';
    } catch (error) {
      void error;
      return '';
    }
  }

  /**
   * Navigate X's scheduled/"unsent posts" queue and test whether a post whose
   * first line matches `firstLine` is present. Implements the `reconcileWithQueue`
   * adapter contract (`queueContains`). The path is unproven; best-effort,
   * returns false on a navigation failure (NOT verified).
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} firstLine - the post's first line of text
   * @returns {Promise<boolean>} true iff present in the scheduled/unsent queue
   */
  async queueContains(page, firstLine) {
    if (!firstLine) {
      return false;
    }
    // The scheduled list lives at /compose/post/unsent/scheduled and shows the
    // full post text ("Will send on … | <body>"). Two robustness fixes proven by
    // diagnostics:
    //   1) Navigation: a same-URL/SPA goto from a stuck state hangs; a direct
    //      goto works when preceded by a clean reset, so on failure we reset to
    //      /home and retry once.
    //   2) Matching: X renders emoji as Twemoji <img> (innerText drops the
    //      char), so we strip emoji from BOTH the needle and the body before
    //      comparing, and match the first line (sans trailing emoji).
    const stripEmoji = (s) =>
      String(s)
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu, '')
        // Fold curly/typographic apostrophes + quotes to straight, so a queue
        // preview that renders "you've" with a curly ’ still matches a source
        // straight ' (needed whenever the first line contains an apostrophe).
        .replace(/[‘’‛′]/g, "'")
        .replace(/[“”″]/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
    const needle = stripEmoji(firstLine);
    if (needle.length < 8) {
      return false;
    }

    const navigate = async () => {
      try {
        await page.goto('https://x.com/compose/post/unsent/scheduled', {
          waitUntil: 'domcontentloaded',
          timeout: 20000,
        });
        return true;
      } catch (error) {
        void error;
        // Reset and retry once.
        await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded' }).catch(() => {});
        await helpers.sleep(1200);
        try {
          await page.goto('https://x.com/compose/post/unsent/scheduled', {
            waitUntil: 'domcontentloaded',
            timeout: 20000,
          });
          return true;
        } catch (error2) {
          void error2;
          return false;
        }
      }
    };

    try {
      if (!(await navigate())) {
        return false;
      }
      await helpers.sleep(2500);
      const raw = await page.evaluate(() => document.body.innerText || '');
      const body = stripEmoji(raw);
      return (
        body.includes(needle) ||
        (needle.length >= 30 && body.includes(needle.slice(0, 30)))
      );
    } catch (error) {
      void error;
      return false;
    }
  }
}

module.exports = { XAdapter, NEEDS_LIVE_VALIDATION, X_EDITOR_SELECTORS };
