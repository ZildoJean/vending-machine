import type { Quote, QuoteLine } from './cart';

export type FinalOrderStatus = 'DISPENSED' | 'PARTIALLY_DISPENSED' | 'FAILED';

export interface DeliveredUnits {
  readonly productId: string;
  readonly count: number;
}

export interface RefundPlan {
  readonly status: FinalOrderStatus;
  /** Somme des prix FIGÉS des unités non délivrées. */
  readonly refundAr: number;
  /** Unités à remettre en stock (jamais celles déjà délivrées). */
  readonly restock: readonly { readonly productId: string; readonly qty: number }[];
}

/**
 * Plan de remboursement après distribution unité par unité.
 * `delivered` vient de notre propre Dispenser : une incohérence (produit absent de la commande,
 * doublon, compte négatif ou supérieur au commandé) est un bug => exception, jamais de
 * remboursement négatif ni de produit gratuit.
 */
export function planRefund(lines: Quote['lines'], delivered: readonly DeliveredUnits[]): RefundPlan {
  if (lines.length === 0) throw new Error('Invariant violé : commande sans ligne');

  const byProduct = new Map<string, QuoteLine>();
  for (const l of lines) {
    if (byProduct.has(l.productId)) throw new Error(`Invariant violé : ligne en double (${l.productId})`);
    byProduct.set(l.productId, l);
  }

  const deliveredBy = new Map<string, number>();
  for (const d of delivered) {
    const line = byProduct.get(d.productId);
    if (line === undefined) throw new Error(`Invariant violé : produit livré hors commande (${d.productId})`);
    if (deliveredBy.has(d.productId)) throw new Error(`Invariant violé : livraison en double (${d.productId})`);
    if (!Number.isSafeInteger(d.count) || d.count < 0 || d.count > line.qty) {
      throw new Error(`Invariant violé : quantité livrée invalide (${d.productId}: ${String(d.count)})`);
    }
    deliveredBy.set(d.productId, d.count);
  }

  let refundAr = 0;
  let orderedUnits = 0;
  let deliveredUnits = 0;
  const restock: { productId: string; qty: number }[] = [];

  for (const l of lines) {
    const done = deliveredBy.get(l.productId) ?? 0;
    const missing = l.qty - done;
    orderedUnits += l.qty;
    deliveredUnits += done;
    if (missing > 0) {
      refundAr += missing * l.unitPriceAr;
      restock.push({ productId: l.productId, qty: missing });
    }
  }

  const status: FinalOrderStatus = deliveredUnits === orderedUnits ? 'DISPENSED' : deliveredUnits === 0 ? 'FAILED' : 'PARTIALLY_DISPENSED';
  return { status, refundAr, restock };
}
