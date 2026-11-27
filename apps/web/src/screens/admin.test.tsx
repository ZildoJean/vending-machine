import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client';
import { ADMIN_ME, createFakeApi } from '../test/fake-api';
import { renderWithApi } from '../test/render';
import { AdminScreen } from './AdminScreen';

const open = async (initial = {}) => {
  const f = createFakeApi({ me: ADMIN_ME, ...initial });
  const user = userEvent.setup();
  renderWithApi(<AdminScreen me={ADMIN_ME} onLoggedOut={() => undefined} />, f.api);
  return { ...f, user };
};
const tab = (user: ReturnType<typeof userEvent.setup>, name: string) => user.click(screen.getByRole('button', { name }));
const mine = { status: 'MAINTENANCE' as const, ownedByMe: true, remainingMs: 600_000 };
const prod = { id: 'p1', name: 'Cola', priceAr: 1_500, stock: 4, active: true };

describe('Machine', () => {
  it('libre : on peut entrer en maintenance (et seulement cela)', async () => {
    const { user, mocks } = await open();
    expect(await screen.findByText('Machine libre.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sortir de la maintenance' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fermer la session client' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Entrer en maintenance' }));
    await waitFor(() => expect(mocks.admin.enterMaintenance).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/Vous êtes en maintenance/)).toBeInTheDocument();
    expect(screen.getByRole('timer')).toHaveTextContent(/^(15:00|14:59)$/);
  });

  it('client actif : fermeture forcée avec confirmation ; pendant la distribution, impossible', async () => {
    const { user, mocks, s } = await open({ adminMachine: { status: 'IN_USE', phase: 'SELECTING' } });
    await screen.findByText(/Un client utilise la machine/);
    expect(screen.getByRole('button', { name: 'Entrer en maintenance' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Fermer la session client' }));
    expect(mocks.admin.forceClose).not.toHaveBeenCalled(); // pas d'action sans confirmation
    await user.click(screen.getByRole('button', { name: 'Confirmer' }));
    await waitFor(() => expect(mocks.admin.forceClose).toHaveBeenCalledTimes(1));
    s.adminMachine = { status: 'IN_USE', phase: 'DISPENSING' };
  });

  it('distribution en cours : le bouton de fermeture forcée est désactivé', async () => {
    await open({ adminMachine: { status: 'IN_USE', phase: 'DISPENSING' } });
    expect(await screen.findByText(/distribution en cours : action impossible/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Fermer la session client' })).toBeDisabled();
  });

  it("maintenance tenue par un autre administrateur : rien d'utilisable", async () => {
    await open({ adminMachine: { status: 'MAINTENANCE', ownedByMe: false, remainingMs: 100_000 } });
    expect(await screen.findByText('Maintenance tenue par un autre administrateur.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sortir de la maintenance' })).toBeDisabled();
  });

  it('erreur serveur affichée', async () => {
    const { user, mocks } = await open();
    mocks.admin.enterMaintenance.mockRejectedValueOnce(new ApiError(409, 'MACHINE_BUSY', 'x'));
    await screen.findByText('Machine libre.');
    await user.click(screen.getByRole('button', { name: 'Entrer en maintenance' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('utilisée par un autre client');
  });
});

describe('Produits', () => {
  it("hors maintenance : tout est désactivé et l'explication est donnée", async () => {
    const { user } = await open({ adminProducts: [prod] });
    await tab(user, 'Produits');
    expect(await screen.findByText(/entrez d'abord en maintenance/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nom')).toBeDisabled();
    expect(await screen.findByLabelText('Quantité')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Créer' })).toBeDisabled();
  });

  it('en maintenance : création avec nombres entiers, puis liste actualisée', async () => {
    const { user, mocks } = await open({ adminMachine: mine });
    await tab(user, 'Produits');
    await waitFor(() => expect(screen.getByLabelText('Nom')).toBeEnabled());
    await user.type(screen.getByLabelText('Nom'), '  Jus  ');
    await user.type(screen.getByLabelText(/Prix/), '1200');
    await user.clear(screen.getByLabelText('Stock initial'));
    await user.type(screen.getByLabelText('Stock initial'), '8');
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    await waitFor(() => expect(mocks.admin.createProduct).toHaveBeenCalledWith({ name: 'Jus', priceAr: 1_200, initialStock: 8 }));
    expect(await screen.findByDisplayValue('Jus')).toBeInTheDocument();
  });

  it("prix non numérique : création impossible (pas d'appel)", async () => {
    const { user, mocks } = await open({ adminMachine: mine });
    await tab(user, 'Produits');
    await waitFor(() => expect(screen.getByLabelText('Nom')).toBeEnabled());
    await user.type(screen.getByLabelText('Nom'), 'Jus');
    await user.type(screen.getByLabelText(/Prix/), 'douze');
    expect(screen.getByRole('button', { name: 'Créer' })).toBeDisabled();
    expect(mocks.admin.createProduct).not.toHaveBeenCalled();
  });

  it('modification : seul le champ changé est envoyé', async () => {
    const { user, mocks } = await open({ adminMachine: mine, adminProducts: [{ ...prod }] });
    await tab(user, 'Produits');
    const row = (await screen.findByLabelText('Nom (Cola)')).closest('li') as HTMLElement;
    const price = within(row).getByLabelText('Prix (Ar)');
    await waitFor(() => expect(price).toBeEnabled());
    expect(screen.getByRole('button', { name: 'Enregistrer Cola' })).toBeDisabled(); // rien de modifié
    await user.clear(price);
    await user.type(price, '2000');
    await user.click(screen.getByRole('button', { name: 'Enregistrer Cola' }));
    await waitFor(() => expect(mocks.admin.updateProduct).toHaveBeenCalledWith('p1', { priceAr: 2_000 }));
  });

  it('stock : réapprovisionner (positif) et corriger (signé)', async () => {
    const { user, mocks } = await open({ adminMachine: mine, adminProducts: [{ ...prod }] });
    await tab(user, 'Produits');
    const qty = await screen.findByLabelText('Quantité');
    await waitFor(() => expect(qty).toBeEnabled());
    await user.type(qty, '-3');
    expect(screen.getByRole('button', { name: 'Réapprovisionner Cola' })).toBeDisabled(); // négatif : pas un réapprovisionnement
    await user.click(screen.getByRole('button', { name: 'Corriger le stock de Cola' }));
    await waitFor(() => expect(mocks.admin.adjust).toHaveBeenCalledWith('p1', -3));
    await user.type(await screen.findByLabelText('Quantité'), '12');
    await user.click(screen.getByRole('button', { name: 'Réapprovisionner Cola' }));
    await waitFor(() => expect(mocks.admin.restock).toHaveBeenCalledWith('p1', 12));
  });

  it('désactiver un produit', async () => {
    const { user, mocks } = await open({ adminMachine: mine, adminProducts: [{ ...prod }] });
    await tab(user, 'Produits');
    const box = await screen.findByRole('checkbox', { name: 'Vendu' });
    await waitFor(() => expect(box).toBeEnabled());
    await user.click(box);
    await waitFor(() => expect(mocks.admin.updateProduct).toHaveBeenCalledWith('p1', { active: false }));
  });

  it('refus serveur (maintenance expirée entre-temps) : message explicite', async () => {
    const { user, mocks } = await open({ adminMachine: mine });
    await tab(user, 'Produits');
    await waitFor(() => expect(screen.getByLabelText('Nom')).toBeEnabled());
    mocks.admin.createProduct.mockRejectedValueOnce(new ApiError(409, 'MAINTENANCE_REQUIRED', 'x'));
    await user.type(screen.getByLabelText('Nom'), 'Jus');
    await user.type(screen.getByLabelText(/Prix/), '1200');
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Entrez d'abord en maintenance");
  });
});

describe('Comptes', () => {
  it('le PIN est validé à la saisie (format, trop simple) avant tout appel', async () => {
    const { user, mocks } = await open();
    await tab(user, 'Comptes');
    await user.type(await screen.findByLabelText('Identifiant'), 'carol');
    const pin = screen.getByLabelText(/PIN \(6 chiffres\)/);
    await user.type(pin, '12345');
    expect(screen.getByText('Le PIN doit comporter exactement 6 chiffres.')).toBeInTheDocument();
    await user.clear(pin);
    await user.type(pin, '123456');
    expect(screen.getByText('PIN trop simple (suite ou répétition).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Créer le compte' })).toBeDisabled();
    await user.clear(pin);
    await user.type(pin, '482915');
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }));
    await waitFor(() => expect(mocks.admin.createUser).toHaveBeenCalledWith('carol', '482915'));
    expect(await screen.findByText('Compte « carol » créé.')).toBeInTheDocument();
  });

  it('liste : compte verrouillé signalé ; réinitialisation du PIN', async () => {
    const { user, mocks } = await open({ users: [{ id: 'c1', login: 'dave', locked: true }] });
    await tab(user, 'Comptes');
    expect(await screen.findByText('verrouillé')).toBeInTheDocument();
    await user.type(screen.getByLabelText('Nouveau PIN pour dave'), '864209');
    await user.click(screen.getByRole('button', { name: 'Réinitialiser le PIN de dave' }));
    await waitFor(() => expect(mocks.admin.resetPin).toHaveBeenCalledWith('c1', '864209'));
    expect(await screen.findByText(/PIN de « dave » réinitialisé/)).toBeInTheDocument();
  });

  it('login déjà pris : message du serveur', async () => {
    const { user, mocks } = await open();
    mocks.admin.createUser.mockRejectedValueOnce(new ApiError(409, 'LOGIN_TAKEN', 'x'));
    await tab(user, 'Comptes');
    await user.type(await screen.findByLabelText('Identifiant'), 'carol');
    await user.type(screen.getByLabelText(/PIN \(6 chiffres\)/), '482915');
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Ce login existe déjà.');
  });
});

describe('Audit et navigation', () => {
  it('libellés lisibles, détails avant/après repliés', async () => {
    const { user } = await open({
      audit: [
        {
          id: 2,
          actorId: 'a1',
          action: 'PRODUCT_UPDATE',
          entity: 'product',
          entityId: 'p1',
          oldValue: { priceAr: 1_000 },
          newValue: { priceAr: 3_000 },
          createdAt: 1_700_000_000_000,
        },
        {
          id: 1,
          actorId: null,
          action: 'ACTION_INCONNUE',
          entity: 'x',
          entityId: null,
          oldValue: null,
          newValue: null,
          createdAt: 1_700_000_000_000,
        },
      ],
    });
    await tab(user, 'Audit');
    expect(await screen.findByText("Modification d'un produit")).toBeInTheDocument();
    expect(screen.getByText('ACTION_INCONNUE')).toBeInTheDocument(); // jamais de trou : le code brut s'affiche
    const li = screen.getByText("Modification d'un produit").closest('li') as HTMLElement;
    await user.click(within(li).getByText('Détails'));
    expect(within(li).getByText(/3000/)).toBeInTheDocument();
  });

  it('la section active est signalée (aria-current)', async () => {
    const { user } = await open();
    expect(screen.getByRole('button', { name: 'Machine' })).toHaveAttribute('aria-current', 'page');
    await tab(user, 'Audit');
    expect(screen.getByRole('button', { name: 'Audit' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('navigation', { name: /Sections d'administration/ })).toBeInTheDocument();
  });
});
