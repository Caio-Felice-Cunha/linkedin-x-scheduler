'use strict';

/**
 * LinkedIn platform adapter (the proven flow).
 *
 * Schedules a LinkedIn document (PDF carousel) or single-image post on the
 * operator's live, connected session by:
 *   1. composing the verbatim text into the Quill `.ql-editor` via a clipboard
 *      PASTE (with synthetic-event fallbacks — `execCommand('insertText')` and
 *      `page.type` do NOT reach LinkedIn's current editor),
 *   2. attaching the asset DIRECTLY via `page.setInputFiles(<input type=file>, …)`
 *      — NO native OS dialog (this is the whole point: no host file picker),
 *   3. setting the schedule through the clock dialog at the target time
 *      (M/D/YYYY + h:mm AM/PM),
 *   4. enforcing the live-publish guard: the primary button MUST read
 *      "Schedule" before the terminal click; after, the post MUST be in the
 *      Scheduled queue and MUST NOT be in the live feed — any live publish
 *      ABORTS the batch and alerts the operator,
 *   5. verifying the post landed in the in-composer Scheduled queue before
 *      marking it `verified`.
 *
 * Dry-run vs live: in dry-run every step through the pre-click label read runs,
 * but the terminal Schedule click is stubbed (zero live side effects).
 *
 * No native OS file dialog / no global-keystroke automation / read-only on
 * assets — files attach only via `page.setInputFiles`.
 */

const helpers = require('../helpers');

/**
 * A live-publish signal — a post published live instead of being scheduled.
 * The orchestrator catches this and STOPS the whole batch. The single
 * non-negotiable safety failure.
 */
class LivePublishError extends Error {
  /**
   * @param {string} postId - the offending post
   * @param {string} detail - what was observed (feed / "Post successful" toast)
   */
  constructor(postId, detail) {
    super(
      `CRITICAL: ${postId} appears to have PUBLISHED LIVE, not scheduled ` +
        `(${detail}). Batch STOPPED. Check the feed and delete the live post if needed.`
    );
    this.name = 'LivePublishError';
    this.postId = postId;
    this.detail = detail;
    this.critical = true;
  }
}

/** Editor selector fallback chain. */
const EDITOR_SELECTORS = Object.freeze([
  '.ql-editor',
  '[role="textbox"][contenteditable]',
  '[contenteditable="true"]',
]);

/**
 * The LinkedIn adapter. Stateless across posts except for the injected core; one
 * instance per run, reused for every LinkedIn post.
 */
class LinkedInAdapter {
  /**
   * @param {import('../core').SchedulerCore} core - the shared run context
   */
  constructor(core) {
    /** @type {import('../core').SchedulerCore} */
    this.core = core;
    /** @type {string} */
    this.platform = 'linkedin';
  }

  /**
   * Schedule one LinkedIn post end to end, driving the state machine
   * (`composing → texted → attached → timed → scheduled → verified`). Returns the
   * final status. Throws LivePublishError on a violation (orchestrator aborts).
   *
   * @param {object} packet - resolved packet (from packets.buildPacket)
   * @returns {Promise<{postId:string, status:string, scheduledLocalTime:string}>}
   * @throws {LivePublishError} on a live-publish detection
   */
  async schedulePost(packet) {
    const { core } = this;
    const { postId } = packet;
    const page = core.page;
    const log = core.runLog;
    const isDoc = packet.template === 'LI-CAROUSEL';

    log.append({ postId, action: 'linkedin-schedule-start', detail: packet.template });

    // --- Idempotent dedupe: already in the Scheduled queue? ----------------
    const already = await this.queueContains(page, packet.firstLine);
    if (already) {
      log.append({ postId, action: 'dedupe', result: 'skip', detail: 'already in Scheduled queue' });
      core.state.transition(postId, 'verified', {
        verifiedAt: new Date().toISOString(),
        reconciled: true,
      });
      return { postId, status: 'verified', scheduledLocalTime: helpers.pacificLabel(packet.target) };
    }

    // A prior rehearsal/partial may have left this post non-pending (e.g.
    // 'scheduled' from a dry-run). The dedupe above confirmed it is NOT in the
    // live queue, so reset to 'pending' for a clean (re)attempt — every state
    // allows → pending, and this cannot double-post.
    const priorRecord = core.state.getPost(postId);
    if (priorRecord && priorRecord.status !== 'pending') {
      core.state.transition(postId, 'pending', {});
    }

    // --- composing: open composer + insert text -----------------------------
    core.state.transition(postId, 'composing', {});
    await core.withRetry(() => this.openComposer(page), 'open-composer', postId);
    await core.screenshot('composer-open', postId);
    await core.withRetry(() => this.insertText(page, packet.postText), 'insert-text', postId);
    core.state.transition(postId, 'texted', {});
    await core.screenshot('text-inserted', postId);

    // --- attached: media via setInputFiles ----------------------------------
    if (isDoc) {
      await core.withRetry(
        () => this.attachDocument(page, packet.assets[0], packet.docTitle, postId),
        'attach-document',
        postId
      );
    } else {
      await core.withRetry(
        () => this.attachImage(page, packet.assets[0]),
        'attach-image',
        postId
      );
    }
    core.state.transition(postId, 'attached', {});
    await core.screenshot('media-attached', postId);

    // --- timed: schedule dialog ---------------------------------------------
    const scheduledLocalTime = helpers.pacificLabel(packet.target);
    await core.withRetry(
      () => this.setSchedule(page, packet.target),
      'set-schedule',
      postId
    );
    core.state.transition(postId, 'timed', { scheduledLocalTime });
    await core.screenshot('schedule-set', postId);

    // --- pre-click guard: button must read "Schedule" -----------------------
    await core.withRetry(() => this.confirmScheduleLabel(page), 'g3-pre-click-label', postId);
    await core.screenshot('g3-label-confirmed', postId);

    // --- terminal action honours dry-run/live -------------------------------
    if (core.isDryRun) {
      log.append({ postId, action: 'terminal-schedule', result: 'DRY-RUN', detail: 'would click Schedule' });
      core.state.transition(postId, 'scheduled', { dryRun: true });
      // In dry-run we cannot verify-in-queue (nothing was scheduled). Report
      // the rehearsal outcome without claiming `verified`.
      return { postId, status: 'dry-run-ok', scheduledLocalTime };
    }

    await this.clickSchedule(page);
    core.state.transition(postId, 'scheduled', {});
    await core.screenshot('after-schedule-click', postId);

    // --- post-click live-publish detection ----------------------------------
    const liveSignal = await this.detectLivePublish(page);
    if (liveSignal) {
      core.state.markFailed(postId, `G3 live publish: ${liveSignal}`);
      throw new LivePublishError(postId, liveSignal);
    }

    // --- verify-in-queue → verified -----------------------------------------
    // SAFETY: the Schedule click already happened. We do NOT re-click Schedule
    // if the queue check is inconclusive — re-clicking would risk a DUPLICATE
    // scheduled post. "Could not confirm" is reported for a human check, never
    // treated as "do it again".
    // Give LinkedIn a beat to register the new scheduled post in its queue view
    // before reading it (the view lags right after the Schedule click).
    await helpers.sleep(3500);
    const inQueue = await this.queueContains(page, packet.firstLine);
    if (inQueue) {
      core.state.transition(postId, 'verified', { verifiedAt: new Date().toISOString() });
      log.append({ postId, action: 'verify-in-queue', result: 'ok' });
      return { postId, status: 'verified', scheduledLocalTime };
    }
    log.append({
      postId,
      action: 'verify-in-queue',
      result: 'inconclusive',
      detail:
        'Schedule click completed with no live-publish signal, but the post was ' +
        'not located in the queue view. NOT re-scheduled (duplicate-safe). Verify manually.',
    });
    return { postId, status: 'scheduled-unverified', scheduledLocalTime };
  }

  /**
   * Open the LinkedIn composer ("Start a post") and verify the modal opened.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async openComposer(page) {
    // Clear any leftover modal/draft state from a prior step (the per-post
    // dedupe queue-check opens the composer + schedule dialog). A full
    // browser-level goto then resets the SPA cleanly.
    await this.dismissModals(page);
    await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
    // If a composer is somehow already open, we're done.
    if ((await page.locator(EDITOR_SELECTORS[0]).count()) > 0) {
      return;
    }
    // "Start a post" affordance — found by accessible name, not pixels.
    // The share-box module can be slow to hydrate (or absent when a feed video
    // takes over the view), so poll for the button briefly before clicking.
    const starter = page.getByRole('button', { name: /start a post/i });
    let starterCount = 0;
    for (let i = 0; i < 10; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      starterCount = await starter.count();
      if (starterCount > 0) {
        break;
      }
      // eslint-disable-next-line no-await-in-loop
      await helpers.sleep(500);
    }
    let editorMounted = false;
    if (starterCount > 0) {
      await starter.first().click({ timeout: this.core.config.stepTimeoutMs }).catch(() => {});
      // The button can be present but shadowed by a feed video overlay, so the
      // click does not reach the composer. Briefly poll for the editor; if it
      // does not mount, fall through to the deep-link route below.
      for (let i = 0; i < 8; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        if ((await page.locator(EDITOR_SELECTORS[0]).count()) > 0) {
          editorMounted = true;
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await helpers.sleep(500);
      }
    }
    if (!editorMounted) {
      // FALLBACK: the "Start a post" button was absent or its click did not open
      // the composer (share box not mounted / displaced by a feed video).
      // LinkedIn opens the composer overlay directly via the feed's shareActive
      // deep link — a real navigation that mounts the same Quill editor without
      // depending on the share-box button.
      this.core.runLog.append({
        postId: 'linkedin',
        action: 'open-composer',
        result: 'fallback',
        detail: `start-a-post ${starterCount > 0 ? 'click did not mount editor' : 'button absent'} — using ?shareActive=true overlay route`,
      });
      await page.goto('https://www.linkedin.com/feed/?shareActive=true', {
        waitUntil: 'domcontentloaded',
      });
    }
    // Poll-based verify waits for the editor to actually render after the click.
    await this.core.verify(
      async () => (await page.locator(EDITOR_SELECTORS[0]).count()) > 0,
      'composer modal opened (.ql-editor present)'
    );
  }

  /**
   * Best-effort dismissal of a leftover composer / "Discard draft" prompt / open
   * dialog so the next openComposer starts clean. Never throws.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async dismissModals(page) {
    try {
      const discard = page.getByRole('button', { name: /^discard$/i });
      if ((await discard.count()) > 0 && (await discard.first().isVisible())) {
        await discard.first().click({ timeout: 4000 }).catch(() => {});
        return;
      }
    } catch (error) {
      void error;
    }
    try {
      await page.keyboard.press('Escape');
    } catch (error) {
      void error;
    }
  }

  /**
   * Insert verbatim text into the Quill editor via an ORDERED insertion
   * FALLBACK CHAIN. LinkedIn changed its Quill composer and
   * `document.execCommand('insertText')` now NO-OPS (inserts 0 chars), so we
   * lead with the clipboard PASTE method (a one-shot insertion) and fall back
   * through synthetic `InputEvent('insertText')` → a synthetic DataTransfer
   * paste → slow `pressSequentially`, verifying the rendered text after EACH
   * method and keeping the first that lands. Clears a stale draft first;
   * resolves the editor through the EDITOR_SELECTORS chain. Keeps the trimmed
   * length-verify guard (only throws if ALL methods fail).
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} text - the verbatim post text
   * @returns {Promise<void>}
   * @throws {Error} if no editor selector resolves or no method lands the text
   */
  async insertText(page, text) {
    // Resolve the editor with the fallback chain.
    let selector = null;
    for (const sel of EDITOR_SELECTORS) {
      // eslint-disable-next-line no-await-in-loop
      if ((await page.locator(sel).count()) > 0) {
        selector = sel;
        break;
      }
    }
    if (!selector) {
      throw new Error('LinkedIn editor not found (.ql-editor / contenteditable).');
    }

    const editor = () => page.locator(selector).first();

    /** Read the editor's current text content (best-effort). */
    const readText = async () => {
      try {
        return (await editor().innerText()) || '';
      } catch (error) {
        void error;
        return '';
      }
    };

    // Bring the tab to the front so navigator.clipboard.writeText (which needs a
    // focused document) succeeds for the clipboard-paste method.
    await page.bringToFront().catch(() => {});

    // Focus + clear a stale draft (Ctrl+A, Delete) before the focus/paste. Done
    // once up front; each method re-focuses the editor itself.
    await editor().focus().catch(() => {});
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');

    // Grant clipboard permissions for the LinkedIn origin so the paste method's
    // navigator.clipboard.writeText is allowed (origin-scoped).
    await page
      .context()
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.linkedin.com' })
      .catch(() => {});

    // Insertion attempts, best-first. clipboard PASTE inserts in one shot, so
    // LinkedIn's hashtag/mention autocomplete never fires. Fallbacks cover
    // editors where paste is blocked: synthetic InputEvent('insertText') →
    // synthetic DataTransfer paste → slow pressSequentially. (execCommand was
    // removed: it no-ops on LinkedIn's current Quill — the exact bug this fixes.)
    const methods = [
      {
        id: 'clipboard-paste',
        run: async () => {
          const wrote = await page.evaluate(async (t) => {
            try {
              // eslint-disable-next-line no-undef
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
        id: 'input-event',
        run: async () => {
          await editor().click();
          await page.evaluate(
            ({ sel, value }) => {
              // eslint-disable-next-line no-undef
              const el = document.querySelector(sel);
              if (!el) {
                return false;
              }
              el.focus();
              // eslint-disable-next-line no-undef
              el.dispatchEvent(
                // eslint-disable-next-line no-undef
                new InputEvent('beforeinput', {
                  inputType: 'insertText',
                  data: value,
                  bubbles: true,
                  cancelable: true,
                })
              );
              // eslint-disable-next-line no-undef
              el.dispatchEvent(
                // eslint-disable-next-line no-undef
                new InputEvent('input', {
                  inputType: 'insertText',
                  data: value,
                  bubbles: true,
                  cancelable: true,
                })
              );
              return true;
            },
            { sel: selector, value: text }
          );
          await helpers.sleep(400);
        },
      },
      {
        id: 'datatransfer-paste',
        run: async () => {
          await editor().click();
          await page.evaluate(
            ({ sel, value }) => {
              // eslint-disable-next-line no-undef
              const el = document.querySelector(sel);
              if (!el) {
                return false;
              }
              el.focus();
              // eslint-disable-next-line no-undef
              const dt = new DataTransfer();
              dt.setData('text/plain', value);
              // eslint-disable-next-line no-undef
              el.dispatchEvent(
                // eslint-disable-next-line no-undef
                new ClipboardEvent('paste', {
                  clipboardData: dt,
                  bubbles: true,
                  cancelable: true,
                })
              );
              return true;
            },
            { sel: selector, value: text }
          );
          await helpers.sleep(400);
        },
      },
      {
        id: 'slow-type',
        run: async () => {
          await editor().click();
          await editor().pressSequentially(text, { delay: 8 });
          await helpers.sleep(500);
        },
      },
    ];

    const expectedLen = text.trim().length;
    const firstLine = helpers.firstLine(text);
    /** Does the rendered text satisfy the length-verify guard
     *  (trimmed length within 5% tolerance AND includes the verbatim first line)? */
    const matches = (rendered) => {
      const actualLen = (rendered || '').trim().length;
      return (
        Math.abs(actualLen - expectedLen) <= Math.ceil(expectedLen * 0.05) &&
        (rendered || '').includes(firstLine)
      );
    };

    let succeeded = null;
    let lastActualLen = 0;
    for (const method of methods) {
      // Re-clear before each attempt so a partial prior method does not stack.
      // eslint-disable-next-line no-await-in-loop
      await editor().click().catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Control+A');
      // eslint-disable-next-line no-await-in-loop
      await page.keyboard.press('Delete');
      try {
        // eslint-disable-next-line no-await-in-loop
        await method.run();
      } catch (error) {
        this.core.runLog.append({
          postId: 'linkedin',
          action: `li-insert(${method.id})`,
          result: 'error',
          detail: error.message,
        });
        continue;
      }
      // NOTE: do NOT press Escape here — on LinkedIn, Escape closes the composer
      // modal (the editor would vanish and the retry would find nothing). The
      // text is bulk-inserted (no per-keystroke autocomplete to dismiss); any
      // dropdown closes when the next step clicks the media affordance.
      // eslint-disable-next-line no-await-in-loop
      const rendered = await readText();
      lastActualLen = (rendered || '').trim().length;
      if (matches(rendered)) {
        succeeded = method.id;
        break;
      }
      this.core.runLog.append({
        postId: 'linkedin',
        action: `li-insert(${method.id})`,
        result: 'mismatch',
        detail: `rendered length ${lastActualLen}`,
      });
    }

    // KEEP the length-verify guard: only throw if ALL methods failed.
    if (!succeeded) {
      throw new Error(
        `Composed text length mismatch (expected ~${expectedLen}, got ${lastActualLen}).`
      );
    }
    this.core.runLog.append({
      postId: 'linkedin',
      action: 'li-insert',
      result: 'ok',
      detail: `method=${succeeded}`,
    });
  }

  /**
   * Wait for the composer media toolbar to render (the "Add media" button is the
   * anchor). The toolbar mounts a beat after the editor, so an immediate
   * interaction otherwise resolves stale feed elements. Best-effort, never throws.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async ensureComposerToolbar(page) {
    await page
      .getByRole('button', { name: /^add media$/i })
      .first()
      .waitFor({ state: 'visible', timeout: this.core.config.stepTimeoutMs })
      .catch(() => {});
  }

  /**
   * Attach a PDF document via setInputFiles, then title it and click Done.
   * NO native dialog.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} pdfPath - absolute path to the PDF
   * @param {(string|null)} docTitle - the document title from the packet
   * @param {string} postId - the post id (for logging)
   * @returns {Promise<void>}
   */
  async attachDocument(page, pdfPath, docTitle, postId) {
    await this.ensureComposerToolbar(page);

    // The current LinkedIn composer opens a NATIVE OS file picker when "Add a
    // document" is clicked. A PERSISTENT filechooser handler keeps Playwright's
    // CDP file-chooser interception ON continuously, so the picker is intercepted
    // and the PDF supplied no matter how or when the click triggers it — no
    // native dialog can appear. (A one-shot waitForEvent leaves a gap and the OS
    // dialog leaks through.) The menu clicks are dispatched in-page so the
    // interop-outlet overlay cannot intercept them; with the handler registered,
    // the picker those clicks open is still intercepted.
    let chooserHandled = false;
    const onChooser = async (fc) => {
      try {
        await fc.setFiles(pdfPath);
        chooserHandled = true;
      } catch (error) {
        void error;
      }
    };
    page.on('filechooser', onChooser);
    try {
      // In-page click dispatch by accessible name (bypasses interop-outlet).
      const dispatchClick = (re) =>
        page.evaluate(
          (src) => {
            const rx = new RegExp(src.source, src.flags);
            const el = [
              ...document.querySelectorAll('button,[role=button],[role=menuitem]'),
            ].find((x) =>
              rx.test((x.getAttribute('aria-label') || x.textContent || '').trim()));
            if (el) {
              el.click();
              return true;
            }
            return false;
          },
          { source: re.source, flags: re.flags }
        );

      let clickedDoc = await dispatchClick(/^add a document$/i);
      if (!clickedDoc) {
        // "Add a document" is behind the "More" overflow — open it, then retry.
        await dispatchClick(/^more$|add to your post|show more/i);
        await page.waitForTimeout(1000);
        clickedDoc = await dispatchClick(/^add a document$/i);
      }
      // Give the persistent handler time to supply the file once the picker
      // fires, OR an in-page modal time to mount its input.
      await page.waitForTimeout(2500);
      if (!chooserHandled) {
        // Fallback: an in-page upload modal that exposes a hidden file input.
        await page
          .locator('input[type="file"]')
          .last()
          .setInputFiles(pdfPath, { timeout: this.core.config.stepTimeoutMs })
          .catch(() => {});
      }
    } finally {
      page.off('filechooser', onChooser);
    }

    // Title is REQUIRED to finish ("Please add a title to finish your post").
    // The field has NO accessible name — target it by placeholder (the
    // role-based name match misses it), with a role-based fallback.
    const titleText = docTitle || 'Document';
    try {
      await page.getByPlaceholder(/title/i).first().fill(titleText, { timeout: 8000 });
    } catch (error) {
      void error;
      try {
        await page
          .getByRole('textbox', { name: /title/i })
          .first()
          .fill(titleText, { timeout: 5000 });
      } catch (error2) {
        void error2;
        this.core.runLog.append({
          postId,
          action: 'doc-title',
          result: 'warn',
          detail: 'title field not found (placeholder + role)',
        });
      }
    }

    // Wait for the PDF→carousel processing (page-count visible) + Done enabled.
    await this.core.verify(
      async () => {
        const done = page.getByRole('button', { name: /^done$/i });
        return (await done.count()) > 0 && (await done.first().isEnabled());
      },
      'document processed (Done enabled)'
    );

    await page.getByRole('button', { name: /^done$/i }).first().click();

    // Verify the Share-a-document dialog actually CLOSED (its title field is
    // gone) AND the composer is regained — i.e. the document is truly attached,
    // not stuck behind an unfinished dialog (which a text-only schedule would be).
    await this.core.verify(
      async () =>
        (await page.getByPlaceholder(/title/i).count()) === 0 &&
        (await page.locator(EDITOR_SELECTORS[0]).count()) > 0,
      'document attached (share dialog closed, composer regained)'
    );
  }

  /**
   * Attach a single image via setInputFiles, handle an optional media editor,
   * and verify the preview renders. NO native dialog.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} pngPath - absolute path to the PNG
   * @returns {Promise<void>}
   */
  async attachImage(page, pngPath) {
    // Clicking the photo affordance opens the OS file chooser. Intercept it with
    // Playwright's filechooser event so NO native dialog ever appears and the
    // file is provided through the event. (A click followed by a separate
    // setInputFiles leaves the native "Open" dialog ORPHANED and modal-locks the
    // whole machine — the bug we hit. The document flow uses an in-page dialog so
    // it is unaffected.)
    await this.ensureComposerToolbar(page);
    const [chooser] = await Promise.all([
      page.waitForEvent('filechooser', { timeout: this.core.config.stepTimeoutMs }),
      page
        .getByRole('button', { name: /^add media$/i })
        .first()
        .click({ timeout: this.core.config.stepTimeoutMs }),
    ]);
    await chooser.setFiles(pngPath);

    // An optional media editor/crop view may appear. `setFiles` resolves as soon
    // as the file input is populated, NOT when the upload has finished
    // rendering, so on a slow upload the editor may not exist yet when we look
    // for it. Checking once and moving on leaves the run stranded INSIDE the
    // editor, one modal short of the composer. Wait for the first Next/Done
    // instead of assuming it is already on screen.
    const editorButton = () => page.getByRole('button', { name: /^(next|done)$/i });
    try {
      await editorButton()
        .first()
        .waitFor({ state: 'visible', timeout: this.core.config.uploadTimeoutMs });
    } catch (error) {
      void error; // No media editor at all — the image attached directly.
    }
    for (let i = 0; i < 4; i += 1) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if ((await editorButton().count()) === 0 || !(await editorButton().first().isVisible())) {
          break;
        }
        // eslint-disable-next-line no-await-in-loop
        await editorButton().first().click({ timeout: 5000 });
        // A further editor screen (a review grid, then Done) can take a moment
        // to render; the absence of one simply ends the loop.
        // eslint-disable-next-line no-await-in-loop
        await editorButton()
          .first()
          .waitFor({ state: 'visible', timeout: 4000 })
          .catch(() => {});
      } catch (error) {
        void error; // No (more) media editor — back in the composer.
        break;
      }
    }

    // Verify a thumbnail/preview is present AND the media editor is gone. The
    // preview check alone is not enough: the editor renders blob previews of its
    // own, so it passes while the run is still inside the editor. The
    // editor-dismissed check is what proves we are back in the composer, which
    // is where the schedule control lives.
    await this.core.verify(
      async () =>
        (await page.locator('img[src^="blob:"], img[src^="data:"], .share-images, [data-test-id*="image"]').count()) > 0 &&
        (await editorButton().count()) === 0,
      'image preview rendered and media editor dismissed'
    );
  }

  /**
   * Expand the composer media affordance and click the option matching `nameRe`.
   * Expands the "+"/More overflow first if the option is hidden.
   *
   * @param {object} page - the connected Playwright Page
   * @param {RegExp} nameRe - accessible-name matcher for the media option
   * @returns {Promise<void>}
   */
  async openMediaAffordance(page, nameRe) {
    const option = page.getByRole('button', { name: nameRe });
    if ((await option.count()) === 0) {
      // Expand the More / "+" overflow, then re-find the option.
      const more = page.getByRole('button', { name: /more|add to your post|show more/i });
      if ((await more.count()) > 0) {
        await more.first().click({ timeout: this.core.config.stepTimeoutMs });
      }
    }
    await page
      .getByRole('button', { name: nameRe })
      .first()
      .click({ timeout: this.core.config.stepTimeoutMs });
  }

  /**
   * Open the schedule (clock) dialog and set Date (M/D/YYYY) + Time (h:mm AM/PM)
   * to the target slot, then verify the dialog header reflects the intended
   * day/time + time zone.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} target - "YYYY-MM-DD HH:mm" Pacific-local target
   * @returns {Promise<void>}
   */
  async setSchedule(page, target) {
    const parts = helpers.parsePacificTarget(target);
    const dateStr = helpers.formatDateMDY(parts); // 6/9/2026
    const timeStr = helpers.formatTime12h(parts); // 9:00 AM

    // Open the Schedule dialog via the PRECISE "Schedule post" clock button
    // (aria-label="Schedule post"). The broad /schedule/i matched the inline
    // calendar's day buttons too. The click opens a dialog whose calendar can
    // overlap the button, so Playwright's post-click stability re-check may time
    // out even though the dialog DID open — tolerate that and confirm via the
    // Date field id.
    try {
      await page.getByRole('button', { name: /^schedule post$/i }).first().click({
        timeout: 8000,
      });
    } catch (error) {
      void error;
    }
    await this.core.verify(
      async () => (await page.locator('#share-post__scheduled-date').count()) > 0,
      'schedule dialog open (Date field present)'
    );

    // Date + Time by stable id (aria-label "Date"/"Time"). fill() clears + sets.
    await page.locator('#share-post__scheduled-date').fill(dateStr);
    await page.locator('#share-post__scheduled-time').fill(timeStr);
    await page.keyboard.press('Tab');

    // Verify the schedule fields hold the intended date + time. (LinkedIn no
    // longer prints the literal "Pacific" label in the dialog; the timezone is
    // the account default. Reading the field values is more robust than scraping
    // page text.)
    await this.core.verify(async () => {
      const norm = (s) =>
        (s || '').toString().toLowerCase().replace(/\s+/g, '').replace(/\b0(\d)/g, '$1');
      const timeVal = await page
        .locator('#share-post__scheduled-time')
        .inputValue()
        .catch(() => '');
      const dateVal = await page
        .locator('#share-post__scheduled-date')
        .inputValue()
        .catch(() => '');
      return norm(timeVal) === norm(timeStr) && norm(dateVal) === norm(dateStr);
    }, `schedule fields show ${dateStr} ${timeStr}`);
  }

  /**
   * PRE-CLICK guard: click "Next", then read the primary button's label and
   * assert it equals "Schedule" (not "Post"/"Post now"). Returns normally only
   * when the label is "Schedule"; throws otherwise so the caller's bounded retry
   * re-opens the dialog, and a persistent failure STOPS the post (the terminal
   * click is NEVER reached with a "Post" button).
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   * @throws {Error} if the primary button does not read "Schedule"
   */
  async confirmScheduleLabel(page) {
    // "Next" in the schedule dialog promotes the primary button to "Schedule".
    const next = page.getByRole('button', { name: /^next$/i });
    if ((await next.count()) > 0) {
      await next.first().click({ timeout: this.core.config.stepTimeoutMs });
    }
    const label = await this.readPrimaryButtonLabel(page);
    if (!/^schedule$/i.test((label || '').trim())) {
      throw new Error(
        `G3 pre-click: primary button reads "${label}", not "Schedule". ` +
          'Refusing to click (would publish live).'
      );
    }
  }

  /**
   * Read the composer's primary action-button label (top-right). Used by the
   * pre-click guard. Robust: prefers an explicit "Schedule"/"Post" button by
   * accessible name; falls back to scanning the composer footer.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<string>} the button label text (trimmed), or ''
   */
  async readPrimaryButtonLabel(page) {
    const schedule = page.getByRole('button', { name: /^schedule$/i });
    if ((await schedule.count()) > 0 && (await schedule.first().isVisible())) {
      return 'Schedule';
    }
    const post = page.getByRole('button', { name: /^post$/i });
    if ((await post.count()) > 0 && (await post.first().isVisible())) {
      return 'Post';
    }
    // Fallback: read any visible primary-styled button text.
    try {
      const text = await page.evaluate(() => {
        const btn =
          document.querySelector('.share-actions__primary-action') ||
          document.querySelector('[data-control-name="share.post"]');
        return btn ? (btn.innerText || '').trim() : '';
      });
      return text || '';
    } catch (error) {
      void error;
      return '';
    }
  }

  /**
   * Click the terminal "Schedule" button (LIVE only). The caller guarantees the
   * pre-click label was confirmed "Schedule" first.
   *
   * @param {object} page - the connected Playwright Page
   * @returns {Promise<void>}
   */
  async clickSchedule(page) {
    await page.getByRole('button', { name: /^schedule$/i }).first().click({
      timeout: this.core.config.stepTimeoutMs,
    });
  }

  /**
   * POST-CLICK live-publish detection: after the terminal action, look for a
   * live-publish signal — a "Post successful" toast / the post in the live feed
   * / on profile activity. Returns a non-empty signal string on a live publish,
   * or '' when the post correctly scheduled (a "Post scheduled" toast).
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
      // The GOOD signal — "Post scheduled" — means NOT a live publish.
      if (/post scheduled/i.test(body)) {
        return '';
      }
      // The BAD signals — a live publish.
      if (/post successful|your post is live|view post\b/i.test(body)) {
        return 'live-publish toast detected';
      }
      return '';
    } catch (error) {
      void error;
      // Ambiguous = NOT done, but for the live-publish check specifically, an
      // unreadable page is NOT treated as a live publish (that would false-abort).
      // The verify-in-queue step is the positive confirmation.
      return '';
    }
  }

  /**
   * Open the in-composer Scheduled queue and test whether a post whose first
   * line equals `firstLine` is present. Implements the `reconcileWithQueue`
   * adapter contract (`queueContains`). Best-effort navigation; on a navigation
   * failure it returns false (absent), so the caller treats "could not confirm"
   * as NOT verified.
   *
   * @param {object} page - the connected Playwright Page
   * @param {string} firstLine - the post's first line of text
   * @returns {Promise<boolean>} true iff present in the Scheduled queue
   */
  async queueContains(page, firstLine) {
    if (!firstLine) {
      return false;
    }
    try {
      // Start from a clean feed (the just-scheduled composer state is unreliable
      // to navigate from). Then Start a post → "Schedule post" clock → "View all
      // scheduled posts" → read the list (mirrors the validated manual flow).
      await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
      await helpers.sleep(1500);
      const starter = page.getByRole('button', { name: /start a post/i });
      if ((await starter.count()) === 0) {
        return false;
      }
      await starter.first().click({ timeout: this.core.config.stepTimeoutMs });
      await page.waitForSelector('.ql-editor', { timeout: 12000 }).catch(() => {});
      const clock = page.getByRole('button', { name: /^schedule post$/i });
      if ((await clock.count()) === 0) {
        return false;
      }
      await clock.first().click({ timeout: this.core.config.stepTimeoutMs }).catch(() => {});
      await helpers.sleep(1200);
      const viewAll = page.getByRole('button', { name: /view all scheduled posts/i });
      if ((await viewAll.count()) > 0) {
        await viewAll.first().click({ timeout: this.core.config.stepTimeoutMs }).catch(() => {});
        await helpers.sleep(2000);
      }
      const body = await page.evaluate(() => document.body.innerText || '');
      return typeof body === 'string' && body.includes(firstLine);
    } catch (error) {
      void error;
      return false;
    }
  }
}

module.exports = { LinkedInAdapter, LivePublishError, EDITOR_SELECTORS };
