import type { Pool } from 'pg';

let seq = 0;

export async function mkUser(pool: Pool, role: 'CLIENT' | 'ADMIN' = 'CLIENT'): Promise<string> {
  const r = await pool.query(
    'INSERT INTO users (login, role, pin_hash, created_at) VALUES ($1, $2, $3, 1) RETURNING id',
    [`fx_${process.pid}_${++seq}`, role, 'hash'],
  );
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
