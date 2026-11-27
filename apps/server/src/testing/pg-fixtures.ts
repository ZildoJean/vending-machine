import type { Pool } from 'pg';

let seq = 0;

export async function mkUser(pool: Pool, role: 'CLIENT' | 'ADMIN' = 'CLIENT'): Promise<string> {
  const r = await pool.query('INSERT INTO users (login, role, pin_hash, created_at) VALUES ($1, $2, $3, 1) RETURNING id', [
    `fx_${process.pid}_${++seq}`,
    role,
    'hash',
  ]);
  return (r.rows[0] as { id: string }).id;
}

export async function resetMachine(pool: Pool): Promise<void> {
  await pool.query(
    `UPDATE machine_state SET kind='IDLE', user_id=NULL, admin_id=NULL, started_at=NULL, last_activity_at=NULL, phase=NULL WHERE id = 1`,
  );
}

export async function readMachineRow(pool: Pool): Promise<Record<string, unknown>> {
  const r = await pool.query('SELECT kind, user_id, admin_id, started_at, last_activity_at, phase FROM machine_state WHERE id = 1');
  const row = r.rows[0] as Record<string, unknown>;
  // `pg` renvoie les bigint en texte en SQL brut : on normalise pour comparer à des nombres
  for (const k of ['started_at', 'last_activity_at']) if (row[k] !== null) row[k] = Number(row[k]);
  return row;
}

export async function deposit(pool: Pool, userId: string, amount: number): Promise<void> {
  await pool.query(`INSERT INTO wallet_ledger (user_id, type, amount_ar, insertion_id, created_at) VALUES ($1, 'DEPOSIT', $2, $3, 1)`, [
    userId,
    amount,
    `fx-ins-${process.pid}-${++seq}`,
  ]);
}

/** Produit avec stock initial, via un vrai mouvement RESTOCK (le stock est maintenu par trigger). */
export async function mkProduct(pool: Pool, adminId: string, priceAr: number, stock: number): Promise<string> {
  const r = await pool.query('INSERT INTO products (name, price_ar) VALUES ($1, $2) RETURNING id', [
    `fx produit ${process.pid}-${++seq}`,
    priceAr,
  ]);
  const id = (r.rows[0] as { id: string }).id;
  if (stock > 0) {
    await pool.query(`INSERT INTO stock_movements (product_id, delta, reason, actor_id, created_at) VALUES ($1, $2, 'RESTOCK', $3, 1)`, [
      id,
      stock,
      adminId,
    ]);
  }
  return id;
}

export async function stockOf(pool: Pool, productId: string): Promise<number> {
  return ((await pool.query('SELECT stock FROM products WHERE id = $1', [productId])).rows[0] as { stock: number }).stock;
}

export async function balanceOf(pool: Pool, userId: string): Promise<number> {
  return ((await pool.query('SELECT balance_ar FROM wallets WHERE user_id = $1', [userId])).rows[0] as { balance_ar: number }).balance_ar;
}

export async function ledgerTypes(pool: Pool, userId: string): Promise<string[]> {
  return (await pool.query('SELECT type FROM wallet_ledger WHERE user_id = $1 ORDER BY id', [userId])).rows.map(
    (r) => (r as { type: string }).type,
  );
}
