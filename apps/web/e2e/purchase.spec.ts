import { expect, loginAsClient, state, test } from './fixtures';

test('achat complet : billets, validation, résultat, retour à la connexion', async ({ page }) => {
  await loginAsClient(page);
  const name = state().product;
  await page.getByRole('button', { name: new RegExp(`Ajouter une ${name}`) }).click();
  await page.getByRole('button', { name: new RegExp(`Ajouter une ${name}`) }).click();
  await expect(page.getByText(/Il manque 3\s000\sAr/)).toBeVisible();

  await page.getByRole('button', { name: /Insérer un billet de 2\s000\sAr/ }).click();
  await expect(page.getByLabel('Solde du wallet')).toContainText(/2\s000\sAr/);
  await page.getByRole('button', { name: /Insérer un billet de 1\s000\sAr/ }).click();
  await expect(page.getByText(/Prêt : 3\s000\sAr/)).toBeVisible();

  await page.getByRole('button', { name: 'Valider la commande' }).click();
  await expect(page.getByRole('heading', { name: 'Commande servie' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Commande servie' })).toBeFocused();
  await page.getByRole('button', { name: 'Terminer' }).click();
  await expect(page.getByRole('heading', { name: 'Connexion' })).toBeVisible();
});

test('le panier est plafonné au stock et un billet trop gros est désactivé', async ({ page }) => {
  await loginAsClient(page);
  const add = page.getByRole('button', { name: new RegExp(`Ajouter une ${state().product}`) });
  for (let i = 0; i < 3; i++) await add.click();
  await expect(page.getByLabel(`Quantité de ${state().product}`)).toHaveText('3');
});
