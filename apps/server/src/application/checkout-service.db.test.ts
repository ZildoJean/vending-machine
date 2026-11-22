import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';
import { DISPENSE_CONFIG, MONEY_CONFIG, TIMEOUT_CONFIG } from '@vending/shared';
import type { RawCartLine } from '../domain/cart';
import { validateDeposit } from '../domain/money';
import { createDb } from '../infra/db/client';
import { PgUnitOfWork } from '../infra/db/pg-unit-of-work';
import { SimulatedDispenser } from '../infra/hardware/simulated-dispenser';
import { FakeClock } from '../testing/fake-clock';
import {
  balanceOf, deposit, ledgerTypes, mkProduct, mkUser, readMachineRow, resetMachine, stockOf,
} from '../testing/pg-fixtures';
import { createTestDb } from '../testing/pg-test-db';
import type { TestDb } from '../testing/pg-test-db';
import { CapturingLogger, ScriptedDispenser, failAt, sleep, waitFor } from '../testing/scripted-dispenser';
import { OrderNotDispensableError } from './errors';
import { CheckoutService } from './checkout-service';
import { MachineService } from './machine-service';
import type { Dispenser, TxContext, UnitOfWork } from './ports';

const T0 = 1_000_000;
let db: TestDb;
let pool: Pool;
let uow: PgUnitOfWork;
let clock: FakeClock;
let machine: MachineService;
let logger: CapturingLogger;
let admin: string;

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  uow = new PgUnitOfWork(createDb(pool));
  admin = await mkUser(pool, 'ADMIN');
});
afterAll(async () => {
  await db.drop();
});
beforeEach(async () => {
  await resetMachine(pool);
  clock = new FakeClock(T0);
  logger = new CapturingLogger();
  machine = new MachineService(uow, clock, TIMEOUT_CONFIG);
});

let k = 0;
const key = (): string => `idem-${process.pid}-${++k}-abcdef`;
const mkService = (dispenser: Dispenser, unitTimeoutMs = 300, u: UnitOfWork = uow): CheckoutService =>
  new CheckoutService({
    uow: u, clock, dispenser, logger,
    money: MONEY_CONFIG, timeouts: TIMEOUT_CONFIG, dispense: { unitTimeoutMs },
  });
const line = (productId: unknown, qty: unknown): RawCartLine => ({ productId, qty });

/** Client avec solde, session ouverte et produits (prix, stock). */
async function setup(balance: number, specs: { price: number; stock: number }[]) {
  const user = await mkUser(pool, 'CLIENT');
  if (balance > 0) await deposit(pool, user, balance);
  const ids = await Promise.all(specs.map((s) => mkProduct(pool, admin, s.price, s.stock)));
  const login = () => machine.apply({ type: 'LOGIN_CLIENT', userId: user });
  await login();
  return { user, ids, login };
}
const p = (ids: string[], i: number): string => ids[i] as string;
const count = async (sql: string, params: unknown[]): Promise<number> => Number((await pool.query(sql, params)).rows[0].n);
const ordersOf = (user: string) => count('SELECT count(*) AS n FROM orders WHERE user_id = $1', [user]);
const machineKind = async () => (await readMachineRow(pool)).kind;

describe('cas nominal', () => {
  it('2 colas à 1 500 avec 5 000 : distribuées, solde 2 000, stock -2, session fermée', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }]);
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 2)], key());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ status: 'DISPENSED', totalAr: 3_000, refundedAr: 0, balanceAr: 2_000, replayed: false });
    expect(r.value.items).toEqual([{ productId: p(ids, 0), qty: 2, deliveredQty: 2 }]);
    expect(await balanceOf(pool, user)).toBe(2_000);
    expect(await stockOf(pool, p(ids, 0))).toBe(3);
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE']);
    expect(await machineKind()).toBe('IDLE');
  });

  it('plusieurs produits : total, stock et livraison par ligne', async () => {
    const { user, ids } = await setup(10_000, [{ price: 1_500, stock: 5 }, { price: 500, stock: 5 }]);
    const d = new ScriptedDispenser();
    const r = await mkService(d).checkout(user, [line(p(ids, 0), 1), line(p(ids, 1), 3)], key());
    expect(r.ok && r.value).toMatchObject({ status: 'DISPENSED', totalAr: 3_000, balanceAr: 7_000 });
    expect(d.calls).toHaveLength(4);
    expect(await stockOf(pool, p(ids, 1))).toBe(2);
  });

  it('un client sans produit livré avant lui voit le stock à jour : dernière canette', async () => {
    const a = await setup(5_000, [{ price: 1_000, stock: 1 }]);
    expect((await mkService(new ScriptedDispenser()).checkout(a.user, [line(p(a.ids, 0), 1)], key())).ok).toBe(true);
    const b = await mkUser(pool);
    await deposit(pool, b, 5_000);
    await machine.apply({ type: 'LOGIN_CLIENT', userId: b });
    const r = await mkService(new ScriptedDispenser()).checkout(b, [line(p(a.ids, 0), 1)], key());
    expect(r).toEqual({ ok: false, error: { kind: 'CART', failure: { code: 'INSUFFICIENT_STOCK', lineIndex: 0 } } });
  });
});

describe('refus : rien n\'est écrit', () => {
  const snapshot = async (user: string, ids: string[]) => ({
    balance: await balanceOf(pool, user),
    ledger: await ledgerTypes(pool, user),
    stocks: await Promise.all(ids.map((i) => stockOf(pool, i))),
    orders: await ordersOf(user),
  });

  it('solde insuffisant : montant manquant, session conservée, activité enregistrée', async () => {
    const { user, ids } = await setup(1_000, [{ price: 1_500, stock: 5 }]);
    const before = await snapshot(user, ids);
    clock.advance(30_000);
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 1)], key());
    expect(r).toEqual({ ok: false, error: { kind: 'CART', failure: { code: 'INSUFFICIENT_FUNDS', totalAr: 1_500, missingAr: 500 } } });
    expect(await snapshot(user, ids)).toEqual(before);
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'SELECTING', last_activity_at: T0 + 30_000 });
  });

  it.each<[string, (ids: string[]) => RawCartLine[], string]>([
    ['panier vide', () => [], 'EMPTY_CART'],
    ['quantité nulle', (ids) => [line(p(ids, 0), 0)], 'INVALID_QTY'],
    ['quantité texte', (ids) => [line(p(ids, 0), '2')], 'INVALID_QTY'],
    ['doublon de ligne', (ids) => [line(p(ids, 0), 1), line(p(ids, 0), 1)], 'DUPLICATE_LINE'],
    ['identifiant inconnu', () => [line('00000000-0000-4000-8000-000000000000', 1)], 'UNKNOWN_PRODUCT'],
    ['identifiant non-uuid', () => [line('pas-un-uuid', 1)], 'UNKNOWN_PRODUCT'],
    ['tentative d\'injection SQL', () => [line(`x'; DROP TABLE products;--`, 1)], 'UNKNOWN_PRODUCT'],
    ['identifiant non texte', () => [line(42, 1)], 'UNKNOWN_PRODUCT'],
    ['stock dépassé', (ids) => [line(p(ids, 0), 6)], 'INSUFFICIENT_STOCK'],
  ])('%s -> %s', async (_n, cart, code) => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }]);
    const before = await snapshot(user, ids);
    const r = await mkService(new ScriptedDispenser()).checkout(user, cart(ids), key());
    expect(!r.ok && r.error).toMatchObject({ kind: 'CART', failure: { code } });
    expect(await snapshot(user, ids)).toEqual(before);
    expect(await count('SELECT count(*) AS n FROM products', [])).toBeGreaterThan(0); // la table existe toujours
  });

  it('panier plus cher que le plafond : CART_EXCEEDS_CAP, pas INSUFFICIENT_FUNDS', async () => {
    const { user, ids } = await setup(1_000, [{ price: 12_000, stock: 20 }]);
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 10)], key());
    expect(!r.ok && r.error).toEqual({ kind: 'CART', failure: { code: 'CART_EXCEEDS_CAP', totalAr: 120_000 } });
  });

  it.each([undefined, null, 42, '', 'court', 'x'.repeat(101)])('clé d\'idempotence invalide %p', async (bad) => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 1)], bad);
    expect(r).toEqual({ ok: false, error: { kind: 'REQUEST', error: 'INVALID_IDEMPOTENCY_KEY' } });
    expect(await ordersOf(user)).toBe(0);
  });

  it('aucune session : NO_SESSION', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    await machine.apply({ type: 'LOGOUT_CLIENT', userId: user });
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 1)], key());
    expect(r).toEqual({ ok: false, error: { kind: 'MACHINE', error: 'NO_SESSION' } });
    expect(await ordersOf(user)).toBe(0);
  });

  it('session d\'un autre client : NOT_OWNER', async () => {
    const { ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const intruder = await mkUser(pool);
    await deposit(pool, intruder, 5_000);
    const r = await mkService(new ScriptedDispenser()).checkout(intruder, [line(p(ids, 0), 1)], key());
    expect(r).toEqual({ ok: false, error: { kind: 'MACHINE', error: 'NOT_OWNER' } });
    expect(await ordersOf(intruder)).toBe(0);
  });

  it('machine en maintenance : NO_SESSION', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    await machine.apply({ type: 'LOGOUT_CLIENT', userId: user });
    await machine.apply({ type: 'ENTER_MAINTENANCE', adminId: admin });
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 1)], key());
    expect(!r.ok && r.error).toEqual({ kind: 'MACHINE', error: 'NO_SESSION' });
  });

  it('session expirée : SESSION_EXPIRED, retour à IDLE écrit, aucun débit', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    clock.advance(TIMEOUT_CONFIG.clientInactivityMs);
    const before = await snapshot(user, ids);
    const r = await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 1)], key());
    expect(r).toEqual({ ok: false, error: { kind: 'MACHINE', error: 'SESSION_EXPIRED' } });
    expect(await machineKind()).toBe('IDLE');
    expect(await snapshot(user, ids)).toEqual(before);
  });
});

describe('idempotence', () => {
  it('même clé rejouée APRÈS la fin (session fermée) : même résultat, aucun second débit', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }]);
    const svc = mkService(new ScriptedDispenser());
    const cart = [line(p(ids, 0), 2)];
    const k1 = key();
    const first = await svc.checkout(user, cart, k1);
    const second = await svc.checkout(user, cart, k1);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.value).toMatchObject({ orderId: first.value.orderId, status: 'DISPENSED', balanceAr: 2_000, replayed: true });
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE']);
    expect(await stockOf(pool, p(ids, 0))).toBe(3);
    expect(await ordersOf(user)).toBe(1);
  });

  it('même clé, panier différent : IDEMPOTENCY_KEY_REUSED, rien de nouveau', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const svc = mkService(new ScriptedDispenser());
    const k1 = key();
    await svc.checkout(user, [line(p(ids, 0), 1)], k1);
    const r = await svc.checkout(user, [line(p(ids, 0), 2)], k1);
    expect(r).toEqual({ ok: false, error: { kind: 'REQUEST', error: 'IDEMPOTENCY_KEY_REUSED' } });
    expect(await ordersOf(user)).toBe(1);
  });

  it('même clé chez deux clients : deux commandes indépendantes', async () => {
    const a = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const svc = mkService(new ScriptedDispenser());
    const shared = key();
    expect((await svc.checkout(a.user, [line(p(a.ids, 0), 1)], shared)).ok).toBe(true);
    const b = await mkUser(pool);
    await deposit(pool, b, 5_000);
    await machine.apply({ type: 'LOGIN_CLIENT', userId: b });
    const r = await svc.checkout(b, [line(p(a.ids, 0), 1)], shared);
    expect(r.ok && r.value.replayed).toBe(false);
  });

  it('deux requêtes identiques SIMULTANÉES : une seule commande, un seul débit', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }]);
    const svc = mkService(new ScriptedDispenser(async () => (await sleep(150), { delivered: true })));
    const cart = [line(p(ids, 0), 2)];
    const k1 = key();
    const [r1, r2] = await Promise.all([svc.checkout(user, cart, k1), svc.checkout(user, cart, k1)]);
    expect(r1.ok && r2.ok).toBe(true);
    if (!r1.ok || !r2.ok) return;
    expect([r1.value.replayed, r2.value.replayed].sort()).toEqual([false, true]);
    expect(r1.value.orderId).toBe(r2.value.orderId);
    expect(await ordersOf(user)).toBe(1);
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE']);
    expect(await balanceOf(pool, user)).toBe(2_000);
  });
});

describe('pannes de distribution : remboursement exact des unités non livrées', () => {
  it('3 colas, panne à la 2e : 1 livrée, 2 remboursées, stock restauré, arrêt immédiat', async () => {
    const { user, ids } = await setup(10_000, [{ price: 1_500, stock: 5 }]);
    const d = new ScriptedDispenser(failAt(1));
    const r = await mkService(d).checkout(user, [line(p(ids, 0), 3)], key());
    expect(r.ok && r.value).toMatchObject({ status: 'PARTIALLY_DISPENSED', totalAr: 4_500, refundedAr: 3_000, balanceAr: 8_500 });
    expect(r.ok && r.value.items[0]?.deliveredQty).toBe(1);
    expect(d.calls).toHaveLength(2); // la 3e unité n'a jamais été tentée
    expect(await stockOf(pool, p(ids, 0))).toBe(4);
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE', 'REFUND']);
    expect(await machineKind()).toBe('IDLE');
    expect(logger.warns).toContain('Unité non délivrée : arrêt de la distribution');
  });

  it('panne dès la 1re unité : FAILED, remboursement total, solde et stock d\'origine', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }, { price: 500, stock: 5 }]);
    const r = await mkService(new ScriptedDispenser(failAt(0))).checkout(user, [line(p(ids, 0), 1), line(p(ids, 1), 2)], key());
    expect(r.ok && r.value).toMatchObject({ status: 'FAILED', totalAr: 2_500, refundedAr: 2_500, balanceAr: 5_000 });
    expect(await stockOf(pool, p(ids, 0))).toBe(5);
    expect(await stockOf(pool, p(ids, 1))).toBe(5);
  });

  it('plusieurs produits, panne en cours : remboursement = prix figés des unités non livrées', async () => {
    const { user, ids } = await setup(10_000, [{ price: 1_500, stock: 5 }, { price: 500, stock: 5 }]);
    const d = new ScriptedDispenser(failAt(1));
    const r = await mkService(d).checkout(user, [line(p(ids, 0), 1), line(p(ids, 1), 2)], key());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const price = new Map([[p(ids, 0), 1_500], [p(ids, 1), 500]]);
    const expectedRefund = r.value.items.reduce((s, i) => s + (i.qty - i.deliveredQty) * (price.get(i.productId) ?? 0), 0);
    expect(r.value.status).toBe('PARTIALLY_DISPENSED');
    expect(r.value.refundedAr).toBe(expectedRefund);
    expect(r.value.balanceAr).toBe(10_000 - 2_500 + expectedRefund); // total = 1 500 + 2 x 500
  });

  it('le matériel lève une exception : traité comme une panne, la commande est clôturée', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const d = new ScriptedDispenser(() => {
      throw new Error('moteur grillé');
    });
    const r = await mkService(d).checkout(user, [line(p(ids, 0), 2)], key());
    expect(r.ok && r.value).toMatchObject({ status: 'FAILED', refundedAr: 2_000, balanceAr: 5_000 });
    expect(await machineKind()).toBe('IDLE');
  });

  it('blocage du matériel : TIMEOUT, clôture, puis livraison tardive journalisée sans effet', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    let release: () => void = () => undefined;
    const d = new ScriptedDispenser(() => new Promise((res) => (release = () => res({ delivered: true }))));
    const t0 = Date.now();
    const r = await mkService(d, 80).checkout(user, [line(p(ids, 0), 1)], key());
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(r.ok && r.value).toMatchObject({ status: 'FAILED', refundedAr: 1_000 });
    expect(await machineKind()).toBe('IDLE');
    release();
    await sleep(30);
    expect(logger.errors).toContain('Livraison tardive après délai : unité déjà considérée non délivrée');
    expect(await balanceOf(pool, user)).toBe(5_000); // rien ne change après coup
    expect(await stockOf(pool, p(ids, 0))).toBe(5);
  });
});

describe('pendant la distribution', () => {
  it('aucun verrou tenu pendant l\'appel matériel : la machine répond, refuse proprement, puis la commande se termine', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    let release: () => void = () => undefined;
    const d = new ScriptedDispenser(() => new Promise((res) => (release = () => res({ delivered: true }))));
    const running = mkService(d, 5_000).checkout(user, [line(p(ids, 0), 1)], key());
    await waitFor(() => d.calls.length === 1);

    const other = await mkUser(pool);
    const t0 = Date.now();
    expect(await machine.apply({ type: 'FORCE_CLOSE' })).toMatchObject({ ok: false, error: 'DISPENSING_IN_PROGRESS' });
    expect(await machine.apply({ type: 'LOGIN_CLIENT', userId: other })).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
    expect(await machine.apply({ type: 'ENTER_MAINTENANCE', adminId: admin })).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
    expect(await machine.status()).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'DISPENSING' });
    expect(Date.now() - t0).toBeLessThan(1_500);

    release();
    expect((await running).ok).toBe(true);
    expect(await machineKind()).toBe('IDLE');
  });
});

/** UoW qui échoue APRÈS l'appel réel (simule un plantage en fin de transaction). */
class FaultyUow implements UnitOfWork {
  constructor(private readonly inner: UnitOfWork, private failOn: 'place' | 'finish' | null) {}
  disarm(): void {
    this.failOn = null;
  }
  run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    return this.inner.run((tx) =>
      work({
        ...tx,
        orders: {
          findByKey: (u, kk) => tx.orders.findByKey(u, kk),
          findById: (id, o) => tx.orders.findById(id, o),
          findPendingId: () => tx.orders.findPendingId(),
          markUnitDelivered: (id, pid) => tx.orders.markUnitDelivered(id, pid),
          place: async (o) => {
            const id = await tx.orders.place(o);
            if (this.failOn === 'place') throw new Error('plantage après place');
            return id;
          },
          finish: async (id, f) => {
            await tx.orders.finish(id, f);
            if (this.failOn === 'finish') throw new Error('plantage après finish');
          },
        },
      }),
    );
  }
}

describe('atomicité', () => {
  it('plantage en fin de placement : ni commande, ni débit, ni stock touché, machine inchangée', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_500, stock: 5 }]);
    const faulty = new FaultyUow(uow, 'place');
    await expect(mkService(new ScriptedDispenser(), 300, faulty).checkout(user, [line(p(ids, 0), 2)], key())).rejects.toThrow('plantage après place');
    expect(await ordersOf(user)).toBe(0);
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT']);
    expect(await balanceOf(pool, user)).toBe(5_000);
    expect(await stockOf(pool, p(ids, 0))).toBe(5);
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'SELECTING' });
    expect((await mkService(new ScriptedDispenser()).checkout(user, [line(p(ids, 0), 2)], key())).ok).toBe(true); // et la machine reste utilisable
  });

  it('plantage en fin de clôture : rien de la clôture n\'est écrit, puis la reprise la termine UNE fois', async () => {
    const { user, ids } = await setup(10_000, [{ price: 1_500, stock: 5 }]);
    const faulty = new FaultyUow(uow, 'finish');
    await expect(mkService(new ScriptedDispenser(failAt(1)), 300, faulty).checkout(user, [line(p(ids, 0), 3)], key())).rejects.toThrow('plantage après finish');
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE']); // pas de REFUND écrit
    expect((await pool.query(`SELECT status FROM orders WHERE user_id = $1`, [user])).rows[0]).toEqual({ status: 'PENDING_DISPENSE' });
    expect(await machineKind()).toBe('CLIENT_ACTIVE');

    const report = await mkService(new ScriptedDispenser()).recoverPending();
    expect(report.recovered).toMatchObject({ status: 'PARTIALLY_DISPENSED', refundedAr: 3_000 });
    expect(await ledgerTypes(pool, user)).toEqual(['DEPOSIT', 'PURCHASE', 'REFUND']);
    expect(await balanceOf(pool, user)).toBe(8_500);
    expect(await stockOf(pool, p(ids, 0))).toBe(4);
    expect(await machineKind()).toBe('IDLE');
    expect((await mkService(new ScriptedDispenser()).recoverPending())).toEqual({ recovered: null, machineReset: false });
  });
});

describe('reprise au démarrage', () => {
  /** Simule un crash : la distribution reste suspendue après `delivered` unités ; le "processus" est abandonné. */
  async function crashDuringDispense(user: string, ids: string[], qty: number, delivered: number) {
    const hang = new Promise<never>(() => undefined);
    let release: () => void = () => undefined;
    const zombie = new ScriptedDispenser((_r, i) =>
      i < delivered ? { delivered: true } : new Promise((res) => (release = () => res({ delivered: true }))),
    );
    void hang;
    const running = mkService(zombie, 60_000).checkout(user, [line(p(ids, 0), qty)], key());
    const settled = running.then(() => 'done' as const, (e: unknown) => e);
    await waitFor(() => zombie.calls.length === delivered + 1);
    return { release, settled };
  }

  it.each([
    [0, 'FAILED', 4_500],
    [1, 'PARTIALLY_DISPENSED', 3_000],
    [2, 'PARTIALLY_DISPENSED', 1_500],
  ])('crash après %i unité(s) livrée(s) sur 3 -> %s, remboursement %i', async (delivered, status, refund) => {
    const { user, ids } = await setup(10_000, [{ price: 1_500, stock: 5 }]);
    const { release, settled } = await crashDuringDispense(user, ids, 3, delivered);
    expect(await machineKind()).toBe('CLIENT_ACTIVE');

    const restarted = mkService(new ScriptedDispenser());
    const report = await restarted.recoverPending();
    expect(report.recovered).toMatchObject({ status, refundedAr: refund, balanceAr: 10_000 - 4_500 + refund });
    expect(await stockOf(pool, p(ids, 0))).toBe(5 - delivered);
    expect(await machineKind()).toBe('IDLE');

    // l'ancien processus "revient à la vie" : il ne doit RIEN pouvoir écrire
    release();
    const outcome = await settled;
    expect(outcome).toBeInstanceOf(OrderNotDispensableError);
    expect(await balanceOf(pool, user)).toBe(10_000 - 4_500 + refund);
    expect(await ledgerTypes(pool, user)).toEqual(refund > 0 ? ['DEPOSIT', 'PURCHASE', 'REFUND'] : ['DEPOSIT', 'PURCHASE']);
  });

  it('machine en DISPENSING sans commande en cours : remise à IDLE et erreur journalisée', async () => {
    const user = await mkUser(pool);
    await pool.query(
      `UPDATE machine_state SET kind='CLIENT_ACTIVE', user_id=$1, started_at=1, last_activity_at=1, phase='DISPENSING' WHERE id = 1`, [user],
    );
    const report = await mkService(new ScriptedDispenser()).recoverPending();
    expect(report).toEqual({ recovered: null, machineReset: true });
    expect(await machineKind()).toBe('IDLE');
    expect(logger.errors).toContain('Machine en DISPENSING sans commande en cours : remise à IDLE');
  });

  it('rien à reprendre : sans effet', async () => {
    expect(await mkService(new ScriptedDispenser()).recoverPending()).toEqual({ recovered: null, machineReset: false });
  });
});

describe('simulateur de matériel (infra)', () => {
  it('SimulatedDispenser : panne programmée et délai', async () => {
    const { user, ids } = await setup(5_000, [{ price: 1_000, stock: 5 }]);
    const sim = new SimulatedDispenser({ delayMs: 20, failure: (_r, i) => (i === 1 ? 'JAM' : null) });
    const r = await mkService(sim).checkout(user, [line(p(ids, 0), 3)], key());
    expect(r.ok && r.value).toMatchObject({ status: 'PARTIALLY_DISPENSED', refundedAr: 2_000 });
  });
});

describe('PROPRIÉTÉ : conservation de bout en bout contre PostgreSQL', () => {
  const seen = { placed: 0, partialOrFailed: 0, dispensed: 0 };
  it('sur des suites aléatoires de dépôts et de commandes avec pannes, tous les invariants tiennent', async () => {
    const opArb = fc.oneof(
      fc.record({ kind: fc.constant('deposit' as const), who: fc.integer({ min: 0, max: 1 }), bill: fc.constantFrom(...MONEY_CONFIG.acceptedBills) }),
      fc.record({
        kind: fc.constant('checkout' as const),
        who: fc.integer({ min: 0, max: 1 }),
        lines: fc.array(fc.record({ p: fc.integer({ min: 0, max: 3 }), qty: fc.integer({ min: -1, max: 4 }) }), { maxLength: 3 }),
        failAt: fc.integer({ min: -1, max: 5 }),
      }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 6 }), async (ops) => {
        await resetMachine(pool);
        const users = [await mkUser(pool), await mkUser(pool)];
        // les deux clients ont de l'argent d'entrée : la plupart des commandes aboutissent
        for (const u of users) await deposit(pool, u, 20_000);
        const specs = [{ price: 1_500, stock: 5 }, { price: 500, stock: 5 }, { price: 12_000, stock: 3 }];
        const pids = await Promise.all(specs.map((s) => mkProduct(pool, admin, s.price, s.stock)));
        let n = 0;

        for (const op of ops) {
          const user = users[op.who] as string;
          if (op.kind === 'deposit') {
            const r = validateDeposit(await balanceOf(pool, user), op.bill, MONEY_CONFIG);
            if (r.ok) await deposit(pool, user, op.bill);
          } else {
            await machine.apply({ type: 'FORCE_CLOSE' });
            await machine.apply({ type: 'LOGIN_CLIENT', userId: user });
            const cart = op.lines.map((l) => line(pids[l.p] ?? 'inconnu', l.qty));
            const res = await mkService(new ScriptedDispenser(failAt(op.failAt))).checkout(user, cart, `prop-${process.pid}-${++n}-${Math.random().toString(36).slice(2)}`);
            if (res.ok) {
              seen.placed++;
              if (res.value.status === 'DISPENSED') seen.dispensed++;
              else seen.partialOrFailed++;
            }
          }

          // --- invariants (calculés en SQL, indépendamment du code testé)
          const bad = await pool.query(
            `SELECT w.user_id FROM wallets w WHERE w.user_id = ANY($1)
             AND w.balance_ar <> COALESCE((SELECT sum(amount_ar) FROM wallet_ledger l WHERE l.user_id = w.user_id), 0)`, [users]);
          expect(bad.rows).toEqual([]); // solde == somme du registre

          const stock = await pool.query(
            `SELECT p.id FROM products p WHERE p.id = ANY($1)
             AND p.stock + COALESCE((SELECT sum(oi.delivered_qty) FROM order_items oi WHERE oi.product_id = p.id), 0)
               <> CASE p.id ${pids.map((id, i) => `WHEN '${id}' THEN ${(specs[i] as { stock: number }).stock}`).join(' ')} END`, [pids]);
          expect(stock.rows).toEqual([]); // stock + livré == stock initial (rien de créé ni perdu)

          const money = (await pool.query(
            `SELECT
               (SELECT COALESCE(sum(amount_ar),0) FROM wallet_ledger WHERE user_id = ANY($1) AND type = 'DEPOSIT') AS deposited,
               (SELECT COALESCE(sum(balance_ar),0) FROM wallets WHERE user_id = ANY($1)) AS balances,
               (SELECT COALESCE(sum(total_ar - refunded_ar),0) FROM orders WHERE user_id = ANY($1)) AS kept,
               (SELECT COALESCE(sum(oi.delivered_qty * oi.unit_price_ar),0) FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = ANY($1)) AS value`,
            [users])).rows[0];
          expect(Number(money.deposited)).toBe(Number(money.balances) + Number(money.kept)); // conservation de l'argent
          expect(Number(money.kept)).toBe(Number(money.value)); // argent gardé == valeur livrée

          const pending = await pool.query(`SELECT 1 FROM orders WHERE status = 'PENDING_DISPENSE'`);
          expect(pending.rowCount).toBe(0);
          expect(await machineKind()).not.toBe('MAINTENANCE');
          expect((await readMachineRow(pool)).phase).not.toBe('DISPENSING');
        }
      }),
      { numRuns: 25 },
    );
    // la propriété ne doit pas passer à vide : des commandes réussies ET des pannes ont bien eu lieu
    expect(seen.dispensed).toBeGreaterThan(0);
    expect(seen.partialOrFailed).toBeGreaterThan(0);
  });
});
