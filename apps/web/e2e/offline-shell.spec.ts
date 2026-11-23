import { expect, test } from '@playwright/test';

// M0 definition of done (Section 7): the app is installable and opens offline with a placeholder screen.
// This is the automated half; the real-phone check is in docs/install-pilot-phone.md.

test('manifest is installable: standalone, icons, theme colour', async ({ page, request }) => {
  await page.goto('/');
  const href = await page.locator('link[rel="manifest"]').getAttribute('href');
  expect(href).toBeTruthy();
  const manifest = await (await request.get(href!)).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.start_url).toBe('/');
  expect(manifest.theme_color).toBe('#0f172a');
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toContain('192x192');
  expect(sizes).toContain('512x512');
  expect(manifest.icons.some((i: { purpose?: string }) => i.purpose === 'maskable')).toBe(true);
});

test('driver shell reopens with the network off (airplane mode)', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('placeholder')).toHaveText('Driver app — M0 shell');

  // Wait until the service worker has installed and controls the page.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByTestId('placeholder')).toHaveText('Driver app — M0 shell');
  await expect(page.getByTestId('sync-pill')).toHaveText('Offline · 0 queued');

  // A deep link that was never visited online still opens from the cached shell.
  await page.goto('/office');
  await expect(page.getByTestId('placeholder')).toContainText('Office shell');
  await context.setOffline(false);
});

test('driver shell has no map (Section 3)', async ({ page }) => {
  await page.goto('/');
  const mapRequests: string[] = [];
  page.on('request', (r) => {
    if (/maps\.googleapis|maplibre|tile/i.test(r.url())) mapRequests.push(r.url());
  });
  await page.reload();
  await page.waitForLoadState('networkidle');
  expect(mapRequests).toEqual([]);
});
