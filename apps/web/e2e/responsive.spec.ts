import { expect, loginAsClient, test } from './fixtures';

const noHorizontalScroll = (page: import('@playwright/test').Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

test('connexion : pas de défilement horizontal', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  expect(await noHorizontalScroll(page)).toBe(true);
});

test('machine du client : pas de défilement horizontal, cibles tactiles >= 44 px', async ({ page }) => {
  await loginAsClient(page);
  expect(await noHorizontalScroll(page)).toBe(true);
  const buttons = page.getByRole('button');
  const count = await buttons.count();
  for (let i = 0; i < count; i++) {
    const box = await buttons.nth(i).boundingBox();
    if (box !== null) expect(box.height, `bouton n°${i}`).toBeGreaterThanOrEqual(43.5);
  }
});
