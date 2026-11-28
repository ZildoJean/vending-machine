import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { AUTH_POLICY, MONEY_CONFIG } from '@vending/shared';
import { createServices } from '../container';
import { SimulatedBillAcceptor } from '../hardware/simulated-bill-acceptor';
import { FakeClock } from '../../testing/fake-clock';
import { deposit, mkProduct, mkUser, stockOf, balanceOf } from '../../testing/pg-fixtures';
import { createTestDb } from '../../testing/pg-test-db';
import type { TestDb } from '../../testing/pg-test-db';
import { CapturingLogger, ScriptedDispenser } from '../../testing/scripted-dispenser';
import { SpyHasher } from '../../testing/http-harness';
import { createDb } from './client';
import { setupAppRole } from './roles';
import { PgUnitOfWork } from './pg-unit-of-work';

let db: TestDb;
let appPool: Pool;
let role = '';
let canCreateRole = true;

beforeAll(async () => {
  db = await createTestDb();
  role = `vending_app_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await setupAppRole(db.pool, { role, password: 'app-pass-1', database: db.name });
  } catch {
    canCreateRole = false;
    return;
  }
  const url = new URL(db.adminUrl);
  url.username = role;
  url.password = 'app-pass-1';
  url.pathname = `/${db.name}`;
  appPool = new Pool({ connectionString: url.toString(), max: 5 });
});
afterAll(async () => {
  await appPool?.end();
  await db?.drop(); // db peut être absent si la création a échoué : ne pas masquer la vraie erreur
  if (canCreateRole) {
    const a = new Pool({ connectionString: db.adminUrl, max: 1 });
    await a.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await a.end();
  }
});

describe('setupAppRole', () => {
  it("refuse les noms dangereux et les mots de passe faibles (pas d'injection SQL)", async () => {
    await expect(setupAppRole(db.pool, { role: 'x"; DROP TABLE users;--', password: 'longpassword', database: db.name })).rejects.toThrow(
      /invalide/,
    );
    await expect(setupAppRole(db.pool, { role: 'ok_role', password: 'court', database: db.name })).rejects.toThrow(/8 caractères/);
    await expect(setupAppRole(db.pool, { role: 'ok_role', password: 'longpassword', database: 'Base"; --' })).rejects.toThrow(/invalide/);
  });

  it('idempotent : relançable, et le mot de passe peut être changé', async (ctx) => {
    if (!canCreateRole) ctx.skip();
    await setupAppRole(db.pool, { role, password: 'nouveau-mot-de-passe-2', database: db.name });
    const url = new URL(db.adminUrl);
    url.username = role;
    url.password = 'nouveau-mot-de-passe-2';
    url.pathname = `/${db.name}`;
    const p2 = new Pool({ connectionString: url.toString(), max: 1 });
    try {
      expect((await p2.query('SELECT 1 AS ok')).rows[0]).toEqual({ ok: 1 });
    } finally {
      await p2.end();
    }
    const old = new URL(url.toString());
    old.password = 'app-pass-1';
    const p3 = new Pool({ connectionString: old.toString(), max: 1 });
    await expect(p3.query('SELECT 1')).rejects.toMatchObject({ code: '28P01' });
    await p3.end();
    await setupAppRole(db.pool, { role, password: 'app-pass-1', database: db.name }); // remet le mot de passe attendu par la suite
  });

  it("le rôle créé n'a aucun privilège d'administration", async (ctx) => {
    if (!canCreateRole) ctx.skip();
    const r = await db.pool.query('SELECT rolsuper, rolcreatedb, rolcreaterole FROM pg_roles WHERE rolname = $1', [role]);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false });
  });
});

// Les erreurs sont reconnues par leur code SQLSTATE (42501 = droit refusé, 28P01 = mot de passe refusé) et NON par leur texte :
// le texte dépend de la langue du serveur (« droit refusé » sur un PostgreSQL en français).
describe('séparation des droits : le rôle applicatif ne peut pas tricher', () => {
  const run = (ctx: { skip: () => void }) => {
    if (!canCreateRole) ctx.skip();
  };

  it('écritures directes interdites : solde, stock, registre, schéma', async (ctx) => {
    run(ctx);
    const u = await mkUser(db.pool, 'CLIENT');
    await deposit(db.pool, u, 1_000);
    const admin = await mkUser(db.pool, 'ADMIN');
    const p = await mkProduct(db.pool, admin, 1_000, 5);
    await expect(appPool.query('UPDATE wallets SET balance_ar = 90000 WHERE user_id = $1', [u])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('UPDATE products SET stock = 999 WHERE id = $1', [p])).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('UPDATE wallet_ledger SET amount_ar = 100')).rejects.toMatchObject({ code: '42501' });
    // créer de l'argent ou du stock "à la main" par INSERT : interdit aussi
    await expect(appPool.query('INSERT INTO wallets (user_id, balance_ar) VALUES ($1, 90000)', [admin])).rejects.toMatchObject({
      code: '42501',
    });
    await expect(appPool.query(`INSERT INTO products (name, price_ar, stock) VALUES ('triche', 1000, 9999)`)).rejects.toMatchObject({
      code: '42501',
    });
    await expect(appPool.query('UPDATE products SET name = name, stock = stock + 1 WHERE id = $1', [p])).rejects.toMatchObject({
      code: '42501',
    });
    // ... alors que les colonnes autorisées restent modifiables
    await expect(appPool.query(`UPDATE products SET price_ar = 2000, active = true WHERE id = $1`, [p])).resolves.toBeDefined();
    await expect(appPool.query(`INSERT INTO products (name, price_ar) VALUES ('legit-${Math.random()}', 1000)`)).resolves.toBeDefined();
    await expect(appPool.query('DELETE FROM wallet_ledger')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('DELETE FROM audit_log')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('DELETE FROM users')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('TRUNCATE wallet_ledger')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('CREATE TABLE pirate (a int)')).rejects.toMatchObject({ code: '42501' });
    await expect(appPool.query('ALTER TABLE wallets DROP COLUMN balance_ar')).rejects.toMatchObject({ code: '42501' });
    expect(await balanceOf(db.pool, u)).toBe(1_000);
    expect(await stockOf(db.pool, p)).toBe(5);
  });

  it('mais le registre et les mouvements restent utilisables : les déclencheurs (SECURITY DEFINER) maintiennent solde et stock', async (ctx) => {
    run(ctx);
    const u = await mkUser(db.pool, 'CLIENT');
    const admin = await mkUser(db.pool, 'ADMIN');
    const p = await mkProduct(db.pool, admin, 1_000, 0);
    await appPool.query(
      `INSERT INTO wallet_ledger (user_id, type, amount_ar, insertion_id, created_at) VALUES ($1, 'DEPOSIT', 2000, $2, 1)`,
      [u, `rl-${Math.random()}`],
    );
    await appPool.query(`INSERT INTO stock_movements (product_id, delta, reason, actor_id, created_at) VALUES ($1, 7, 'RESTOCK', $2, 1)`, [
      p,
      admin,
    ]);
    expect(await balanceOf(db.pool, u)).toBe(2_000);
    expect(await stockOf(db.pool, p)).toBe(7);
    await appPool.query('DELETE FROM sessions'); // seule suppression autorisée
  });

  it("l'application complète fonctionne avec ce rôle restreint : connexion, dépôt, commande, remboursement", async (ctx) => {
    run(ctx);
    const clock = new FakeClock(1_000_000);
    const services = createServices({
      uow: new PgUnitOfWork(createDb(appPool)),
      clock,
      dispenser: new ScriptedDispenser((_r, i) => (i === 1 ? { delivered: false, reason: 'JAM' } : { delivered: true })),
      acceptor: new SimulatedBillAcceptor(MONEY_CONFIG.acceptedBills),
      hasher: new SpyHasher(),
      logger: new CapturingLogger(),
      ping: async () => undefined,
      policy: AUTH_POLICY,
    });
    const adm = await services.admin.createAdmin(`root${Math.random().toString(36).slice(2, 7)}`, 'Un-bon-mot-de-passe-42');
    expect(adm.ok).toBe(true);
    const login = `cli${Math.random().toString(36).slice(2, 7)}`;
    const created = await services.admin.createClient(adm.ok ? adm.value.id : '', login, '135792');
    expect(created.ok).toBe(true);
    const lg = await services.auth.login(login, '135792');
    expect(lg.ok).toBe(true);
    const userId = created.ok ? created.value.id : '';
    expect((await services.deposit.deposit(userId, 5_000, crypto.randomUUID())).ok).toBe(true);
    const prod = await mkProduct(db.pool, adm.ok ? adm.value.id : '', 1_500, 5);
    const r = await services.checkout.checkout(userId, [{ productId: prod, qty: 3 }], 'idem-role-test-1');
    expect(r.ok && r.value).toMatchObject({ status: 'PARTIALLY_DISPENSED', refundedAr: 3_000, balanceAr: 3_500 });
    expect(await stockOf(db.pool, prod)).toBe(4);
  });
});
