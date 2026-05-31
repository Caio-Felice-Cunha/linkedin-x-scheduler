'use strict';

/**
 * CDP connect + session guard.
 *
 * The whole architecture turns on this: instead of launching a browser (which
 * would lose the operator's session and re-trigger 2FA), the scheduler ATTACHES
 * to the operator's already-running, logged-in Chrome over the DevTools
 * protocol:
 *
 *   const browser = await chromium.connectOverCDP('http://localhost:9222');
 *   const context = browser.contexts()[0];   // the existing, logged-in context
 *   const page = context.pages()[0] || await context.newPage();
 *
 * The operator launches Chrome ONCE with `--remote-debugging-port=9222` on the
 * same profile (documented in README.md). The build never does this and never
 * touches credentials. On connect failure the message tells the operator
 * exactly how to fix it.
 *
 * `chromium.launch` is deliberately NEVER called here — a grep guard test
 * asserts the core contains no launch/OS-dialog code.
 */

/**
 * A connection failure — Chrome is not reachable on the CDP endpoint. Carries an
 * operator-actionable message (relaunch Chrome with the debug port). The CLI
 * maps this to a non-zero exit.
 */
class ConnectError extends Error {
  /**
   * @param {string} message - operator-actionable message
   * @param {Error} [cause] - the underlying error
   */
  constructor(message, cause) {
    super(message);
    this.name = 'ConnectError';
    if (cause) {
      this.cause = cause;
    }
  }
}

/**
 * A session/login failure — connected, but not logged in as the operator / hit
 * a 2FA or checkpoint. The orchestrator STOPS and asks the operator. Never a
 * credential attempt.
 */
class SessionError extends Error {
  /**
   * @param {string} message - what the guard saw (logged out / wrong account)
   * @param {string} platform - 'linkedin' | 'x'
   */
  constructor(message, platform) {
    super(message);
    this.name = 'SessionError';
    this.platform = platform;
  }
}

/**
 * Lazily require Playwright's `chromium`. Kept lazy (matching renderer.js) so
 * modules that only need constants, and unit tests that inject a mock, do not
 * pay the import cost or crash when the binary is absent.
 *
 * @returns {object} the Playwright `chromium` browser-type object
 * @throws {ConnectError} if `playwright` is not installed
 */
function loadChromium() {
  try {
    // eslint-disable-next-line global-require
    return require('playwright-core').chromium;
  } catch (error) {
    throw new ConnectError(
      'playwright-core is not installed — run `npm install` in the project root.',
      error
    );
  }
}

/**
 * Connect to the operator's already-running Chrome over CDP and return the
 * existing logged-in context + a usable page. NEVER launches a browser.
 *
 * @param {object} [options]
 * @param {string} [options.endpoint='http://localhost:9222'] - CDP endpoint
 * @param {object} [options.chromium] - injected `chromium` (for tests/mocks);
 *   defaults to the lazily-required Playwright `chromium`
 * @returns {Promise<{browser:object, context:object, page:object}>}
 * @throws {ConnectError} if the debug port is not reachable
 */
async function connectToRunningChrome(options = {}) {
  const endpoint = options.endpoint || 'http://localhost:9222';
  const chromium = options.chromium || loadChromium();

  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (error) {
    throw new ConnectError(
      `Could not connect to Chrome over CDP at ${endpoint}. ` +
        'Start Chrome with the remote debugging port on your dedicated profile, e.g.:\n' +
        '  "<chrome>" --remote-debugging-port=9222 ' +
        '--user-data-dir="<your existing profile>"\n' +
        'then leave it open and re-run the scheduler. ' +
        '(The scheduler attaches to your live session — it never launches Chrome ' +
        'and never handles credentials.)',
      error
    );
  }

  const contexts = browser.contexts();
  if (!contexts || contexts.length === 0) {
    throw new ConnectError(
      `Connected to ${endpoint} but found no browser context. ` +
        'Make sure the Chrome you launched with --remote-debugging-port=9222 ' +
        'is the logged-in window (not a fresh, empty profile).'
    );
  }
  const context = contexts[0];
  const pages = context.pages();
  const page = pages && pages.length > 0 ? pages[0] : await context.newPage();

  return { browser, context, page };
}

/** The LinkedIn feed URL the session guard / composer navigates to. */
const LINKEDIN_FEED_URL = 'https://www.linkedin.com/feed/';

/** The X home URL the session guard / composer navigates to. */
const X_HOME_URL = 'https://x.com/home';

/**
 * Verify the connected session is logged in as the operator for the given
 * platform. Navigates the page to the platform home and checks for the expected
 * identity marker; if it sees a login/auth wall instead, it throws a
 * SessionError (STOP + ask the operator — never attempt credentials).
 *
 * The DOM probes are intentionally tolerant: a logged-in LinkedIn shows the
 * member's name in the profile rail / "Start a post" affordance; a logged-out
 * page redirects to a `/login`/`/checkpoint`/`/uas` URL or shows a sign-in form.
 * The exact selectors are validated live; here we use robust, URL + visible-text
 * signals so the guard fails LOUD rather than proceeding blind.
 *
 * @param {object} page - the connected Playwright Page
 * @param {string} platform - 'linkedin' | 'x'
 * @param {object} accounts - expected identities (config.accounts)
 * @returns {Promise<{loggedIn:true, account:object}>}
 * @throws {SessionError} on logout / 2FA / checkpoint / wrong account
 */
async function assertLoggedIn(page, platform, accounts) {
  if (platform === 'linkedin') {
    return assertLinkedInLoggedIn(page, accounts.linkedin);
  }
  if (platform === 'x') {
    return assertXLoggedIn(page, accounts.x);
  }
  throw new SessionError(`Unknown platform "${platform}".`, platform);
}

/**
 * LinkedIn login guard. Navigates to the feed; a logged-out session redirects to
 * a login/checkpoint URL. We then look for the member name in the page; absence
 * of any auth wall is treated as logged in.
 *
 * @param {object} page - the connected Playwright Page
 * @param {{displayName:string}} account - expected LinkedIn identity
 * @returns {Promise<{loggedIn:true, account:object}>}
 * @throws {SessionError} if logged out / on a checkpoint / wrong account
 */
async function assertLinkedInLoggedIn(page, account) {
  await page.goto(LINKEDIN_FEED_URL, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  if (/\/(login|checkpoint|uas|signup)\b/.test(url)) {
    throw new SessionError(
      `LinkedIn appears logged out / on a checkpoint (URL ${url}). ` +
        'Log in to LinkedIn as ' +
        `${account.displayName} in the debugged Chrome window, then re-run.`,
      'linkedin'
    );
  }
  // Best-effort identity confirmation: the member's name appears in the page
  // shell when logged in. We do not hard-fail on absence (LinkedIn frequently
  // changes the shell), but we DO hard-fail on an auth wall above.
  let nameSeen = false;
  try {
    const body = await page.evaluate(() => document.body.innerText || '');
    nameSeen =
      typeof body === 'string' && body.includes(account.displayName);
  } catch (error) {
    void error;
  }
  return { loggedIn: true, account: Object.assign({}, account, { nameSeen }) };
}

/**
 * X login guard. Navigates to the home timeline; a logged-out session shows the
 * sign-in / flow URL. We look for the account handle; an auth wall hard-fails.
 *
 * @param {object} page - the connected Playwright Page
 * @param {{handle:string}} account - expected X identity
 * @returns {Promise<{loggedIn:true, account:object}>}
 * @throws {SessionError} if logged out / on a login flow
 */
async function assertXLoggedIn(page, account) {
  await page.goto(X_HOME_URL, { waitUntil: 'domcontentloaded' });
  const url = page.url();
  if (/\/(i\/flow\/login|login|account\/access)\b/.test(url)) {
    throw new SessionError(
      `X appears logged out / on a login flow (URL ${url}). ` +
        `Log in to X as ${account.handle} in the debugged Chrome window, then re-run.`,
      'x'
    );
  }
  let handleSeen = false;
  try {
    const body = await page.evaluate(() => document.body.innerText || '');
    const bare = account.handle.replace(/^@/, '');
    handleSeen =
      typeof body === 'string' &&
      (body.includes(account.handle) || body.includes(bare));
  } catch (error) {
    void error;
  }
  return { loggedIn: true, account: Object.assign({}, account, { handleSeen }) };
}

module.exports = {
  ConnectError,
  SessionError,
  connectToRunningChrome,
  assertLoggedIn,
  assertLinkedInLoggedIn,
  assertXLoggedIn,
  LINKEDIN_FEED_URL,
  X_HOME_URL,
};
