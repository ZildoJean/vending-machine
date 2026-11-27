import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MONEY_CONFIG, TIMEOUT_CONFIG } from '@vending/shared';
import { LockTimeoutError } from '../db/errors';
import { balanceOf, deposit, resetMachine, stockOf } from '../../testing/pg-fixtures';
import { ScriptedDispenser, failAt } from '../../testing/scripted-dispenser';
import { createHarness, ORIGIN } from '../../testing/http-harness';
import type { Harness } from '../../testing/http-harness';
import { SESSION_COOKIE } from './app';

let h: Harness;
let n = 0;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetMachine(h.pool);
  await h.pool.query('DELETE FROM sessions');
});
const uniq = (p: string): string => `${p}${++n}x`;
const key = (): string => `idem-key-${++n}-${Math.random().toString(36).slice(2)}`;
const uuid = (): string => crypto.randomUUID();
const json = <T = Record<string, any>>(res: { body: string }): T => JSON.parse(res.body) as T;

async function session(balance = 0) {
  const login = uniq('cli');
  const userId = await h.createClient(login, '135792', balance);
  const { token } = await h.login(login, '135792');
  if (token === undefined) throw new Error('login refusé');
  return { login, userId, token };
}
/** k = null : AUCUN en-tête Idempotency-Key (un `undefined` déclencherait la valeur par défaut). */
const order = (token: string, items: unknown, k: string | null = key()) =>
  h.call('POST', '/orders', { cookie: token, body: { items }, ...(k === null ? {} : { headers: { 'idempotency-key': k } }) });

describe('lectures', () => {
  it('GET /products : produits actifs seulement, triés par nom, avec stock', async () => {
    const { token } = await session();
    const a = await h.product(1_500, 4);
    const b = await h.product(500, 0);
    await h.pool.query(`UPDATE products SET name = 'zz-actif' WHERE id = $1`, [a]);
    await h.pool.query(`UPDATE products SET name = 'aa-actif' WHERE id = $1`, [b]);
    const hidden = await h.product(700, 3);
    await h.pool.query(`UPDATE products SET active = false WHERE id = $1`, [hidden]);
    const res = await h.call('GET', '/products', { cookie: token });
    expect(res.statusCode).toBe(200);
    const names = json<{ products: { id: string; name: string; stock: number }[] }>(res).products;
    expect(names.map((p) => p.id)).not.toContain(hidden);
    const iA = names.findIndex((p) => p.id === b);
    const iB = names.findIndex((p) => p.id === a);
    expect(iA).toBeGreaterThanOrEqual(0);
    expect(iA).toBeLessThan(iB);
    expect(names[iB]).toEqual({ id: a, name: 'zz-actif', priceAr: 1_500, stock: 4 });
  });

  it('GET /wallet : solde, plafond et coupures acceptées', async () => {
    const { token } = await session(2_000);
    expect(json(await h.call('GET', '/wallet', { cookie: token }))).toEqual({
      balanceAr: 2_000,
      walletCapAr: MONEY_CONFIG.walletCap,
      acceptedBills: MONEY_CONFIG.acceptedBills,
    });
  });

  it('GET /machine/status est public et ne révèle ni utilisateur ni détail', async () => {
    expect(json(await h.call('GET', '/machine/status'))).toEqual({ status: 'IDLE' });
    await session();
    const s = await h.call('GET', '/machine/status');
    expect(json(s)).toEqual({ status: 'IN_USE' });
    expect(s.body).not.toMatch(/user|login|id/i);
  });

  it('GET /health : 200, puis 503 si la base est inaccessible', async () => {
    expect((await h.call('GET', '/health')).statusCode).toBe(200);
    const broken = await createHarness({
      override: {
        ping: async () => {
          throw new Error('pg down');
        },
      },
    });
    try {
      const r = await broken.call('GET', '/health');
      expect(r.statusCode).toBe(503);
      expect(r.body).not.toContain('pg down');
    } finally {
      await broken.close();
    }
  });
});

describe('dépôt', () => {
  it('crédite le wallet', async () => {
    const { token, userId } = await session();
    const r = await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 5_000, insertionId: uuid() } });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ balanceAr: 5_000, replayed: false });
    expect(await balanceOf(h.pool, userId)).toBe(5_000);
  });

  it('même insertionId rejoué : un seul crédit ; autre montant avec le même id : 409', async () => {
    const { token, userId } = await session();
    const insertionId = uuid();
    await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 2_000, insertionId } });
    const again = await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 2_000, insertionId } });
    expect(json(again)).toEqual({ balanceAr: 2_000, replayed: true });
    const reused = await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 5_000, insertionId } });
    expect(reused.statusCode).toBe(409);
    expect(json(reused).error.code).toBe('INSERTION_ID_REUSED');
    expect(await balanceOf(h.pool, userId)).toBe(2_000);
  });

  it("insertionId d'un AUTRE client : refusé (409), pas de rejeu inter-comptes", async () => {
    const a = await session();
    const insertionId = uuid();
    await h.call('POST', '/wallet/deposit', { cookie: a.token, body: { bill: 1_000, insertionId } });
    await h.call('POST', '/auth/logout', { cookie: a.token });
    const b = await session();
    const r = await h.call('POST', '/wallet/deposit', { cookie: b.token, body: { bill: 1_000, insertionId } });
    expect(r.statusCode).toBe(409);
    expect(await balanceOf(h.pool, b.userId)).toBe(0);
  });

  it('deux billets de 20 000 distincts : deux crédits', async () => {
    const { token, userId } = await session();
    await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 20_000, insertionId: uuid() } });
    await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 20_000, insertionId: uuid() } });
    expect(await balanceOf(h.pool, userId)).toBe(40_000);
  });

  it.each([
    [1_500, 422, 'BILL_REJECTED'],
    [1, 422, 'BILL_REJECTED'],
    [-1_000, 400, 'VALIDATION_ERROR'],
    ['1000', 400, 'VALIDATION_ERROR'],
    [1.5, 400, 'VALIDATION_ERROR'],
    [0, 400, 'VALIDATION_ERROR'],
  ])('billet %p -> %i %s', async (bill, status, code) => {
    const { token, userId } = await session();
    const r = await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill, insertionId: uuid() } });
    expect(r.statusCode).toBe(status);
    expect(json(r).error.code).toBe(code);
    expect(await balanceOf(h.pool, userId)).toBe(0);
  });

  it('plafond : le billet qui le ferait dépasser est refusé en entier', async () => {
    const { token, userId } = await session(90_000);
    const r = await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 20_000, insertionId: uuid() } });
    expect(r.statusCode).toBe(422);
    expect(json(r).error.code).toBe('WALLET_CAP_EXCEEDED');
    expect(await balanceOf(h.pool, userId)).toBe(90_000);
    expect((await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 10_000, insertionId: uuid() } })).statusCode).toBe(200);
  });

  it('un dépôt compte comme une activité (session prolongée) ; sans session : 401', async () => {
    const { token } = await session();
    h.clock.advance(100_000);
    await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 1_000, insertionId: uuid() } });
    h.clock.advance(100_000);
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(200);
    expect((await h.call('POST', '/wallet/deposit', { body: { bill: 1_000, insertionId: uuid() } })).statusCode).toBe(401);
  });

  it('dépôt refusé pendant la distribution (409)', async () => {
    const slow = await createHarness({
      dispenser: new ScriptedDispenser(async () => (await new Promise((r) => setTimeout(r, 400)), { delivered: true })),
    });
    try {
      await slow.createClient('slowcli', '135792', 5_000);
      const prod = await slow.product(1_000, 5);
      const { token } = await slow.login('slowcli', '135792');
      const running = slow.call('POST', '/orders', {
        cookie: token,
        headers: { 'idempotency-key': 'key-deposit-test-1' },
        body: { items: [{ productId: prod, qty: 1 }] },
      });
      await new Promise((r) => setTimeout(r, 150));
      const dep = await slow.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 1_000, insertionId: uuid() } });
      expect(dep.statusCode).toBe(409);
      expect(json(dep).error.code).toBe('DISPENSING_IN_PROGRESS');
      expect((await running).statusCode).toBe(200);
    } finally {
      await slow.close();
    }
  });
});

describe('commande', () => {
  it('parcours complet : commande livrée, session fermée, reconnexion, dernière commande, rejeu', async () => {
    const login = uniq('flow');
    const userId = await h.createClient(login, '135792', 5_000);
    const prod = await h.product(1_500, 5);
    const { token } = await h.login(login, '135792');
    const k = key();
    const res = await order(token as string, [{ productId: prod, qty: 2 }], k);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ status: 'DISPENSED', totalAr: 3_000, refundedAr: 0, balanceAr: 2_000, replayed: false });
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect(await stockOf(h.pool, prod)).toBe(3);

    expect((await h.call('GET', '/wallet', { cookie: token })).statusCode).toBe(401); // session close
    // rejeu avec l'ancien cookie : refusé à l'authentification, SANS second débit
    expect((await order(token as string, [{ productId: prod, qty: 2 }], k)).statusCode).toBe(401);
    expect(await balanceOf(h.pool, userId)).toBe(2_000);

    const again = await h.login(login, '135792');
    const last = await h.call('GET', '/orders/last', { cookie: again.token });
    expect(json(last)).toMatchObject({ status: 'DISPENSED', totalAr: 3_000, balanceAr: 2_000 });
    // et le rejeu AUTHENTIFIÉ de la même clé renvoie le même résultat, sans rien refaire
    const replay = await order(again.token as string, [{ productId: prod, qty: 2 }], k);
    expect(json(replay)).toMatchObject({ status: 'DISPENSED', replayed: true, balanceAr: 2_000 });
    expect(await stockOf(h.pool, prod)).toBe(3);
  });

  it('panne du matériel : résultat partiel avec remboursement, dans la réponse', async () => {
    const jam = await createHarness({ dispenser: new ScriptedDispenser(failAt(1)) });
    try {
      await jam.createClient('jamcli', '135792', 10_000);
      const prod = await jam.product(1_500, 5);
      const { token } = await jam.login('jamcli', '135792');
      const r = await jam.call('POST', '/orders', {
        cookie: token,
        headers: { 'idempotency-key': 'key-jam-test-0001' },
        body: { items: [{ productId: prod, qty: 3 }] },
      });
      expect(r.statusCode).toBe(200);
      expect(JSON.parse(r.body)).toMatchObject({ status: 'PARTIALLY_DISPENSED', totalAr: 4_500, refundedAr: 3_000, balanceAr: 8_500 });
    } finally {
      await jam.close();
    }
  });

  it.each([
    ['solde insuffisant', (p: string) => [{ productId: p, qty: 3 }], 'INSUFFICIENT_FUNDS', { missingAr: 3_500, totalAr: 4_500 }],
    ['stock dépassé', (p: string) => [{ productId: p, qty: 9 }], 'INSUFFICIENT_STOCK', { lineIndex: 0 }],
    ['panier vide', () => [], 'EMPTY_CART', {}],
    ['produit inconnu', () => [{ productId: crypto.randomUUID(), qty: 1 }], 'UNKNOWN_PRODUCT', { lineIndex: 0 }],
    ['quantité nulle', (p: string) => [{ productId: p, qty: 0 }], 'INVALID_QTY', { lineIndex: 0 }],
    [
      'doublon',
      (p: string) => [
        { productId: p, qty: 1 },
        { productId: p, qty: 1 },
      ],
      'DUPLICATE_LINE',
      { lineIndex: 1 },
    ],
  ])('%s -> 422 %s, session conservée', async (_n, items, code, details) => {
    const { token, userId } = await session(1_000);
    const prod = await h.product(1_500, 5);
    const r = await order(token, items(prod));
    expect(r.statusCode).toBe(422);
    expect(json(r).error.code).toBe(code);
    expect(json(r).error.details ?? {}).toMatchObject(details);
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(200);
    expect(await balanceOf(h.pool, userId)).toBe(1_000);
  });

  it('plafond : un panier plus cher que le wallet ne pourra jamais être payé', async () => {
    const { token } = await session(1_000);
    const prod = await h.product(12_000, 20);
    const r = await order(token, [{ productId: prod, qty: 10 }]);
    expect(json(r).error.code).toBe('CART_EXCEEDS_CAP');
  });

  it('en-tête Idempotency-Key manquant ou trop court : 400', async () => {
    const { token } = await session(5_000);
    const prod = await h.product(1_000, 5);
    for (const k of [null, 'court']) {
      const r = await order(token, [{ productId: prod, qty: 1 }], k);
      expect(r.statusCode).toBe(400);
      expect(json(r).error.code).toBe('INVALID_IDEMPOTENCY_KEY');
    }
  });

  it('même clé, autre panier : 409 IDEMPOTENCY_KEY_REUSED, aucune nouvelle commande', async () => {
    const login = uniq('reuse');
    const userId = await h.createClient(login, '135792', 9_000);
    const prod = await h.product(1_000, 5);
    const k = key();
    const first = await h.login(login, '135792');
    expect((await order(first.token as string, [{ productId: prod, qty: 1 }], k)).statusCode).toBe(200);
    const second = await h.login(login, '135792'); // la session précédente a été fermée par la commande
    const r = await order(second.token as string, [{ productId: prod, qty: 2 }], k);
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(await balanceOf(h.pool, userId)).toBe(8_000);
    expect(await stockOf(h.pool, prod)).toBe(4);
  });

  it("un client ne voit jamais la commande d'un autre", async () => {
    const a = await session(5_000);
    const prod = await h.product(1_000, 5);
    await order(a.token, [{ productId: prod, qty: 1 }]);
    const b = await session();
    expect((await h.call('GET', '/orders/last', { cookie: b.token })).statusCode).toBe(404);
  });

  it('validation des entrées : types, champs inconnus, JSON invalide, corps trop gros, mauvais type de contenu', async () => {
    const { token } = await session(5_000);
    const prod = await h.product(1_000, 5);
    const bad = await order(token, [{ productId: prod, qty: '2' }]);
    expect(bad.statusCode).toBe(400);
    expect(json(bad).error.code).toBe('VALIDATION_ERROR');
    expect(
      (await h.call('POST', '/orders', { cookie: token, headers: { 'idempotency-key': key() }, body: { items: [], pirate: 1 } }))
        .statusCode,
    ).toBe(400);
    const badJson = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: '{pas du json',
    });
    expect(badJson.statusCode).toBe(400);
    expect(json(badJson).error.code).toBe('BAD_REQUEST');
    const huge = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      payload: JSON.stringify({ login: 'a'.repeat(20_000), secret: 'x' }),
    });
    expect(huge.statusCode).toBe(413);
    expect(json(huge).error.code).toBe('PAYLOAD_TOO_LARGE');
    const wrongType = await h.app.inject({
      method: 'POST',
      url: '/auth/login',
      headers: { origin: ORIGIN, 'content-type': 'application/xml' },
      payload: '<x/>',
    });
    expect(wrongType.statusCode).toBe(415);
    expect(json(wrongType).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
  });
});

describe('durcissement', () => {
  it("origine inconnue sur une requête qui modifie l'état : 403 ; sans Origin ou origine autorisée : accepté", async () => {
    const login = uniq('csrf');
    await h.createClient(login, '135792');
    const evil = await h.call('POST', '/auth/login', { origin: 'https://evil.example', body: { login, secret: '135792' } });
    expect(evil.statusCode).toBe(403);
    expect(json(evil).error.code).toBe('FORBIDDEN_ORIGIN');
    expect((await h.call('POST', '/auth/login', { origin: null, body: { login, secret: '135792' } })).statusCode).toBe(200);
    await resetMachine(h.pool);
    expect((await h.call('POST', '/auth/login', { origin: ORIGIN, body: { login, secret: '135792' } })).statusCode).toBe(200);
  });

  it('en-têtes de sécurité présents, pas de x-powered-by', async () => {
    const r = await h.call('GET', '/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-powered-by']).toBeUndefined();
    expect(r.headers['strict-transport-security']).toBeDefined();
  });

  it('route inconnue : 404 JSON', async () => {
    const r = await h.call('GET', '/nimporte/quoi');
    expect(r.statusCode).toBe(404);
    expect(json(r).error.code).toBe('NOT_FOUND');
  });

  it('erreur interne : réponse générique (aucun détail, aucune pile), détail journalisé côté serveur', async () => {
    const boom = await createHarness({
      override: {
        queries: {
          products: async () => {
            throw new Error('mot-de-passe-base-xyz');
          },
          balance: async () => 0,
          lastOrder: async () => null,
        } as never,
      },
    });
    try {
      await boom.createClient('boomcli', '135792');
      const { token } = await boom.login('boomcli', '135792');
      const r = await boom.call('GET', '/products', { cookie: token });
      expect(r.statusCode).toBe(500);
      expect(r.body).not.toContain('mot-de-passe-base-xyz');
      expect(r.body).not.toMatch(/stack|at /);
      expect(JSON.parse(r.body).error).toMatchObject({ code: 'INTERNAL', message: 'Erreur interne.' });
      expect(boom.logs.join('')).toContain('mot-de-passe-base-xyz');
    } finally {
      await boom.close();
    }
  });

  it('verrou indisponible : 503 + Retry-After (jamais un blocage)', async () => {
    const busy = await createHarness({
      override: {
        deposit: {
          deposit: async () => {
            throw new LockTimeoutError();
          },
        } as never,
      },
    });
    try {
      await busy.createClient('lockcli', '135792');
      const { token } = await busy.login('lockcli', '135792');
      const r = await busy.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 1_000, insertionId: uuid() } });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBe('1');
      expect(json(r).error.code).toBe('MACHINE_LOCKED');
    } finally {
      await busy.close();
    }
  });

  it('limitation de débit sur la connexion : 429 après le seuil', async () => {
    const lim = await createHarness({ limits: { loginMax: 3 } });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 5; i++) codes.push((await lim.login('nobody', '123123')).res.statusCode);
      expect(codes).toEqual([401, 401, 401, 429, 429]);
      const r = await lim.login('nobody', '123123');
      expect(JSON.parse(r.res.body).error.code).toBe('RATE_LIMITED');
      expect(r.res.headers['retry-after']).toBeDefined();
    } finally {
      await lim.close();
    }
  });

  it('les journaux ne contiennent ni le secret saisi, ni le jeton, ni le cookie', async () => {
    const login = uniq('logs');
    await h.createClient(login, '135792');
    h.logs.length = 0;
    const { token } = await h.login(login, '135792');
    await h.call('GET', '/me', { cookie: token });
    await h.login(login, '864209-mauvais');
    const all = h.logs.join('');
    expect(all.length).toBeGreaterThan(0);
    expect(all).not.toContain('135792');
    expect(all).not.toContain('864209-mauvais');
    expect(all).not.toContain(token as string);
  });

  it('en vrai HTTP (écoute sur un port) : cookie renvoyé et réutilisé, drapeaux de sécurité présents', async () => {
    const login = uniq('real');
    await h.createClient(login, '135792');
    const address = await h.app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const res = await fetch(`${address}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGIN },
        body: JSON.stringify({ login, secret: '135792' }),
      });
      expect(res.status).toBe(200);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toMatch(/HttpOnly/i);
      expect(setCookie).toMatch(/SameSite=Strict/i);
      expect(setCookie).toMatch(/Secure/i);
      const pair = setCookie.split(';')[0] as string;
      const me = await fetch(`${address}/me`, { headers: { cookie: pair } });
      expect(me.status).toBe(200);
      expect(((await me.json()) as { login: string }).login).toBe(login);
    } finally {
      await h.call('POST', '/auth/logout', { cookie: undefined });
    }
  });
});

void deposit;
void TIMEOUT_CONFIG;
