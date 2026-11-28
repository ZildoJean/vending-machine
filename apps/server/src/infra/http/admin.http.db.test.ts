import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TIMEOUT_CONFIG } from '@vending/shared';
import { readMachineRow, resetMachine, stockOf } from '../../testing/pg-fixtures';
import { ScriptedDispenser } from '../../testing/scripted-dispenser';
import { createHarness } from '../../testing/http-harness';
import type { Harness } from '../../testing/http-harness';

let h: Harness;
let admin: string;
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
  admin = await h.loginAdmin();
});
const uniq = (p: string): string => `${p}-${++n}`;
const json = <T = Record<string, any>>(res: { body: string }): T => JSON.parse(res.body) as T;
const enter = () => h.call('POST', '/admin/maintenance/enter', { cookie: admin });
const create = (body: unknown) => h.call('POST', '/admin/products', { cookie: admin, body });

describe('maintenance et catalogue', () => {
  it('parcours : maintenance, création avec stock, client bloqué, sortie, le client voit le produit', async () => {
    expect((await enter()).statusCode).toBe(200);
    const name = uniq('Cola');
    const c = await create({ name: `  ${name}  `, priceAr: 1_500, initialStock: 5 });
    expect(c.statusCode).toBe(201);
    expect(json(c).product).toMatchObject({ name, priceAr: 1_500, stock: 5, active: true }); // nom nettoyé
    const login = uniq('cl');
    await h.createClient(login, '135792');
    expect((await h.login(login, '135792')).res.statusCode).toBe(503); // machine en maintenance
    expect((await h.call('POST', '/admin/maintenance/exit', { cookie: admin })).statusCode).toBe(200);
    const { token } = await h.login(login, '135792');
    const products = json<{ products: { name: string; stock: number }[] }>(await h.call('GET', '/products', { cookie: token })).products;
    expect(products.find((p) => p.name === name)).toMatchObject({ stock: 5 });
  });

  it('sans maintenance : 409 MAINTENANCE_REQUIRED sur toute action du catalogue', async () => {
    const id = await h.product(1_000, 3);
    for (const r of [
      await create({ name: uniq('X'), priceAr: 1_000 }),
      await h.call('PATCH', `/admin/products/${id}`, { cookie: admin, body: { priceAr: 2_000 } }),
      await h.call('POST', `/admin/products/${id}/restock`, { cookie: admin, body: { qty: 5 } }),
      await h.call('POST', `/admin/products/${id}/adjust`, { cookie: admin, body: { delta: -1 } }),
    ]) {
      expect(r.statusCode).toBe(409);
      expect(json(r).error.code).toBe('MAINTENANCE_REQUIRED');
    }
    expect(await stockOf(h.pool, id)).toBe(3);
  });

  it('client actif : maintenance refusée (409) ; fermeture forcée puis maintenance OK', async () => {
    const login = uniq('act');
    await h.createClient(login, '135792');
    await h.login(login, '135792');
    const r = await enter();
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('MACHINE_BUSY');
    expect((await h.call('POST', '/admin/session/force-close', { cookie: admin })).statusCode).toBe(200);
    expect((await enter()).statusCode).toBe(200);
  });

  it('client fantôme expiré : la maintenance démarre sans fermeture forcée', async () => {
    const login = uniq('ghost');
    await h.createClient(login, '135792');
    await h.login(login, '135792');
    h.clock.advance(TIMEOUT_CONFIG.clientInactivityMs);
    expect((await enter()).statusCode).toBe(200);
  });

  it('fermeture forcée refusée pendant la distribution', async () => {
    const slow = await createHarness({
      dispenser: new ScriptedDispenser(async () => (await new Promise((r) => setTimeout(r, 400)), { delivered: true })),
    });
    try {
      await slow.createClient('fccli', '135792', 5_000);
      const prod = await slow.product(1_000, 5);
      const adminTok = await slow.loginAdmin();
      const { token } = await slow.login('fccli', '135792');
      const running = slow.call('POST', '/orders', {
        cookie: token,
        headers: { 'idempotency-key': 'key-forceclose-01' },
        body: { items: [{ productId: prod, qty: 1 }] },
      });
      await new Promise((r) => setTimeout(r, 150));
      const fc = await slow.call('POST', '/admin/session/force-close', { cookie: adminTok });
      expect(fc.statusCode).toBe(409);
      expect(JSON.parse(fc.body).error.code).toBe('DISPENSING_IN_PROGRESS');
      expect((await running).statusCode).toBe(200);
    } finally {
      await slow.close();
    }
  });

  it("la maintenance expire après 15 min d'INACTIVITÉ ; l'activité la prolonge (glissante)", async () => {
    await enter();
    h.clock.advance(TIMEOUT_CONFIG.maintenanceInactivityMs - 1);
    expect((await create({ name: uniq('A'), priceAr: 1_000 })).statusCode).toBe(201);
    h.clock.advance(TIMEOUT_CONFIG.maintenanceInactivityMs - 1);
    expect((await create({ name: uniq('B'), priceAr: 1_000 })).statusCode).toBe(201); // 30 min au total, mais glissant
    h.clock.advance(TIMEOUT_CONFIG.maintenanceInactivityMs);
    const r = await create({ name: uniq('C'), priceAr: 1_000 });
    expect(r.statusCode).toBe(409);
    expect(json(r).error.code).toBe('MAINTENANCE_REQUIRED');
    expect((await readMachineRow(h.pool)).kind).toBe('IDLE');
  });

  it('un second administrateur ne peut ni prendre ni utiliser la maintenance', async () => {
    const second = await h.services.admin.createAdmin(uniq('boss2'), 'Autre-mot-de-passe-99');
    expect(second.ok).toBe(true);
    const login = (await h.pool.query('SELECT login FROM users WHERE id = $1', [second.ok ? second.value.id : ''])).rows[0].login as string;
    const tok2 = (await h.login(login, 'Autre-mot-de-passe-99')).token;
    await enter();
    const e2 = await h.call('POST', '/admin/maintenance/enter', { cookie: tok2 });
    expect(e2.statusCode).toBe(409);
    expect(json(e2).error.code).toBe('MACHINE_BUSY');
    const c2 = await h.call('POST', '/admin/products', { cookie: tok2, body: { name: uniq('Z'), priceAr: 1_000 } });
    expect(json(c2).error.code).toBe('MAINTENANCE_OWNED_BY_OTHER');
  });

  describe('validation', () => {
    beforeEach(async () => {
      await enter();
    });
    it.each([[1_250], [0], [-100], [100_100], [150]])('prix %p refusé (422 INVALID_PRICE)', async (priceAr) => {
      const r = await create({ name: uniq('P'), priceAr });
      expect(r.statusCode).toBe(422);
      expect(json(r).error.code).toBe('INVALID_PRICE');
    });
    it('prix texte ou champs inconnus : 400', async () => {
      expect((await create({ name: uniq('P'), priceAr: '1000' })).statusCode).toBe(400);
      expect((await create({ name: uniq('P'), priceAr: 1_000, role: 'x' })).statusCode).toBe(400);
      expect((await create({ name: '   ', priceAr: 1_000 })).statusCode).toBe(400);
    });
    it("nom déjà pris (casse ignorée) : 409 PRODUCT_NAME_TAKEN, rien d'écrit", async () => {
      const name = uniq('Doublon');
      expect((await create({ name, priceAr: 1_000, initialStock: 3 })).statusCode).toBe(201);
      const r = await create({ name: name.toUpperCase(), priceAr: 1_000, initialStock: 3 });
      expect(r.statusCode).toBe(409);
      expect(json(r).error.code).toBe('PRODUCT_NAME_TAKEN');
      const n2 = await h.pool.query('SELECT count(*) AS n FROM products WHERE lower(name) = lower($1)', [name]);
      expect(Number(n2.rows[0].n)).toBe(1);
    });
    it('PATCH : prix, nom, désactivation ; produit inconnu : 404 ; id invalide : 400', async () => {
      const p = json<{ product: { id: string } }>(await create({ name: uniq('Edit'), priceAr: 1_000, initialStock: 2 })).product;
      const up = await h.call('PATCH', `/admin/products/${p.id}`, { cookie: admin, body: { priceAr: 2_500, active: false } });
      expect(json(up).product).toMatchObject({ priceAr: 2_500, active: false });
      expect((await h.call('PATCH', `/admin/products/${p.id}`, { cookie: admin, body: { priceAr: 1_250 } })).statusCode).toBe(422);
      expect((await h.call('PATCH', `/admin/products/${p.id}`, { cookie: admin, body: {} })).statusCode).toBe(400);
      expect((await h.call('PATCH', `/admin/products/${crypto.randomUUID()}`, { cookie: admin, body: { active: true } })).statusCode).toBe(
        404,
      );
      expect((await h.call('PATCH', '/admin/products/pas-un-uuid', { cookie: admin, body: { active: true } })).statusCode).toBe(400);
    });
    it('stock : réapprovisionnement, bornes et ajustement', async () => {
      const p = json<{ product: { id: string } }>(await create({ name: uniq('Stk'), priceAr: 1_000, initialStock: 5 })).product;
      const restock = (qty: number) => h.call('POST', `/admin/products/${p.id}/restock`, { cookie: admin, body: { qty } });
      const adjust = (delta: number) => h.call('POST', `/admin/products/${p.id}/adjust`, { cookie: admin, body: { delta } });
      expect(json(await restock(10)).product.stock).toBe(15);
      expect((await restock(0)).statusCode).toBe(400);
      expect((await restock(1_001)).statusCode).toBe(400);
      const low = await adjust(-16);
      expect(low.statusCode).toBe(422);
      expect(json(low).error).toMatchObject({ code: 'STOCK_OUT_OF_RANGE', details: { resultingStock: -1 } });
      expect(json(await adjust(-15)).product.stock).toBe(0);
      expect((await adjust(0)).statusCode).toBe(400);
      expect(json(await adjust(9_999)).product.stock).toBe(9_999);
      expect(json(await restock(2)).error.code).toBe('STOCK_OUT_OF_RANGE'); // 10 001 > 10 000
      expect(await stockOf(h.pool, p.id)).toBe(9_999);
    });
  });
});

describe('comptes clients', () => {
  it('création : le client peut se connecter ; login déjà pris (casse ignorée) : 409', async () => {
    const login = uniq('newcli');
    const r = await h.call('POST', '/admin/users', { cookie: admin, body: { login, secret: '482915' } });
    expect(r.statusCode).toBe(201);
    expect((await h.login(login, '482915')).res.statusCode).toBe(200);
    const dup = await h.call('POST', '/admin/users', { cookie: admin, body: { login: login.toUpperCase(), secret: '482915' } });
    expect(dup.statusCode).toBe(409);
    expect(json(dup).error.code).toBe('LOGIN_TAKEN');
  });

  it.each([
    ['123456', 'WEAK'],
    ['111111', 'WEAK'],
    ['654321', 'WEAK'],
    ['12345', 'BAD_FORMAT'],
    ['abcdef', 'BAD_FORMAT'],
    ['1234567', 'BAD_FORMAT'],
  ])('PIN %s refusé (%s)', async (secret, reason) => {
    const r = await h.call('POST', '/admin/users', { cookie: admin, body: { login: uniq('weak'), secret } });
    expect(r.statusCode).toBe(422);
    expect(json(r).error).toMatchObject({ code: 'INVALID_SECRET', details: { reason } });
  });

  it('réinitialisation du PIN : ancien refusé, nouveau accepté, verrouillage levé, session révoquée', async () => {
    const login = uniq('reset');
    const id = await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    for (let i = 0; i < 5; i++) await h.login(login, '000999'); // verrouille
    const r = await h.call('POST', `/admin/users/${id}/reset-pin`, { cookie: admin, body: { secret: '864209' } });
    expect(r.statusCode).toBe(204);
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(401);
    await resetMachine(h.pool);
    expect((await h.login(login, '135792')).res.statusCode).toBe(401);
    expect((await h.login(login, '864209')).res.statusCode).toBe(200);
  });

  it('réinitialisation : utilisateur inconnu, ADMIN ou id invalide -> 404 / 404 / 400', async () => {
    const adminId = h.adminId;
    expect(
      (await h.call('POST', `/admin/users/${crypto.randomUUID()}/reset-pin`, { cookie: admin, body: { secret: '864209' } })).statusCode,
    ).toBe(404);
    expect((await h.call('POST', `/admin/users/${adminId}/reset-pin`, { cookie: admin, body: { secret: '864209' } })).statusCode).toBe(404);
    expect((await h.call('POST', '/admin/users/xyz/reset-pin', { cookie: admin, body: { secret: '864209' } })).statusCode).toBe(400);
  });
});

describe('audit', () => {
  it('chaque action est journalisée (qui, quoi, avant/après), sans aucun secret', async () => {
    await enter();
    const name = uniq('Aud');
    const p = json<{ product: { id: string } }>(await create({ name, priceAr: 1_000, initialStock: 2 })).product;
    await h.call('PATCH', `/admin/products/${p.id}`, { cookie: admin, body: { priceAr: 3_000 } });
    await h.call('POST', `/admin/products/${p.id}/restock`, { cookie: admin, body: { qty: 4 } });
    await h.call('POST', '/admin/users', { cookie: admin, body: { login: uniq('audcli'), secret: '482915' } });
    await h.call('POST', '/admin/maintenance/exit', { cookie: admin });

    const res = await h.call('GET', '/admin/audit?limit=20', { cookie: admin });
    const entries = json<{ entries: { id: number; actorId: string; action: string; oldValue: any; newValue: any }[] }>(res).entries;
    const actions = entries.map((e) => e.action);
    for (const a of ['MAINTENANCE_ENTER', 'PRODUCT_CREATE', 'PRODUCT_UPDATE', 'STOCK_RESTOCK', 'USER_CREATE', 'MAINTENANCE_EXIT'])
      expect(actions).toContain(a);
    expect(entries[0]?.id).toBeGreaterThan(entries[entries.length - 1]?.id ?? 0); // plus récent d'abord
    const upd = entries.find((e) => e.action === 'PRODUCT_UPDATE');
    expect(upd?.oldValue.priceAr).toBe(1_000);
    expect(upd?.newValue.priceAr).toBe(3_000);
    expect(upd?.actorId).toBe(h.adminId);
    expect(res.body).not.toMatch(/135792|482915|argon2|pin_hash|secret/i);
  });

  it('limit borné (1 à 200)', async () => {
    expect((await h.call('GET', '/admin/audit?limit=0', { cookie: admin })).statusCode).toBe(400);
    expect((await h.call('GET', '/admin/audit?limit=201', { cookie: admin })).statusCode).toBe(400);
    expect((await h.call('GET', '/admin/audit?limit=1', { cookie: admin })).statusCode).toBe(200);
  });

  it("création de l'administrateur journalisée (acteur absent, jamais de mot de passe)", async () => {
    const r = await h.pool.query(`SELECT new_value FROM audit_log WHERE action = 'ADMIN_CREATE' LIMIT 1`);
    expect(JSON.stringify(r.rows[0])).not.toMatch(/bon-mot-de-passe|argon2/);
  });
});
