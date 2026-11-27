import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { OrderNotDispensableError } from '../../application/errors';
import type { CatalogStore, NewOrder, OrderFinish, OrderRecord, OrderStatus, OrderStore, WalletStore } from '../../application/ports';
import type { Product } from '../../domain/cart';
import { depositEntry, purchaseEntry, refundEntry } from '../../domain/wallet';
import type { Tx } from './client';
import { orderItems, orders, products, stockMovements, walletLedger, wallets } from './schema';

const STATUSES: ReadonlySet<string> = new Set(['PENDING_DISPENSE', 'DISPENSED', 'PARTIALLY_DISPENSED', 'FAILED']);
function asStatus(s: string): OrderStatus {
  if (!STATUSES.has(s)) throw new Error(`Invariant violé : statut de commande inconnu (${s})`);
  return s as OrderStatus;
}
const byProduct = (a: { productId: string }, b: { productId: string }): number =>
  a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0;

export class PgOrderStore implements OrderStore {
  constructor(private readonly tx: Tx) {}

  private async hydrate(row: typeof orders.$inferSelect): Promise<OrderRecord> {
    const items = await this.tx.select().from(orderItems).where(eq(orderItems.orderId, row.id)).orderBy(orderItems.productId);
    return {
      id: row.id,
      userId: row.userId,
      status: asStatus(row.status),
      totalAr: row.totalAr,
      refundedAr: row.refundedAr,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
      finishedAt: row.finishedAt,
      items: items.map((i) => ({ productId: i.productId, qty: i.qty, unitPriceAr: i.unitPriceAr, deliveredQty: i.deliveredQty })),
    };
  }

  async findByKey(userId: string, idempotencyKey: string): Promise<OrderRecord | null> {
    const rows = await this.tx
      .select()
      .from(orders)
      .where(and(eq(orders.userId, userId), eq(orders.idempotencyKey, idempotencyKey)))
      .limit(1);
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async findById(orderId: string, opts: { readonly lock: boolean }): Promise<OrderRecord | null> {
    const q = this.tx.select().from(orders).where(eq(orders.id, orderId));
    const rows = await (opts.lock ? q.for('update') : q);
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async findLastByUser(userId: string): Promise<OrderRecord | null> {
    const rows = await this.tx
      .select()
      .from(orders)
      .where(eq(orders.userId, userId))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(1);
    return rows[0] ? this.hydrate(rows[0]) : null;
  }

  async findPendingId(): Promise<string | null> {
    const rows = await this.tx.select({ id: orders.id }).from(orders).where(eq(orders.status, 'PENDING_DISPENSE')).limit(1);
    return rows[0]?.id ?? null;
  }

  async place(o: NewOrder): Promise<string> {
    const inserted = await this.tx
      .insert(orders)
      .values({
        userId: o.userId,
        status: 'PENDING_DISPENSE',
        totalAr: o.quote.totalAr,
        refundedAr: 0,
        idempotencyKey: o.idempotencyKey,
        createdAt: o.createdAt,
      })
      .returning({ id: orders.id });
    const orderId = inserted[0]?.id;
    if (orderId === undefined) throw new Error('Invariant violé : création de commande');

    const lines = [...o.quote.lines].sort(byProduct);
    await this.tx
      .insert(orderItems)
      .values(lines.map((l) => ({ orderId, productId: l.productId, qty: l.qty, unitPriceAr: l.unitPriceAr, deliveredQty: 0 })));
    const purchase = purchaseEntry(o.quote.totalAr, orderId);
    await this.tx
      .insert(walletLedger)
      .values({ userId: o.userId, type: purchase.type, amountAr: purchase.amountAr, orderId, createdAt: o.createdAt });
    await this.tx
      .insert(stockMovements)
      .values(lines.map((l) => ({ productId: l.productId, delta: -l.qty, reason: 'SALE', orderId, createdAt: o.createdAt })));
    return orderId;
  }

  async markUnitDelivered(orderId: string, productId: string): Promise<void> {
    const res = await this.tx.execute(sql`
      UPDATE order_items oi SET delivered_qty = oi.delivered_qty + 1
      FROM orders o
      WHERE o.id = oi.order_id AND oi.order_id = ${orderId} AND oi.product_id = ${productId}
        AND o.status = 'PENDING_DISPENSE' AND oi.delivered_qty < oi.qty
      RETURNING oi.order_id`);
    if (res.rows.length !== 1) throw new OrderNotDispensableError(orderId);
  }

  async finish(orderId: string, f: OrderFinish): Promise<void> {
    const updated = await this.tx
      .update(orders)
      .set({ status: f.status, refundedAr: f.refundedAr, finishedAt: f.finishedAt })
      .where(and(eq(orders.id, orderId), eq(orders.status, 'PENDING_DISPENSE')))
      .returning({ userId: orders.userId });
    const row = updated[0];
    if (row === undefined) throw new OrderNotDispensableError(orderId);

    if (f.refundedAr > 0) {
      const refund = refundEntry(f.refundedAr, orderId);
      await this.tx
        .insert(walletLedger)
        .values({ userId: row.userId, type: refund.type, amountAr: refund.amountAr, orderId, createdAt: f.finishedAt });
    }
    if (f.restock.length > 0) {
      await this.tx
        .insert(stockMovements)
        .values(
          [...f.restock]
            .sort(byProduct)
            .map((r) => ({ productId: r.productId, delta: r.qty, reason: 'SALE_REVERSAL', orderId, createdAt: f.finishedAt })),
        );
    }
  }
}

export class PgCatalogStore implements CatalogStore {
  constructor(private readonly tx: Tx) {}
  async listActive(): Promise<Product[]> {
    const rows = await this.tx.select().from(products).where(eq(products.active, true)).orderBy(products.name);
    return rows.map((r) => ({ id: r.id, name: r.name, priceAr: r.priceAr, stock: r.stock, active: r.active }));
  }
  async loadForUpdate(productIds: readonly string[]): Promise<Product[]> {
    if (productIds.length === 0) return [];
    const rows = await this.tx
      .select()
      .from(products)
      .where(inArray(products.id, [...productIds]))
      .orderBy(products.id)
      .for('update');
    return rows.map((r) => ({ id: r.id, name: r.name, priceAr: r.priceAr, stock: r.stock, active: r.active }));
  }
}

export class PgWalletStore implements WalletStore {
  constructor(private readonly tx: Tx) {}
  private async read(userId: string, lock: boolean): Promise<number> {
    if (lock) {
      // fonction SECURITY DEFINER : verrou de ligne sans droit d'écriture sur wallets (voir deploy/roles.sql)
      const res = await this.tx.execute(sql`SELECT lock_wallet(${userId}::uuid) AS balance_ar`);
      const locked = (res.rows[0] as { balance_ar: number | null } | undefined)?.balance_ar;
      if (locked === null || locked === undefined) throw new Error(`Invariant violé : wallet introuvable (${userId})`);
      return locked;
    }
    const rows = await this.tx.select({ balanceAr: wallets.balanceAr }).from(wallets).where(eq(wallets.userId, userId));
    const row = rows[0];
    if (row === undefined) throw new Error(`Invariant violé : wallet introuvable (${userId})`);
    return row.balanceAr;
  }
  async findDeposit(insertionId: string): Promise<{ readonly userId: string; readonly amountAr: number } | null> {
    const rows = await this.tx
      .select({ userId: walletLedger.userId, amountAr: walletLedger.amountAr })
      .from(walletLedger)
      .where(eq(walletLedger.insertionId, insertionId))
      .limit(1);
    return rows[0] ?? null;
  }
  async appendDeposit(userId: string, amountAr: number, insertionId: string, createdAt: number): Promise<void> {
    const e = depositEntry(amountAr, insertionId);
    await this.tx.insert(walletLedger).values({ userId, type: e.type, amountAr: e.amountAr, insertionId, createdAt });
  }
  balanceForUpdate(userId: string): Promise<number> {
    return this.read(userId, true);
  }
  balance(userId: string): Promise<number> {
    return this.read(userId, false);
  }
}
