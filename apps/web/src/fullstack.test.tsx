/**
 * TEST DE BOUT EN BOUT : la vraie application React (jsdom) -> vraie API Fastify -> vrai PostgreSQL.
 * Aucune fausse API : seule la couche réseau est remplacée par un pont (app.inject) qui joue le rôle du
 * navigateur pour les cookies (jar) et peut PERDRE une réponse après que le serveur l'a traitée.
 */
import { configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { createApi } from './api/client';
import { ADMIN_LOGIN, ADMIN_PASSWORD, ORIGIN, createHarness } from '../../server/src/testing/http-harness';
import type { Harness } from '../../server/src/testing/http-harness';
import { resetMachine } from '../../server/src/testing/pg-fixtures';
import { ScriptedDispenser, failAt } from '../../server/src/testing/scripted-dispenser';

configure({ asyncUtilTimeout: 10_000 });

type Lose = (method: string, path: string) => boolean;

/** Pont réseau : même rôle que le navigateur (cookies) ; `lose` simule une réponse perdue APRÈS traitement serveur. */
function bridge(h: Harness, jar: Map<string, string>, lose: Lose = () => false): typeof fetch {
  return (async (input: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = String(input).replace(/^\/api/, '');
    const headers: Record<string, string> = { ...(init?.headers as Record<string, string> | undefined), origin: ORIGIN };
    if (jar.size > 0) headers.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await h.app.inject({
      method: method as 'GET',
      url: path,
      headers,
      ...(init?.body ? { payload: init.body as string } : {}),
    });
    if (lose(method, path)) throw new TypeError('réponse perdue'); // le serveur a TRAITÉ la requête, le client n'en sait rien
    for (const sc of [res.headers['set-cookie']].flat().filter((x): x is string => typeof x === 'string')) {
      const [pair, ...attrs] = sc.split(';');
      const [name, value = ''] = (pair ?? '').split('=');
      if (value === '' || attrs.some((a) => /max-age=0/i.test(a))) jar.delete(name as string);
      else jar.set(name as string, value);
    }
    return new Response(res.statusCode === 204 ? null : res.body, {
      status: res.statusCode,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function mount(h: Harness, jar = new Map<string, string>(), lose?: Lose) {
  const makeApi = (onUnauthorized: (c: string) => void) => createApi({ baseUrl: '/api', fetchImpl: bridge(h, jar, lose), onUnauthorized });
  return render(<App makeApi={makeApi} />);
}

const nb = (t: string): RegExp => new RegExp(t.replace(/ /g, '\\s'));
let n = 0;
const uniq = (p: string): string => `${p}${++n}x`;
const typeLogin = async (user: ReturnType<typeof userEvent.setup>, login: string, secret: string) => {
  await user.type(await screen.findByLabelText('Identifiant'), login);
  await user.type(screen.getByLabelText(/PIN \(6 chiffres\)/), secret);
  await user.click(screen.getByRole('button', { name: 'Se connecter' }));
};
const one = async (h: Harness, sql: string, p: unknown[] = []) => (await h.pool.query(sql, p)).rows[0] as Record<string, any>;
const ledger = async (h: Harness, userId: string) =>
  (await h.pool.query('SELECT type FROM wallet_ledger WHERE user_id = $1 ORDER BY id', [userId])).rows.map((r) => r.type as string);
const insertBill = (user: ReturnType<typeof userEvent.setup>, amount: string) =>
  screen.findByRole('button', { name: nb(`Insérer un billet de ${amount}`) }).then((b) => user.click(b));
const addToCart = async (user: ReturnType<typeof userEvent.setup>, name: string, k = 1) => {
  for (let i = 0; i < k; i++) await user.click(await screen.findByRole('button', { name: new RegExp(`Ajouter une ${name}`) }));
};

let h: Harness;
let jam: Harness;
beforeAll(async () => {
  h = await createHarness();
  jam = await createHarness({ dispenser: new ScriptedDispenser(failAt(1)) });
});
afterAll(async () => {
  await h.close();
  await jam.close();
});
beforeEach(async () => {
  for (const x of [h, jam]) {
    await resetMachine(x.pool);
    await x.pool.query('DELETE FROM sessions');
  }
});

describe("parcours complet par l'interface", () => {
  it("l'administrateur prépare le catalogue, le client achète, tout est cohérent en base", async () => {
    const user = userEvent.setup();
    const name = uniq('Cola');
    const login = uniq('cli');
    const clientId = await h.createClient(login, '135792');

    // --- administrateur : maintenance, création du produit, sortie
    const admin = mount(h);
    await typeLogin(user, ADMIN_LOGIN, ADMIN_PASSWORD);
    expect(await screen.findByText(/Administrateur :/)).toBeInTheDocument();
    await screen.findByText('Machine libre.'); // l'état doit être chargé : sinon le bouton est encore désactivé
    await user.click(screen.getByRole('button', { name: 'Entrer en maintenance' }));
    expect(await screen.findByText(/Vous êtes en maintenance/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Produits' }));
    await waitFor(() => expect(screen.getByLabelText('Nom')).toBeEnabled());
    await user.type(screen.getByLabelText('Nom'), name);
    await user.type(screen.getByLabelText(/Prix/), '1500');
    await user.clear(screen.getByLabelText('Stock initial'));
    await user.type(screen.getByLabelText('Stock initial'), '5');
    await user.click(screen.getByRole('button', { name: 'Créer' }));
    expect(await screen.findByLabelText(`Nom (${name})`)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Machine' }));
    await user.click(await screen.findByRole('button', { name: 'Sortir de la maintenance' }));
    expect(await screen.findByText('Machine libre.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Me déconnecter' }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    admin.unmount();

    // --- client : connexion, panier, billets, validation
    mount(h);
    await typeLogin(user, login, '135792');
    expect(await screen.findByText(`Connecté :`, { exact: false })).toBeInTheDocument();
    await addToCart(user, name, 2);
    expect(await screen.findByText(nb('Il manque 3 000 Ar : insérez des billets'))).toBeInTheDocument();
    await insertBill(user, '2 000 Ar');
    await waitFor(() => expect(screen.getByLabelText('Solde du wallet')).toHaveTextContent(nb('2 000 Ar')));
    await insertBill(user, '1 000 Ar');
    expect(await screen.findByText(nb('Prêt : 3 000 Ar seront débités'))).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));

    expect(await screen.findByRole('heading', { name: 'Commande servie' })).toBeInTheDocument();
    expect(screen.getByText('2 boisson(s) servie(s) sur 2.')).toBeInTheDocument();
    // --- cohérence en base
    expect((await one(h, 'SELECT stock FROM products WHERE name = $1', [name])).stock).toBe(3);
    expect((await one(h, 'SELECT balance_ar FROM wallets WHERE user_id = $1', [clientId])).balance_ar).toBe(0);
    expect(await ledger(h, clientId)).toEqual(['DEPOSIT', 'DEPOSIT', 'PURCHASE']);
    expect((await one(h, 'SELECT kind FROM machine_state')).kind).toBe('IDLE');

    // --- fin de session, reconnexion, dernière commande
    await user.click(screen.getByRole('button', { name: 'Terminer' }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    await typeLogin(user, login, '135792');
    await user.click(await screen.findByText('Ma dernière commande'));
    expect(await screen.findByText(nb('Servie — 3 000 Ar, remboursé 0 Ar'))).toBeInTheDocument();
  });

  it('panne du distributeur : résultat partiel et remboursement affichés, cohérents avec la base', async () => {
    const user = userEvent.setup();
    const name = uniq('Jus');
    const login = uniq('jam');
    const clientId = await jam.createClient(login, '135792', 10_000);
    await jam.product(1_500, 5).then((id) => jam.pool.query('UPDATE products SET name = $1 WHERE id = $2', [name, id]));
    mount(jam);
    await typeLogin(user, login, '135792');
    await addToCart(user, name, 3);
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('heading', { name: 'Commande partiellement servie' })).toBeInTheDocument();
    expect(screen.getByText(nb('3 000 Ar ont été remboursés dans votre wallet.'))).toBeInTheDocument();
    expect(screen.getByText('1 / 3 non servie(s)', { exact: false })).toBeInTheDocument();
    expect(screen.getByText('8 500 Ar', { exact: false })).toBeInTheDocument();
    expect((await one(jam, 'SELECT balance_ar FROM wallets WHERE user_id = $1', [clientId])).balance_ar).toBe(8_500);
    expect(await ledger(jam, clientId)).toEqual(['DEPOSIT', 'PURCHASE', 'REFUND']);
    expect((await one(jam, 'SELECT stock FROM products WHERE name = $1', [name])).stock).toBe(4);
  });
});

describe('pannes et limites réelles', () => {
  it("session expirée (2 min d'inactivité) : l'action suivante ramène à la connexion avec l'explication", async () => {
    const user = userEvent.setup();
    const login = uniq('exp');
    await h.createClient(login, '135792');
    mount(h);
    await typeLogin(user, login, '135792');
    await screen.findByRole('button', { name: nb('Insérer un billet de 1 000 Ar') }); // le wallet est chargé
    h.clock.advance(120_000);
    await insertBill(user, '1 000 Ar');
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.getByText('Votre session a expiré par inactivité. Reconnectez-vous.')).toBeInTheDocument();
    expect((await one(h, 'SELECT kind FROM machine_state')).kind).toBe('IDLE'); // la machine est libérée
  });

  it('machine occupée : le second client voit un message clair, sans rien révéler', async () => {
    const user = userEvent.setup();
    const [a, b] = [uniq('occ'), uniq('lib')];
    await h.createClient(a, '135792');
    await h.createClient(b, '246813');
    expect((await h.login(a, '135792')).res.statusCode).toBe(200);
    mount(h);
    await typeLogin(user, b, '246813');
    expect(await screen.findByRole('alert')).toHaveTextContent('La machine est utilisée par un autre client');
    expect(screen.getByText('Machine utilisée par un autre client')).toBeInTheDocument();
  });

  it('mauvais PIN : message générique identique pour un compte inconnu', async () => {
    const user = userEvent.setup();
    const login = uniq('wr');
    await h.createClient(login, '135792');
    mount(h);
    await typeLogin(user, login, '999111');
    const first = (await screen.findByRole('alert')).textContent;
    expect(first).toBe('Identifiants invalides, ou compte temporairement verrouillé.');
  });

  it("stock épuisé entre-temps : refus du serveur, stock et panier mis à jour, rien n'est débité", async () => {
    const user = userEvent.setup();
    const name = uniq('Eau');
    const login = uniq('stk');
    const clientId = await h.createClient(login, '135792', 5_000);
    const pid = await h.product(500, 5);
    await h.pool.query('UPDATE products SET name = $1 WHERE id = $2', [name, pid]);
    mount(h);
    await typeLogin(user, login, '135792');
    await addToCart(user, name, 3);
    // quelqu'un d'autre (l'administrateur) corrige le stock pendant que le client hésite
    await h.pool.query(
      `INSERT INTO stock_movements (product_id, delta, reason, actor_id, created_at) VALUES ($1, -4, 'ADMIN_ADJUST', $2, 1)`,
      [pid, h.adminId],
    );
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stock insuffisant');
    await waitFor(() => expect(screen.getByLabelText(`Quantité de ${name}`)).toHaveTextContent('1'));
    expect((await one(h, 'SELECT balance_ar FROM wallets WHERE user_id = $1', [clientId])).balance_ar).toBe(5_000);
    expect(await ledger(h, clientId)).toEqual(['DEPOSIT']);
  });

  it("RÉPONSE PERDUE pendant le dépôt : « Réessayer » ne crédite qu'UNE fois", async () => {
    const user = userEvent.setup();
    const login = uniq('lostdep');
    const clientId = await h.createClient(login, '135792');
    let lost = false;
    mount(h, new Map(), (m, p) => (m === 'POST' && p === '/wallet/deposit' && !lost ? (lost = true) : false));
    await typeLogin(user, login, '135792');
    await insertBill(user, '1 000 Ar');
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    expect(await ledger(h, clientId)).toEqual(['DEPOSIT']); // le serveur HAD déjà crédité
    await user.click(screen.getByRole('button', { name: nb("Réessayer l'insertion du billet de 1 000 Ar") }));
    await waitFor(() => expect(screen.getByLabelText('Solde du wallet')).toHaveTextContent(nb('1 000 Ar')));
    expect(await ledger(h, clientId)).toEqual(['DEPOSIT']); // toujours un seul crédit
    expect((await one(h, 'SELECT balance_ar FROM wallets WHERE user_id = $1', [clientId])).balance_ar).toBe(1_000);
  });

  it("RÉPONSE PERDUE pendant la commande : la commande n'est débitée qu'UNE fois et reste consultable", async () => {
    const user = userEvent.setup();
    const name = uniq('Soda');
    const login = uniq('lostord');
    const clientId = await h.createClient(login, '135792', 5_000);
    const pid = await h.product(1_500, 5);
    await h.pool.query('UPDATE products SET name = $1 WHERE id = $2', [name, pid]);
    let lost = false;
    mount(h, new Map(), (m, p) => (m === 'POST' && p === '/orders' && !lost ? (lost = true) : false));
    await typeLogin(user, login, '135792');
    await addToCart(user, name, 2);
    await user.click(await screen.findByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Impossible de joindre la machine');
    // côté serveur, la commande a été traitée et la session fermée
    expect((await one(h, 'SELECT status FROM orders WHERE user_id = $1', [clientId])).status).toBe('DISPENSED');
    expect((await one(h, 'SELECT kind FROM machine_state')).kind).toBe('IDLE');
    // le client réessaie : la session est fermée, il est ramené à la connexion avec un message HONNÊTE
    await user.click(screen.getByRole('button', { name: 'Valider la commande' }));
    expect(await screen.findByRole('heading', { name: 'Connexion' })).toBeInTheDocument();
    expect(screen.getByText(/elle a peut-être été traitée/)).toBeInTheDocument();
    expect(screen.queryByText(/expiré par inactivité/)).not.toBeInTheDocument();
    expect(await ledger(h, clientId)).toEqual(['DEPOSIT', 'PURCHASE']);
    expect((await one(h, 'SELECT balance_ar FROM wallets WHERE user_id = $1', [clientId])).balance_ar).toBe(2_000);
    expect((await one(h, 'SELECT stock FROM products WHERE id = $1', [pid])).stock).toBe(3);
    // il se reconnecte et retrouve sa commande
    await typeLogin(user, login, '135792');
    await user.click(await screen.findByText('Ma dernière commande'));
    expect(await screen.findByText(nb('Servie — 3 000 Ar, remboursé 0 Ar'))).toBeInTheDocument();
  });
});

describe('administration : session client', () => {
  it("l'administrateur voit l'occupation, ferme la session après confirmation, la machine redevient libre", async () => {
    const user = userEvent.setup();
    const login = uniq('fant');
    await h.createClient(login, '135792');
    expect((await h.login(login, '135792')).res.statusCode).toBe(200);
    mount(h);
    await typeLogin(user, ADMIN_LOGIN, ADMIN_PASSWORD);
    expect(await screen.findByText(/Un client utilise la machine/)).toBeInTheDocument();
    expect(screen.getByText(/Un client utilise la machine/).textContent).not.toContain(login); // aucune identité
    await user.click(screen.getByRole('button', { name: 'Fermer la session client' }));
    await user.click(await screen.findByRole('button', { name: 'Confirmer' }));
    expect(await screen.findByText('Machine libre.')).toBeInTheDocument();
    expect((await one(h, 'SELECT kind FROM machine_state')).kind).toBe('IDLE');
    const audit = await one(h, `SELECT count(*) AS n FROM audit_log WHERE action = 'SESSION_FORCE_CLOSE'`);
    expect(Number(audit.n)).toBeGreaterThan(0);
  });

  it("les comptes et l'audit se consultent depuis l'interface (sans secret)", async () => {
    const user = userEvent.setup();
    const login = uniq('aud');
    mount(h);
    await typeLogin(user, ADMIN_LOGIN, ADMIN_PASSWORD);
    await user.click(await screen.findByRole('button', { name: 'Comptes' }));
    await user.type(await screen.findByLabelText('Identifiant'), login);
    await user.type(screen.getByLabelText(/PIN \(6 chiffres\)/), '482915');
    await user.click(screen.getByRole('button', { name: 'Créer le compte' }));
    expect(await screen.findByText(`Compte « ${login} » créé.`)).toBeInTheDocument();
    expect(await screen.findByText(login, { selector: 'span.font-medium' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Audit' }));
    expect((await screen.findAllByText("Création d'un compte client")).length).toBeGreaterThan(0);
    expect(within(document.body).queryByText(/482915|argon2/)).not.toBeInTheDocument();
  });
});
