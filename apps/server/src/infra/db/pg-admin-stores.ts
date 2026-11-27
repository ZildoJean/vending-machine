import { desc, eq, sql } from 'drizzle-orm';
import { ConflictError } from '../../application/errors';
import type {
  AuditEntry,
  AuditStore,
  ProductAdminStore,
  ProductRecord,
  Role,
  SessionRecord,
  SessionStore,
  UserStore,
} from '../../application/ports';
import type { Tx } from './client';
import { pgErrorCode } from './errors';
import { auditLog, products, sessions, stockMovements, users } from './schema';

const PG_UNIQUE_VIOLATION = '23505';
function asRole(r: string): Role {
  if (r !== 'CLIENT' && r !== 'ADMIN') throw new Error(`Invariant violé : rôle inconnu (${r})`);
  return r;
}

export class PgUserStore implements UserStore {
  constructor(private readonly tx: Tx) {}

  async reserveAttempt(login: string, now: number, policy: { readonly maxAttempts: number; readonly lockMs: number }) {
    // Une seule instruction : lecture + décision + incrément sont atomiques (verrou de ligne).
    // Si le verrouillage est expiré, le compteur repart de 1 ; au seuil, on verrouille.
    const res = await this.tx.execute(sql`
      UPDATE users SET
        failed_attempts = CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now}::bigint THEN 1 ELSE failed_attempts + 1 END,
        locked_until = CASE
          WHEN (CASE WHEN locked_until IS NOT NULL AND locked_until <= ${now}::bigint THEN 1 ELSE failed_attempts + 1 END) >= ${policy.maxAttempts}
            THEN ${now}::bigint + ${policy.lockMs}::bigint
          WHEN locked_until IS NOT NULL AND locked_until <= ${now}::bigint THEN NULL
          ELSE locked_until END
      WHERE lower(login) = lower(${login}) AND (locked_until IS NULL OR locked_until <= ${now}::bigint)
      RETURNING id, role, pin_hash`);
    const row = res.rows[0] as { id: string; role: string; pin_hash: string } | undefined;
    return row === undefined ? null : { id: row.id, role: asRole(row.role), secretHash: row.pin_hash };
  }

  async recordSuccess(userId: string): Promise<void> {
    await this.tx.update(users).set({ failedAttempts: 0, lockedUntil: null }).where(eq(users.id, userId));
  }

  async create(input: {
    readonly login: string;
    readonly role: Role;
    readonly secretHash: string;
    readonly createdAt: number;
  }): Promise<string> {
    try {
      const rows = await this.tx
        .insert(users)
        .values({ login: input.login, role: input.role, pinHash: input.secretHash, createdAt: input.createdAt })
        .returning({ id: users.id });
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('Invariant violé : création utilisateur');
      return id;
    } catch (e) {
      if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw new ConflictError('LOGIN_TAKEN');
      throw e;
    }
  }

  async setSecret(userId: string, secretHash: string): Promise<boolean> {
    const rows = await this.tx
      .update(users)
      .set({ pinHash: secretHash, failedAttempts: 0, lockedUntil: null })
      .where(eq(users.id, userId))
      .returning({ id: users.id });
    return rows.length === 1;
  }

  async listClients() {
    const rows = await this.tx
      .select({ id: users.id, login: users.login, lockedUntil: users.lockedUntil })
      .from(users)
      .where(eq(users.role, 'CLIENT'))
      .orderBy(users.login);
    return rows;
  }

  async findById(userId: string) {
    const rows = await this.tx
      .select({ id: users.id, login: users.login, role: users.role })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const r = rows[0];
    return r === undefined ? null : { id: r.id, login: r.login, role: asRole(r.role) };
  }
}

export class PgSessionStore implements SessionStore {
  constructor(private readonly tx: Tx) {}

  async replace(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly machineStartedAt: number | null;
    readonly now: number;
    readonly expiresAt: number | null;
  }): Promise<void> {
    await this.tx.delete(sessions).where(eq(sessions.userId, input.userId));
    await this.tx.insert(sessions).values({
      userId: input.userId,
      tokenHash: input.tokenHash,
      machineStartedAt: input.machineStartedAt,
      createdAt: input.now,
      lastSeenAt: input.now,
      expiresAt: input.expiresAt,
    });
  }

  async findByHash(tokenHash: string): Promise<SessionRecord | null> {
    const rows = await this.tx
      .select({
        id: sessions.id,
        userId: sessions.userId,
        login: users.login,
        role: users.role,
        machineStartedAt: sessions.machineStartedAt,
        lastSeenAt: sessions.lastSeenAt,
        expiresAt: sessions.expiresAt,
      })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .where(eq(sessions.tokenHash, tokenHash))
      .limit(1);
    const r = rows[0];
    return r === undefined ? null : { ...r, role: asRole(r.role) };
  }

  async touch(sessionId: string, now: number): Promise<void> {
    await this.tx.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, sessionId));
  }
  async deleteById(sessionId: string): Promise<void> {
    await this.tx.delete(sessions).where(eq(sessions.id, sessionId));
  }
  async deleteByUser(userId: string): Promise<void> {
    await this.tx.delete(sessions).where(eq(sessions.userId, userId));
  }
  async deleteStale(now: number, p: { readonly adminIdleMs: number; readonly clientMaxAgeMs: number }): Promise<number> {
    const res = await this.tx.execute(sql`
      DELETE FROM sessions s WHERE
        (s.expires_at IS NOT NULL AND (s.expires_at <= ${now}::bigint OR s.last_seen_at <= ${now}::bigint - ${p.adminIdleMs}::bigint))
        OR (s.expires_at IS NULL AND s.created_at <= ${now}::bigint - ${p.clientMaxAgeMs}::bigint
            AND NOT EXISTS (SELECT 1 FROM machine_state m WHERE m.user_id = s.user_id AND m.started_at = s.machine_started_at))
      RETURNING s.id`);
    return res.rows.length;
  }
}

export class PgProductAdminStore implements ProductAdminStore {
  constructor(private readonly tx: Tx) {}
  private map(r: typeof products.$inferSelect): ProductRecord {
    return { id: r.id, name: r.name, priceAr: r.priceAr, stock: r.stock, active: r.active };
  }
  async list(): Promise<ProductRecord[]> {
    return (await this.tx.select().from(products).orderBy(products.name)).map((r) => this.map(r));
  }
  async findForUpdate(id: string): Promise<ProductRecord | null> {
    const rows = await this.tx.select().from(products).where(eq(products.id, id)).for('update');
    return rows[0] ? this.map(rows[0]) : null;
  }
  async create(name: string, priceAr: number): Promise<string> {
    try {
      // SQL explicite : seules name et price_ar sont citées. Un INSERT généré par l'ORM citerait aussi `stock`
      // (avec DEFAULT), ce que le rôle applicatif n'a pas le droit d'écrire, même par défaut.
      const res = await this.tx.execute(sql`INSERT INTO products (name, price_ar) VALUES (${name}, ${priceAr}) RETURNING id`);
      const id = (res.rows[0] as { id: string } | undefined)?.id;
      if (id === undefined) throw new Error('Invariant violé : création produit');
      return id;
    } catch (e) {
      if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw new ConflictError('PRODUCT_NAME_TAKEN');
      throw e;
    }
  }
  async update(id: string, patch: { readonly name?: string; readonly priceAr?: number; readonly active?: boolean }): Promise<void> {
    const set: Partial<typeof products.$inferInsert> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.priceAr !== undefined) set.priceAr = patch.priceAr;
    if (patch.active !== undefined) set.active = patch.active;
    try {
      await this.tx.update(products).set(set).where(eq(products.id, id));
    } catch (e) {
      if (pgErrorCode(e) === PG_UNIQUE_VIOLATION) throw new ConflictError('PRODUCT_NAME_TAKEN');
      throw e;
    }
  }
  async addMovement(m: {
    readonly productId: string;
    readonly delta: number;
    readonly reason: 'RESTOCK' | 'ADMIN_ADJUST';
    readonly actorId: string;
    readonly createdAt: number;
  }): Promise<void> {
    await this.tx
      .insert(stockMovements)
      .values({ productId: m.productId, delta: m.delta, reason: m.reason, actorId: m.actorId, createdAt: m.createdAt });
  }
}

export class PgAuditStore implements AuditStore {
  constructor(private readonly tx: Tx) {}
  async append(e: {
    readonly actorId: string | null;
    readonly action: string;
    readonly entity: string;
    readonly entityId: string | null;
    readonly oldValue?: unknown;
    readonly newValue?: unknown;
    readonly createdAt: number;
  }): Promise<void> {
    await this.tx.insert(auditLog).values({
      actorId: e.actorId,
      action: e.action,
      entity: e.entity,
      entityId: e.entityId,
      oldValue: e.oldValue ?? null,
      newValue: e.newValue ?? null,
      createdAt: e.createdAt,
    });
  }
  async list(limit: number): Promise<AuditEntry[]> {
    const rows = await this.tx.select().from(auditLog).orderBy(desc(auditLog.id)).limit(limit);
    return rows.map((r) => ({
      id: r.id,
      actorId: r.actorId,
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      oldValue: r.oldValue,
      newValue: r.newValue,
      createdAt: r.createdAt,
    }));
  }
}
