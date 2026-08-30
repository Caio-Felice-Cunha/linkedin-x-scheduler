'use strict';

const { expect, test } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  const failures = [];
  page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()); });
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname)) failures.push(`external request: ${request.url()}`);
  });
  page._caseFailures = failures;
});

test.afterEach(async ({ page }) => expect(page._caseFailures).toEqual([]));

test('renders the report and complete engineering walkthrough', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Inspect a scheduled week/i })).toBeVisible();
  await expect(page.locator('#items article')).toHaveCount(4);
  await expect(page.getByText('Duplicate guard', { exact: true })).toBeVisible();
  await expect(page.getByText(/IDEMPOTENT RESUME/i, { exact: true })).toBeVisible();
  await expect(page.getByText('Demo mode', { exact: true })).toBeVisible();
});

test('supports keyboard navigation, reduced motion, and mobile layout', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.keyboard.press('Tab');
  await expect(page.locator('.skip-link')).toBeFocused();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
