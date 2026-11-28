import AxeBuilder from '@axe-core/playwright';
import { expect, loginAsClient, state, test } from './fixtures';

/** CONTRASTE inclus (impossible à mesurer sans navigateur : c'est le but de ces parcours). */
const scan = async (page: import('@playwright/test').Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map(
    (v) => `${v.id} : ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`,
  );

test('écran de connexion : aucune violation WCAG AA, contraste compris', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('écran de connexion avec erreur : aucune violation', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Identifiant').fill('inconnu');
  await page.getByLabel(/PIN \(6 chiffres\)/).fill('000999');
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page.getByRole('alert')).toBeVisible();
  expect(await scan(page)).toEqual([]);
});

test('machine du client avec un panier : aucune violation', async ({ page }) => {
  await loginAsClient(page);
  await page.getByRole('button', { name: new RegExp(`Ajouter une ${state().product}`) }).click();
  await expect(page.getByText(/Il manque/)).toBeVisible();
  expect(await scan(page)).toEqual([]);
});
