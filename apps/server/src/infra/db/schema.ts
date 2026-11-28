import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, pgTable, primaryKey, smallint, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { MONEY_CONFIG } from '@vending/shared';

/**
 * Les invariants d'argent et de stock sont imposés PAR LA BASE (CHECK + déclencheurs, voir la
 * migration "triggers"), en plus du domaine : un bug applicatif ne doit pas pouvoir corrompre
 * le registre. Step et plafond viennent de MONEY_CONFIG au moment de la GÉNÉRATION de la
 * migration : les changer exige une nouvelle migration (un test vérifie la cohérence).
 */
const STEP = sql.raw(String(MONEY_CONFIG.step));
const CAP = sql.raw(String(MONEY_CONFIG.walletCap));

/** Horodatages en ms epoch fournis par l'horloge injectée (jamais now() en base). */
const ms = (name: string) => bigint(name, { mode: 'number' });

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    login: text('login').notNull(),
    role: text('role').notNull(),
    pinHash: text('pin_hash').notNull(),
    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: ms('locked_until'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('users_login_lower_uq').on(sql`lower(${t.login})`),
    check('users_role_ck', sql`${t.role} IN ('CLIENT', 'ADMIN')`),
    check('users_failed_attempts_ck', sql`${t.failedAttempts} >= 0`),
    check('users_login_len_ck', sql`char_length(${t.login}) BETWEEN 3 AND 32`),
  ],
);

/** Solde maintenu PAR TRIGGER à partir du registre : jamais écrit directement par l'application. */
export const wallets = pgTable(
  'wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'restrict' }),
    balanceAr: integer('balance_ar').notNull().default(0),
  },
  (t) => [check('wallets_balance_ck', sql`${t.balanceAr} >= 0 AND ${t.balanceAr} <= ${CAP} AND ${t.balanceAr} % ${STEP} = 0`)],
);

/** `stock` est maintenu PAR TRIGGER à partir de stock_movements. */
export const products = pgTable(
  'products',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    priceAr: integer('price_ar').notNull(),
    stock: integer('stock').notNull().default(0),
    active: boolean('active').notNull().default(true),
  },
  (t) => [
    uniqueIndex('products_name_lower_uq').on(sql`lower(${t.name})`),
    check('products_name_len_ck', sql`char_length(${t.name}) BETWEEN 1 AND 50`),
    check('products_price_ck', sql`${t.priceAr} > 0 AND ${t.priceAr} <= ${CAP} AND ${t.priceAr} % ${STEP} = 0`),
    check('products_stock_ck', sql`${t.stock} >= 0`),
  ],
);

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    status: text('status').notNull(),
    totalAr: integer('total_ar').notNull(),
    refundedAr: integer('refunded_ar').notNull().default(0),
    idempotencyKey: text('idempotency_key').notNull(),
    createdAt: ms('created_at').notNull(),
    finishedAt: ms('finished_at'),
  },
  (t) => [
    uniqueIndex('orders_user_idem_uq').on(t.userId, t.idempotencyKey),
    // Au plus UNE commande en cours de distribution dans toute la machine.
    uniqueIndex('orders_one_pending_uq')
      .on(t.status)
      .where(sql`${t.status} = 'PENDING_DISPENSE'`),
    index('orders_user_created_idx').on(t.userId, t.createdAt),
    check('orders_status_ck', sql`${t.status} IN ('PENDING_DISPENSE', 'DISPENSED', 'PARTIALLY_DISPENSED', 'FAILED')`),
    check('orders_total_ck', sql`${t.totalAr} > 0 AND ${t.totalAr} <= ${CAP} AND ${t.totalAr} % ${STEP} = 0`),
    check('orders_refund_step_ck', sql`${t.refundedAr} >= 0 AND ${t.refundedAr} % ${STEP} = 0`),
    check(
      'orders_refund_coherence_ck',
      sql`(${t.status} = 'PENDING_DISPENSE' AND ${t.refundedAr} = 0)
        OR (${t.status} = 'DISPENSED' AND ${t.refundedAr} = 0)
        OR (${t.status} = 'PARTIALLY_DISPENSED' AND ${t.refundedAr} > 0 AND ${t.refundedAr} < ${t.totalAr})
        OR (${t.status} = 'FAILED' AND ${t.refundedAr} = ${t.totalAr})`,
    ),
    check('orders_finished_ck', sql`(${t.status} = 'PENDING_DISPENSE') = (${t.finishedAt} IS NULL)`),
    check('orders_idem_len_ck', sql`char_length(${t.idempotencyKey}) BETWEEN 8 AND 100`),
  ],
);

export const orderItems = pgTable(
  'order_items',
  {
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    qty: integer('qty').notNull(),
    /** Prix FIGÉ au moment de l'achat. */
    unitPriceAr: integer('unit_price_ar').notNull(),
    deliveredQty: integer('delivered_qty').notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.orderId, t.productId] }),
    check('order_items_qty_ck', sql`${t.qty} > 0`),
    check('order_items_price_ck', sql`${t.unitPriceAr} > 0 AND ${t.unitPriceAr} <= ${CAP} AND ${t.unitPriceAr} % ${STEP} = 0`),
    check('order_items_delivered_ck', sql`${t.deliveredQty} >= 0 AND ${t.deliveredQty} <= ${t.qty}`),
  ],
);

/** Registre append-only (UPDATE/DELETE/TRUNCATE interdits par trigger). */
export const walletLedger = pgTable(
  'wallet_ledger',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type').notNull(),
    amountAr: integer('amount_ar').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    insertionId: text('insertion_id'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('wallet_ledger_user_idx').on(t.userId, t.id),
    // Un billet physique = un identifiant : un rejeu HTTP ne crédite pas deux fois.
    uniqueIndex('wallet_ledger_insertion_uq').on(t.insertionId),
    // Au plus un achat et un remboursement par commande : pas de double remboursement.
    uniqueIndex('wallet_ledger_order_type_uq')
      .on(t.orderId, t.type)
      .where(sql`${t.orderId} IS NOT NULL`),
    check('wallet_ledger_type_ck', sql`${t.type} IN ('DEPOSIT', 'PURCHASE', 'REFUND')`),
    check(
      'wallet_ledger_sign_ck',
      sql`(${t.type} = 'PURCHASE' AND ${t.amountAr} < 0) OR (${t.type} IN ('DEPOSIT', 'REFUND') AND ${t.amountAr} > 0)`,
    ),
    check('wallet_ledger_step_ck', sql`${t.amountAr} % ${STEP} = 0`),
    check(
      'wallet_ledger_refs_ck',
      sql`(${t.type} = 'DEPOSIT' AND ${t.insertionId} IS NOT NULL AND ${t.orderId} IS NULL)
        OR (${t.type} IN ('PURCHASE', 'REFUND') AND ${t.orderId} IS NOT NULL AND ${t.insertionId} IS NULL)`,
    ),
  ],
);

/** Registre append-only des mouvements de stock. */
export const stockMovements = pgTable(
  'stock_movements',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'restrict' }),
    delta: integer('delta').notNull(),
    reason: text('reason').notNull(),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'restrict' }),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [
    index('stock_movements_product_idx').on(t.productId, t.id),
    // Au plus une vente et une annulation de vente par (commande, produit).
    uniqueIndex('stock_movements_order_product_reason_uq')
      .on(t.orderId, t.productId, t.reason)
      .where(sql`${t.orderId} IS NOT NULL`),
    check('stock_movements_reason_ck', sql`${t.reason} IN ('RESTOCK', 'ADMIN_ADJUST', 'SALE', 'SALE_REVERSAL')`),
    check(
      'stock_movements_shape_ck',
      sql`(${t.reason} = 'SALE' AND ${t.delta} < 0 AND ${t.orderId} IS NOT NULL AND ${t.actorId} IS NULL)
        OR (${t.reason} = 'SALE_REVERSAL' AND ${t.delta} > 0 AND ${t.orderId} IS NOT NULL AND ${t.actorId} IS NULL)
        OR (${t.reason} = 'RESTOCK' AND ${t.delta} > 0 AND ${t.orderId} IS NULL AND ${t.actorId} IS NOT NULL)
        OR (${t.reason} = 'ADMIN_ADJUST' AND ${t.delta} <> 0 AND ${t.orderId} IS NULL AND ${t.actorId} IS NOT NULL)`,
    ),
  ],
);

/**
 * Piège PostgreSQL : un CHECK qui vaut NULL PASSE. Toute comparaison sur une colonne nullable
 * (ici `phase`) doit donc être protégée (IS NOT NULL ou COALESCE), sinon la contrainte est vide.
 */
/** Singleton : une seule ligne (id = 1), amorcée par la migration. Reflète le type MachineState. */
export const machineState = pgTable(
  'machine_state',
  {
    id: smallint('id').primaryKey().default(1),
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'restrict' }),
    adminId: uuid('admin_id').references(() => users.id, { onDelete: 'restrict' }),
    startedAt: ms('started_at'),
    lastActivityAt: ms('last_activity_at'),
    phase: text('phase'),
  },
  (t) => [
    check('machine_state_singleton_ck', sql`${t.id} = 1`),
    check(
      'machine_state_shape_ck',
      sql`(${t.kind} = 'IDLE' AND ${t.userId} IS NULL AND ${t.adminId} IS NULL AND ${t.startedAt} IS NULL AND ${t.lastActivityAt} IS NULL AND ${t.phase} IS NULL)
        OR (${t.kind} = 'CLIENT_ACTIVE' AND ${t.userId} IS NOT NULL AND ${t.adminId} IS NULL AND ${t.startedAt} IS NOT NULL AND ${t.lastActivityAt} IS NOT NULL AND ${t.startedAt} <= ${t.lastActivityAt} AND COALESCE(${t.phase} IN ('SELECTING', 'DISPENSING'), false))
        OR (${t.kind} = 'MAINTENANCE' AND ${t.adminId} IS NOT NULL AND ${t.userId} IS NULL AND ${t.startedAt} IS NOT NULL AND ${t.lastActivityAt} IS NOT NULL AND ${t.startedAt} <= ${t.lastActivityAt} AND ${t.phase} IS NULL)`,
    ),
  ],
);

/** Journal d'audit append-only des actions administrateur. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    actorId: uuid('actor_id').references(() => users.id, { onDelete: 'restrict' }),
    action: text('action').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    oldValue: jsonb('old_value'),
    newValue: jsonb('new_value'),
    createdAt: ms('created_at').notNull(),
  },
  (t) => [index('audit_log_created_idx').on(t.createdAt)],
);

/**
 * Une seule session par utilisateur. On ne stocke JAMAIS le jeton, seulement son SHA-256.
 * Pour un CLIENT, la session n'est valide que si machine_state désigne cet utilisateur ET la même
 * `machine_started_at` : la machine reste la seule source de vérité.
 */
export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    tokenHash: text('token_hash').notNull(),
    machineStartedAt: ms('machine_started_at'),
    createdAt: ms('created_at').notNull(),
    lastSeenAt: ms('last_seen_at').notNull(),
    expiresAt: ms('expires_at'),
  },
  (t) => [
    uniqueIndex('sessions_token_hash_uq').on(t.tokenHash),
    uniqueIndex('sessions_user_uq').on(t.userId),
    check('sessions_hash_len_ck', sql`char_length(${t.tokenHash}) = 64`),
  ],
);
