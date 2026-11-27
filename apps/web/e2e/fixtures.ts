import { readFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';
import type { Page } from '@playwright/test';
import { STATE_FILE } from './global-setup';
import type { E2eState } from './global-setup';

export const state = (): E2eState => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as E2eState;

export async function loginAsClient(page: Page): Promise<void> {
  const s = state();
  await page.goto('/');
  await page.getByLabel('Identifiant').fill(s.clientLogin);
  await page.getByLabel(/PIN \(6 chiffres\)/).fill(s.clientPin);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('heading', { name: 'Boissons' })).toBeVisible();
}

/** Garantit que la machine est libre après chaque test (elle est exclusive), même en cas d'échec. */
export const test = base.extend({
  page: async ({ page }, use) => {
    await use(page);
    const logout = page.getByRole('button', { name: 'Me déconnecter' });
    if (await logout.isVisible().catch(() => false)) await logout.click();
  },
});
export { expect };
