import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { MONEY_CONFIG } from '@vending/shared';
import { createTestDb } from '../../testing/pg-test-db';
import type { TestDb } from '../../testing/pg-test-db';

let db: TestDb;
let pool: Pool;
beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop(); // db peut être absent si la création a échoué : ne pas masquer la vraie erreur
});

let seq = 0;
const next = () => ++seq;

async function one<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T> {
  const r = await pool.query(sql, params);
  return r.rows[0] as T;
}
const mkUser = async (role: 'CLIENT' | 'ADMIN' = 'CLIENT'): Promise<string> =>
  (
    await one<{ id: string }>('INSERT INTO users (login, role, pin_hash, created_at) VALUES ($1, $2, $3, 1) RETURNING id', [
      `user_${next()}`,
      role,
      'hash',
    ])
  ).id;
const balanceOf = async (userId: string): Promise<number> =>
  (await one<{ balance_ar: number }>('SELECT balance_ar FROM wallets WHERE user_id = $1', [userId])).balance_ar;
const ledgerCount = async (userId: string): Promise<number> =>
  Number((await one<{ n: string }>('SELECT count(*) AS n FROM wallet_ledger WHERE user_id = $1', [userId])).n);
const deposit = (userId: string, amount: number, insertionId = `ins-${next()}`) =>
  pool.query(`INSERT INTO wallet_ledger (user_id, type, amount_ar, insertion_id, created_at) VALUES ($1, 'DEPOSIT', $2, $3, 1)`, [
    userId,
    amount,
    insertionId,
  ]);
const ledger = (userId: string, type: 'PURCHASE' | 'REFUND', amount: number, orderId: string) =>
  pool.query(`INSERT INTO wallet_ledger (user_id, type, amount_ar, order_id, created_at) VALUES ($1, $2, $3, $4, 1)`, [
    userId,
    type,
    amount,
    orderId,
  ]);
const mkOrder = async (
  userId: string,
  total: number,
  o: { status?: string; refunded?: number; finished?: number | null } = {},
): Promise<string> => {
  const status = o.status ?? 'DISPENSED';
  const finished = o.finished === undefined ? (status === 'PENDING_DISPENSE' ? null : 2) : o.finished;
  return (
    await one<{ id: string }>(
      `INSERT INTO orders (user_id, status, total_ar, refunded_ar, idempotency_key, created_at, finished_at)
     VALUES ($1, $2, $3, $4, $5, 1, $6) RETURNING id`,
      [userId, status, total, o.refunded ?? 0, `idem-key-${next()}`, finished],
    )
  ).id;
};
const mkProduct = async (price = 1_500): Promise<string> =>
  (await one<{ id: string }>('INSERT INTO products (name, price_ar) VALUES ($1, $2) RETURNING id', [`produit ${next()}`, price])).id;
const stockOf = async (productId: string): Promise<number> =>
  (await one<{ stock: number }>('SELECT stock FROM products WHERE id = $1', [productId])).stock;
const movement = (productId: string, delta: number, reason: string, orderId: string | null, actorId: string | null) =>
  pool.query('INSERT INTO stock_movements (product_id, delta, reason, order_id, actor_id, created_at) VALUES ($1, $2, $3, $4, $5, 1)', [
    productId,
    delta,
    reason,
    orderId,
    actorId,
  ]);
const restock = (productId: string, adminId: string, qty: number) => movement(productId, qty, 'RESTOCK', null, adminId);

describe('migrations', () => {
  it('le singleton machine_state est amorcé en IDLE', async () => {
    const r = await pool.query('SELECT id, kind FROM machine_state');
    expect(r.rows).toEqual([{ id: 1, kind: 'IDLE' }]);
  });
});

describe('products (prix = multiple de 100, 0 < prix <= 100 000)', () => {
  it.each([100, 1_500, 100_000])('accepte le prix %i', async (price) => {
    await expect(pool.query('INSERT INTO products (name, price_ar) VALUES ($1, $2)', [`ok ${next()}`, price])).resolves.toBeDefined();
  });
  it.each([0, -100, 1_250, 99, 100_100])('rejette le prix %i', async (price) => {
    await expect(pool.query('INSERT INTO products (name, price_ar) VALUES ($1, $2)', [`ko ${next()}`, price])).rejects.toThrow(
      /products_price_ck/,
    );
  });
  it('nom unique sans tenir compte de la casse', async () => {
    await pool.query(`INSERT INTO products (name, price_ar) VALUES ('Coca Zéro', 1500)`);
    await expect(pool.query(`INSERT INTO products (name, price_ar) VALUES ('COCA zéro', 1500)`)).rejects.toThrow(/products_name_lower_uq/);
  });
  it('nom vide ou trop long rejeté', async () => {
    await expect(pool.query(`INSERT INTO products (name, price_ar) VALUES ('', 1500)`)).rejects.toThrow(/products_name_len_ck/);
    await expect(pool.query(`INSERT INTO products (name, price_ar) VALUES ($1, 1500)`, ['x'.repeat(51)])).rejects.toThrow(
      /products_name_len_ck/,
    );
  });
});

describe('cohérence base <-> MONEY_CONFIG (échoue si la config change sans nouvelle migration)', () => {
  const { step, walletCap } = MONEY_CONFIG;
  it('prix : plafond et pas', async () => {
    const ins = (price: number) => pool.query('INSERT INTO products (name, price_ar) VALUES ($1, $2)', [`cfg ${next()}`, price]);
    await expect(ins(walletCap)).resolves.toBeDefined();
    await expect(ins(walletCap + step)).rejects.toThrow(/products_price_ck/);
    await expect(ins(step)).resolves.toBeDefined();
    await expect(ins(step + 1)).rejects.toThrow(/products_price_ck/);
  });
  it('wallet : plafond et pas', async () => {
    const u = await mkUser();
    await deposit(u, walletCap);
    await expect(deposit(u, step)).rejects.toThrow(/wallets_balance_ck/);
    const v = await mkUser();
    await expect(deposit(v, step + 1)).rejects.toThrow(/wallet_ledger_step_ck/);
  });
});

describe('wallet et registre', () => {
  it("un CLIENT reçoit un wallet à 0, un ADMIN n'en a pas", async () => {
    const c = await mkUser('CLIENT');
    const a = await mkUser('ADMIN');
    expect(await balanceOf(c)).toBe(0);
    expect((await pool.query('SELECT 1 FROM wallets WHERE user_id = $1', [a])).rowCount).toBe(0);
  });

  it('un dépôt crédite le wallet (trigger) et le solde = somme du registre', async () => {
    const u = await mkUser();
    await deposit(u, 5_000);
    await deposit(u, 200);
    expect(await balanceOf(u)).toBe(5_200);
    const sum = await one<{ s: string }>('SELECT sum(amount_ar) AS s FROM wallet_ledger WHERE user_id = $1', [u]);
    expect(Number(sum.s)).toBe(5_200);
  });

  it('même insertion_id deux fois : un seul crédit', async () => {
    const u = await mkUser();
    await deposit(u, 1_000, 'ins-dup');
    await expect(deposit(u, 1_000, 'ins-dup')).rejects.toThrow(/wallet_ledger_insertion_uq/);
    expect(await balanceOf(u)).toBe(1_000);
    expect(await ledgerCount(u)).toBe(1);
  });

  it('deux insertion_id différents, même coupure : deux crédits', async () => {
    const u = await mkUser();
    await deposit(u, 20_000);
    await deposit(u, 20_000);
    expect(await balanceOf(u)).toBe(40_000);
  });

  it("atteindre exactement le plafond : accepté ; le dépasser : rejeté, rien d'écrit", async () => {
    const u = await mkUser();
    for (let i = 0; i < 4; i++) await deposit(u, 20_000);
    await deposit(u, 20_000); // 100 000 pile
    expect(await balanceOf(u)).toBe(100_000);
    const before = await ledgerCount(u);
    await expect(deposit(u, 100)).rejects.toThrow(/wallets_balance_ck/);
    expect(await ledgerCount(u)).toBe(before);
    expect(await balanceOf(u)).toBe(100_000);
  });

  it('achat supérieur au solde : rejeté, solde inchangé, aucune ligne de registre', async () => {
    const u = await mkUser();
    await deposit(u, 1_000);
    const o = await mkOrder(u, 2_000);
    await expect(ledger(u, 'PURCHASE', -2_000, o)).rejects.toThrow(/wallets_balance_ck/);
    expect(await balanceOf(u)).toBe(1_000);
    expect(await ledgerCount(u)).toBe(1);
  });

  it('achat puis remboursement partiel : le solde suit', async () => {
    const u = await mkUser();
    await deposit(u, 5_000);
    const o = await mkOrder(u, 3_000, { status: 'PARTIALLY_DISPENSED', refunded: 1_000 });
    await ledger(u, 'PURCHASE', -3_000, o);
    await ledger(u, 'REFUND', 1_000, o);
    expect(await balanceOf(u)).toBe(3_000);
  });

  it('un achat sans wallet (utilisateur ADMIN) est rejeté', async () => {
    const a = await mkUser('ADMIN');
    await expect(deposit(a, 1_000)).rejects.toThrow(/aucun wallet/);
  });

  it.each([
    ['dépôt négatif', `'DEPOSIT', -100, 'ins-a', NULL`, /wallet_ledger_sign_ck/],
    ['achat positif', `'PURCHASE', 100, NULL, '__ORDER__'`, /wallet_ledger_sign_ck/],
    ['montant non multiple de 100', `'DEPOSIT', 150, 'ins-b', NULL`, /wallet_ledger_step_ck/],
    ['dépôt sans insertion_id', `'DEPOSIT', 100, NULL, NULL`, /wallet_ledger_refs_ck/],
    ['achat sans commande', `'PURCHASE', -100, NULL, NULL`, /wallet_ledger_refs_ck/],
    ['type inconnu', `'BONUS', 100, 'ins-c', NULL`, /wallet_ledger_(type|sign|refs)_ck/],
  ])('registre invalide : %s', async (_n, values, re) => {
    const u = await mkUser();
    await deposit(u, 1_000);
    const o = await mkOrder(u, 100);
    const v = values.replace(`'__ORDER__'`, `'${o}'`).replace(/'ins-[abc]'/, `'ins-${next()}'`);
    await expect(
      pool.query(
        `INSERT INTO wallet_ledger (user_id, type, amount_ar, insertion_id, order_id, created_at)
                  SELECT $1, v.t, v.a, v.i, v.o::uuid, 1 FROM (VALUES (${v})) AS v(t, a, i, o)`,
        [u],
      ),
    ).rejects.toThrow(re);
  });

  it('au plus un REFUND et un PURCHASE par commande (pas de double remboursement)', async () => {
    const u = await mkUser();
    await deposit(u, 10_000);
    const o = await mkOrder(u, 3_000, { status: 'FAILED', refunded: 3_000 });
    await ledger(u, 'PURCHASE', -3_000, o);
    await ledger(u, 'REFUND', 3_000, o);
    await expect(ledger(u, 'REFUND', 3_000, o)).rejects.toThrow(/wallet_ledger_order_type_uq/);
    await expect(ledger(u, 'PURCHASE', -3_000, o)).rejects.toThrow(/wallet_ledger_order_type_uq/);
    expect(await balanceOf(u)).toBe(10_000);
  });

  it('registre append-only : UPDATE, DELETE et TRUNCATE interdits', async () => {
    const u = await mkUser();
    await deposit(u, 1_000);
    await expect(pool.query('UPDATE wallet_ledger SET amount_ar = 100 WHERE user_id = $1', [u])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM wallet_ledger WHERE user_id = $1', [u])).rejects.toThrow(/append-only/);
    await expect(pool.query('TRUNCATE wallet_ledger')).rejects.toThrow(/append-only/);
    expect(await balanceOf(u)).toBe(1_000);
  });

  it("LIMITE : un UPDATE direct de wallets échappe aux triggers, mais la requête d'audit le détecte", async () => {
    const u = await mkUser();
    await deposit(u, 1_000);
    await pool.query('UPDATE wallets SET balance_ar = 5000 WHERE user_id = $1', [u]); // triche
    const audit = `SELECT w.user_id FROM wallets w
                   WHERE w.balance_ar <> COALESCE((SELECT sum(l.amount_ar) FROM wallet_ledger l WHERE l.user_id = w.user_id), 0)`;
    const bad = await pool.query(audit);
    expect(bad.rows.map((r) => r.user_id)).toContain(u);
    // le CHECK borne quand même les dégâts
    await expect(pool.query('UPDATE wallets SET balance_ar = -100 WHERE user_id = $1', [u])).rejects.toThrow(/wallets_balance_ck/);
    await pool.query('UPDATE wallets SET balance_ar = 1000 WHERE user_id = $1', [u]); // réparation pour les autres tests
  });
});

describe('stock', () => {
  it('RESTOCK incrémente, SALE décrémente, SALE_REVERSAL restaure', async () => {
    const admin = await mkUser('ADMIN');
    const client = await mkUser();
    const p = await mkProduct();
    const o = await mkOrder(client, 1_500);
    await restock(p, admin, 5);
    await movement(p, -2, 'SALE', o, null);
    expect(await stockOf(p)).toBe(3);
    await movement(p, 1, 'SALE_REVERSAL', o, null);
    expect(await stockOf(p)).toBe(4);
  });

  it('vente au-delà du stock : rejetée, stock inchangé, aucun mouvement écrit', async () => {
    const admin = await mkUser('ADMIN');
    const client = await mkUser();
    const p = await mkProduct();
    await restock(p, admin, 2);
    const o = await mkOrder(client, 4_500);
    await expect(movement(p, -3, 'SALE', o, null)).rejects.toThrow(/products_stock_ck/);
    expect(await stockOf(p)).toBe(2);
    const n = await one<{ n: string }>('SELECT count(*) AS n FROM stock_movements WHERE product_id = $1', [p]);
    expect(Number(n.n)).toBe(1);
  });

  it('une annulation de vente par (commande, produit) : pas de restock en double', async () => {
    const admin = await mkUser('ADMIN');
    const client = await mkUser();
    const p = await mkProduct();
    const o = await mkOrder(client, 1_500);
    await restock(p, admin, 3);
    await movement(p, -1, 'SALE', o, null);
    await movement(p, 1, 'SALE_REVERSAL', o, null);
    await expect(movement(p, 1, 'SALE_REVERSAL', o, null)).rejects.toThrow(/stock_movements_order_product_reason_uq/);
    await expect(movement(p, -1, 'SALE', o, null)).rejects.toThrow(/stock_movements_order_product_reason_uq/);
    expect(await stockOf(p)).toBe(3);
  });

  it.each([
    ['RESTOCK sans administrateur', 'RESTOCK', 5, false, false],
    ['RESTOCK négatif', 'RESTOCK', -5, false, true],
    ['SALE positive', 'SALE', 1, true, false],
    ['SALE avec administrateur', 'SALE', -1, true, true],
    ['SALE sans commande', 'SALE', -1, false, false],
    ['ADMIN_ADJUST nul', 'ADMIN_ADJUST', 0, false, true],
  ])('mouvement invalide : %s', async (_n, reason, delta, withOrder, withActor) => {
    const admin = await mkUser('ADMIN');
    const client = await mkUser();
    const p = await mkProduct();
    const o = await mkOrder(client, 1_500);
    await expect(movement(p, delta, reason, withOrder ? o : null, withActor ? admin : null)).rejects.toThrow(/stock_movements_shape_ck/);
  });

  it('mouvements append-only', async () => {
    const admin = await mkUser('ADMIN');
    const p = await mkProduct();
    await restock(p, admin, 4);
    await expect(pool.query('UPDATE stock_movements SET delta = 99 WHERE product_id = $1', [p])).rejects.toThrow(/append-only/);
    await expect(pool.query('DELETE FROM stock_movements WHERE product_id = $1', [p])).rejects.toThrow(/append-only/);
    expect(await stockOf(p)).toBe(4);
  });
});

describe('orders et order_items', () => {
  it.each([
    ['PENDING_DISPENSE', 0, null, true],
    ['DISPENSED', 0, 2, true],
    ['FAILED', 3_000, 2, true],
    ['PARTIALLY_DISPENSED', 1_000, 2, true],
    ['FAILED', 0, 2, false], // échec sans remboursement
    ['FAILED', 1_000, 2, false], // remboursement partiel déclaré FAILED
    ['PARTIALLY_DISPENSED', 3_000, 2, false], // tout remboursé mais "partiel"
    ['PARTIALLY_DISPENSED', 0, 2, false], // rien remboursé mais "partiel"
    ['DISPENSED', 1_000, 2, false], // livré ET remboursé
    ['PENDING_DISPENSE', 0, 2, false], // en cours mais déjà terminé
    ['DISPENSED', 0, null, false], // terminé sans date de fin
    ['REFUNDED', 0, 2, false], // statut inconnu
  ])('statut %s, remboursé %i, fin %s -> accepté = %s', async (status, refunded, finished, accepted) => {
    const u = await mkUser();
    // l'unicité "une seule commande en cours" ne doit pas polluer ce test
    await pool.query(`UPDATE orders SET status = 'FAILED', refunded_ar = total_ar, finished_at = 2 WHERE status = 'PENDING_DISPENSE'`);
    const p = mkOrder(u, 3_000, { status, refunded, finished });
    if (accepted) await expect(p).resolves.toBeDefined();
    else await expect(p).rejects.toThrow(/orders_(status|refund_coherence|finished)_ck/);
  });

  it.each([0, 1_250, -100, 100_100])('total %i rejeté', async (total) => {
    const u = await mkUser();
    await expect(mkOrder(u, total, { status: 'DISPENSED' })).rejects.toThrow(/orders_total_ck/);
  });

  it("clé d'idempotence unique PAR utilisateur", async () => {
    const [u1, u2] = [await mkUser(), await mkUser()];
    const ins = (u: string) =>
      pool.query(
        `INSERT INTO orders (user_id, status, total_ar, idempotency_key, created_at, finished_at)
                  VALUES ($1, 'DISPENSED', 1000, 'same-key-1', 1, 2)`,
        [u],
      );
    await ins(u1);
    await expect(ins(u1)).rejects.toThrow(/orders_user_idem_uq/);
    await expect(ins(u2)).resolves.toBeDefined();
  });

  it('une seule commande PENDING_DISPENSE dans toute la machine', async () => {
    const [u1, u2] = [await mkUser(), await mkUser()];
    await pool.query(`UPDATE orders SET status = 'FAILED', refunded_ar = total_ar, finished_at = 2 WHERE status = 'PENDING_DISPENSE'`);
    const first = await mkOrder(u1, 1_000, { status: 'PENDING_DISPENSE' });
    await expect(mkOrder(u2, 1_000, { status: 'PENDING_DISPENSE' })).rejects.toThrow(/orders_one_pending_uq/);
    await pool.query(`UPDATE orders SET status = 'DISPENSED', finished_at = 3 WHERE id = $1`, [first]);
    await expect(mkOrder(u2, 1_000, { status: 'PENDING_DISPENSE' })).resolves.toBeDefined();
  });

  it('order_items : livré <= commandé, qty > 0, un produit par commande, prix figé valide', async () => {
    const u = await mkUser();
    const p = await mkProduct();
    const o = await mkOrder(u, 3_000);
    const add = (qty: number, delivered: number, price = 1_500) =>
      pool.query('INSERT INTO order_items (order_id, product_id, qty, unit_price_ar, delivered_qty) VALUES ($1, $2, $3, $4, $5)', [
        o,
        p,
        qty,
        price,
        delivered,
      ]);
    await expect(add(2, 3)).rejects.toThrow(/order_items_delivered_ck/);
    await expect(add(0, 0)).rejects.toThrow(/order_items_qty_ck/);
    await expect(add(1, 0, 1_250)).rejects.toThrow(/order_items_price_ck/);
    await expect(add(2, 1)).resolves.toBeDefined();
    await expect(add(1, 0)).rejects.toThrow(/order_items_order_id_product_id_pk/);
  });
});

describe('machine_state (singleton, reflet de MachineState)', () => {
  const setState = (sql: string, params: unknown[] = []) =>
    pool.query(`UPDATE machine_state SET ${sql} WHERE id = 1`, sql.includes('$1') ? params : []);
  // chaque test part d'un IDLE valide : un test ne doit jamais dépendre de l'état laissé par un autre
  beforeEach(async () => {
    await pool.query(
      `UPDATE machine_state SET kind='IDLE', user_id=NULL, admin_id=NULL, started_at=NULL, last_activity_at=NULL, phase=NULL WHERE id = 1`,
    );
  });

  it('transitions valides : IDLE -> CLIENT (SELECTING, DISPENSING) -> IDLE -> MAINTENANCE -> IDLE', async () => {
    const [c, a] = [await mkUser(), await mkUser('ADMIN')];
    await setState(`kind='CLIENT_ACTIVE', user_id=$1, started_at=100, last_activity_at=100, phase='SELECTING'`, [c]);
    await setState(`phase='DISPENSING', last_activity_at=150`);
    await setState(`kind='IDLE', user_id=NULL, started_at=NULL, last_activity_at=NULL, phase=NULL`);
    await setState(`kind='MAINTENANCE', admin_id=$1, started_at=200, last_activity_at=200`, [a]);
    await setState(`kind='IDLE', admin_id=NULL, started_at=NULL, last_activity_at=NULL`);
    expect((await one<{ kind: string }>('SELECT kind FROM machine_state')).kind).toBe('IDLE');
  });

  it.each([
    ['CLIENT_ACTIVE sans phase', `kind='CLIENT_ACTIVE', user_id=$1, started_at=1, last_activity_at=1, phase=NULL`],
    ['CLIENT_ACTIVE avec admin_id', `kind='CLIENT_ACTIVE', user_id=$1, admin_id=$1, started_at=1, last_activity_at=1, phase='SELECTING'`],
    ['CLIENT_ACTIVE sans user_id', `kind='CLIENT_ACTIVE', started_at=1, last_activity_at=1, phase='SELECTING'`],
    ['CLIENT_ACTIVE avec phase inconnue', `kind='CLIENT_ACTIVE', user_id=$1, started_at=1, last_activity_at=1, phase='WAITING'`],
    ['début après la dernière activité', `kind='CLIENT_ACTIVE', user_id=$1, started_at=10, last_activity_at=5, phase='SELECTING'`],
    ['MAINTENANCE avec user_id', `kind='MAINTENANCE', admin_id=$1, user_id=$1, started_at=1, last_activity_at=1`],
    ['MAINTENANCE avec phase', `kind='MAINTENANCE', admin_id=$1, started_at=1, last_activity_at=1, phase='SELECTING'`],
    ['IDLE avec user_id', `user_id=$1`],
    ['type inconnu', `kind='BROKEN'`],
  ])('forme invalide rejetée : %s', async (_n, sql) => {
    const u = await mkUser();
    await expect(setState(sql, [u])).rejects.toThrow(/machine_state_shape_ck/);
    expect((await one<{ kind: string }>('SELECT kind FROM machine_state')).kind).toBe('IDLE'); // rien n'a changé
  });

  it('une seconde ligne est impossible ; suppression et vidage interdits', async () => {
    await expect(pool.query(`INSERT INTO machine_state (id, kind) VALUES (2, 'IDLE')`)).rejects.toThrow(/machine_state_singleton_ck/);
    await expect(pool.query(`INSERT INTO machine_state (id, kind) VALUES (1, 'IDLE')`)).rejects.toThrow(/machine_state_pkey/);
    await expect(pool.query('DELETE FROM machine_state')).rejects.toThrow(/ne peut pas être vidée/);
    await expect(pool.query('TRUNCATE machine_state')).rejects.toThrow(/ne peut pas être vidée/);
  });
});

describe('concurrence réelle (deux connexions distinctes)', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('deux achats simultanés de 3 000 sur un solde de 5 000 : un seul réussit', async () => {
    const u = await mkUser();
    await deposit(u, 5_000);
    const [o1, o2] = [await mkOrder(u, 3_000), await mkOrder(u, 3_000)];
    const attempt = async (orderId: string): Promise<'ok' | 'rejected'> => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(`INSERT INTO wallet_ledger (user_id, type, amount_ar, order_id, created_at) VALUES ($1, 'PURCHASE', -3000, $2, 1)`, [
          u,
          orderId,
        ]);
        await sleep(150); // force le chevauchement des deux transactions
        await c.query('COMMIT');
        return 'ok';
      } catch {
        await c.query('ROLLBACK');
        return 'rejected';
      } finally {
        c.release();
      }
    };
    const results = await Promise.all([attempt(o1), attempt(o2)]);
    expect([...results].sort()).toEqual(['ok', 'rejected']);
    expect(await balanceOf(u)).toBe(2_000);
    const n = await one<{ n: string }>(`SELECT count(*) AS n FROM wallet_ledger WHERE user_id = $1 AND type = 'PURCHASE'`, [u]);
    expect(Number(n.n)).toBe(1);
  });

  /**
   * Deux "connexions client" simultanées. Le domaine (transition) est correct, mais lire l'état
   * puis l'écrire dans des transactions NON verrouillées laisse passer les deux : c'est le piège
   * que le dépôt (repository) de la machine devra éviter avec SELECT ... FOR UPDATE.
   */
  const raceLogin = async (lock: boolean): Promise<('ok' | 'busy')[]> => {
    const [u1, u2] = [await mkUser(), await mkUser()];
    await pool.query(
      `UPDATE machine_state SET kind='IDLE', user_id=NULL, admin_id=NULL, started_at=NULL, last_activity_at=NULL, phase=NULL WHERE id = 1`,
    );
    const login = async (userId: string): Promise<'ok' | 'busy'> => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const { rows } = await c.query(`SELECT kind FROM machine_state WHERE id = 1 ${lock ? 'FOR UPDATE' : ''}`);
        await sleep(150);
        if (rows[0].kind !== 'IDLE') {
          await c.query('ROLLBACK');
          return 'busy';
        }
        await c.query(
          `UPDATE machine_state SET kind='CLIENT_ACTIVE', user_id=$1, started_at=1, last_activity_at=1, phase='SELECTING' WHERE id = 1`,
          [userId],
        );
        await c.query('COMMIT');
        return 'ok';
      } finally {
        c.release();
      }
    };
    return Promise.all([login(u1), login(u2)]);
  };

  it('AVEC verrou (FOR UPDATE) : un seul client prend la machine', async () => {
    expect([...(await raceLogin(true))].sort()).toEqual(['busy', 'ok']);
  });

  it("SANS verrou (anti-modèle) : les deux croient l'avoir prise -> le verrou est indispensable", async () => {
    expect(await raceLogin(false)).toEqual(['ok', 'ok']);
  });
});
