import { describe, expect, it } from 'vitest';
import { planRefund } from './refund';
import type { QuoteLine } from './cart';

const L = (productId: string, qty: number, unitPriceAr: number): QuoteLine => ({
  productId, qty, unitPriceAr, lineTotalAr: qty * unitPriceAr,
});
const lines = [L('cola', 1, 1_500), L('eau', 1, 500), L('jus', 1, 2_000)];

describe('planRefund', () => {
  it('3 sur 3 -> DISPENSED, rien à rembourser', () => {
    const r = planRefund(lines, [
      { productId: 'cola', count: 1 }, { productId: 'eau', count: 1 }, { productId: 'jus', count: 1 },
    ]);
    expect(r).toEqual({ status: 'DISPENSED', refundAr: 0, restock: [] });
  });

  it('0 sur 3 -> FAILED, remboursement total et stock restauré en entier', () => {
    expect(planRefund(lines, [])).toEqual({
      status: 'FAILED',
      refundAr: 4_000,
      restock: [
        { productId: 'cola', qty: 1 }, { productId: 'eau', qty: 1 }, { productId: 'jus', qty: 1 },
      ],
    });
  });

  it('comptes à 0 explicites équivalent à l\'absence de livraison', () => {
    const r = planRefund(lines, lines.map((l) => ({ productId: l.productId, count: 0 })));
    expect(r.status).toBe('FAILED');
    expect(r.refundAr).toBe(4_000);
  });

  it('1 sur 3 (produits différents) -> PARTIALLY_DISPENSED, prix figé des 2 non livrées', () => {
    expect(planRefund(lines, [{ productId: 'cola', count: 1 }])).toEqual({
      status: 'PARTIALLY_DISPENSED',
      refundAr: 2_500,
      restock: [{ productId: 'eau', qty: 1 }, { productId: 'jus', qty: 1 }],
    });
  });

  it('livraison partielle au sein d\'une même ligne (3 colas, 1 livré)', () => {
    expect(planRefund([L('cola', 3, 1_500)], [{ productId: 'cola', count: 1 }])).toEqual({
      status: 'PARTIALLY_DISPENSED',
      refundAr: 3_000,
      restock: [{ productId: 'cola', qty: 2 }],
    });
  });

  it('utilise le prix figé de la ligne, pas un prix courant', () => {
    const r = planRefund([L('cola', 2, 1_000)], []);
    expect(r.refundAr).toBe(2_000);
  });

  it('le remboursement est toujours un multiple de 100', () => {
    const r = planRefund(lines, [{ productId: 'eau', count: 1 }]);
    expect(r.refundAr % 100).toBe(0);
  });

  describe('incohérences = bug du dispenser -> lève, jamais de remboursement négatif', () => {
    it('livré > commandé', () => {
      expect(() => planRefund(lines, [{ productId: 'cola', count: 2 }])).toThrow(/invalide/);
    });
    it.each([-1, 0.5, NaN])('compte %p', (count) => {
      expect(() => planRefund(lines, [{ productId: 'cola', count }])).toThrow(/invalide/);
    });
    it('produit livré hors commande', () => {
      expect(() => planRefund(lines, [{ productId: 'fantome', count: 1 }])).toThrow(/hors commande/);
    });
    it('livraison en double pour un même produit', () => {
      expect(() =>
        planRefund(lines, [{ productId: 'cola', count: 1 }, { productId: 'cola', count: 1 }]),
      ).toThrow(/double/);
    });
    it('commande sans ligne', () => {
      expect(() => planRefund([], [])).toThrow(/sans ligne/);
    });
    it('lignes en double dans la commande', () => {
      expect(() => planRefund([L('cola', 1, 1_500), L('cola', 1, 1_500)], [])).toThrow(/double/);
    });
  });
});
