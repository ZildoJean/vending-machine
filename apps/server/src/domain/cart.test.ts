import { describe, expect, it } from 'vitest';
import { MONEY_CONFIG } from '@vending/shared';
import { quoteCart, validateCheckout } from './cart';
import type { Product, RawCartLine } from './cart';

const cfg = MONEY_CONFIG;
const p = (id: string, priceAr: number, stock: number, active = true): Product => ({
  id, name: id, priceAr, stock, active,
});
const COLA = p('cola', 1_500, 5);
const EAU = p('eau', 500, 3);
const RARE = p('rare', 2_000, 1);
const OFF = p('off', 1_000, 0, false);
const OFF_STOCK = p('off2', 1_000, 4, false);
const EMPTY = p('vide', 1_000, 0);
const LUXE = p('luxe', 12_000, 20);
const products = [COLA, EAU, RARE, OFF, OFF_STOCK, EMPTY, LUXE];
const line = (productId: unknown, qty: unknown): RawCartLine => ({ productId, qty });

describe('quoteCart', () => {
  it('total = somme prix x qty sur plusieurs lignes et unités', () => {
    const r = quoteCart([line('cola', 2), line('eau', 3)], products, cfg);
    expect(r).toEqual({
      ok: true,
      value: {
        totalAr: 4_500,
        lines: [
          { productId: 'cola', qty: 2, unitPriceAr: 1_500, lineTotalAr: 3_000 },
          { productId: 'eau', qty: 3, unitPriceAr: 500, lineTotalAr: 1_500 },
        ],
      },
    });
  });

  it('ignore tout prix fourni par le client', () => {
    const sneaky = { productId: 'cola', qty: 1, priceAr: 1, unitPriceAr: 1 } as unknown as RawCartLine;
    const r = quoteCart([sneaky], products, cfg);
    expect(r.ok && r.value.totalAr).toBe(1_500);
  });

  it('panier vide', () => {
    expect(quoteCart([], products, cfg)).toEqual({ ok: false, error: { code: 'EMPTY_CART' } });
  });

  it.each([0, -1, 1.5, '2', NaN, Infinity, 1e21, null, undefined])('quantité %p -> INVALID_QTY', (q) => {
    expect(quoteCart([line('cola', q)], products, cfg)).toEqual({
      ok: false,
      error: { code: 'INVALID_QTY', lineIndex: 0 },
    });
  });

  it('même produit sur deux lignes -> DUPLICATE_LINE (indice de la 2e)', () => {
    expect(quoteCart([line('cola', 1), line('eau', 1), line('cola', 1)], products, cfg)).toEqual({
      ok: false,
      error: { code: 'DUPLICATE_LINE', lineIndex: 2 },
    });
  });

  it.each(['fantome', 42, null, undefined, {}])('produit %p -> UNKNOWN_PRODUCT', (id) => {
    expect(quoteCart([line(id, 1)], products, cfg)).toEqual({
      ok: false,
      error: { code: 'UNKNOWN_PRODUCT', lineIndex: 0 },
    });
  });

  it('produit inactif -> INACTIVE_PRODUCT', () => {
    expect(quoteCart([line('off', 1)], products, cfg)).toEqual({
      ok: false,
      error: { code: 'INACTIVE_PRODUCT', lineIndex: 0 },
    });
  });

  describe('stock', () => {
    it('qty = stock accepté', () => {
      expect(quoteCart([line('cola', 5)], products, cfg).ok).toBe(true);
    });
    it('qty = stock + 1 -> INSUFFICIENT_STOCK', () => {
      expect(quoteCart([line('cola', 6)], products, cfg)).toEqual({
        ok: false,
        error: { code: 'INSUFFICIENT_STOCK', lineIndex: 0 },
      });
    });
    it('stock 0 -> INSUFFICIENT_STOCK', () => {
      expect(quoteCart([line('vide', 1)], products, cfg)).toEqual({
        ok: false,
        error: { code: 'INSUFFICIENT_STOCK', lineIndex: 0 },
      });
    });
  });

  describe('priorité des erreurs (déterministe)', () => {
    it('quantité invalide avant produit inconnu sur la même ligne', () => {
      const r = quoteCart([line('fantome', 0)], products, cfg);
      expect(!r.ok && r.error.code).toBe('INVALID_QTY');
    });
    it('inactif avant stock', () => {
      const r = quoteCart([line('off2', 99)], products, cfg);
      expect(!r.ok && r.error.code).toBe('INACTIVE_PRODUCT');
    });
    it('première erreur dans l\'ordre des lignes', () => {
      const r = quoteCart([line('cola', 1), line('fantome', 1), line('eau', 0)], products, cfg);
      expect(r).toEqual({ ok: false, error: { code: 'UNKNOWN_PRODUCT', lineIndex: 1 } });
    });
    it('une erreur de ligne passe avant CART_EXCEEDS_CAP', () => {
      const r = quoteCart([line('luxe', 20), line('cola', 99)], products, cfg);
      expect(!r.ok && r.error.code).toBe('INSUFFICIENT_STOCK');
    });
  });

  describe('plafond du wallet', () => {
    it('total = plafond accepté', () => {
      const r = quoteCart([line('luxe', 8), line('eau', 8)], [LUXE, p('eau', 500, 8)], cfg);
      expect(r.ok && r.value.totalAr).toBe(100_000);
    });
    it('total > plafond -> CART_EXCEEDS_CAP avec le total', () => {
      expect(quoteCart([line('luxe', 10)], products, cfg)).toEqual({
        ok: false,
        error: { code: 'CART_EXCEEDS_CAP', totalAr: 120_000 },
      });
    });
  });

  describe('invariants de données (bugs, pas erreurs client)', () => {
    it('produits en double dans la base -> lève', () => {
      expect(() => quoteCart([line('cola', 1)], [COLA, COLA], cfg)).toThrow(/double/);
    });
    it('produit référencé avec prix invalide -> lève', () => {
      expect(() => quoteCart([line('bad', 1)], [p('bad', 1_250, 5)], cfg)).toThrow(/invalide/);
    });
    it('produit référencé avec stock négatif -> lève', () => {
      expect(() => quoteCart([line('bad', 1)], [p('bad', 1_000, -1)], cfg)).toThrow(/invalide/);
    });
    it('produit corrompu non référencé -> sans effet', () => {
      expect(quoteCart([line('cola', 1)], [COLA, p('bad', 1_250, -1)], cfg).ok).toBe(true);
    });
  });
});

describe('validateCheckout', () => {
  it('total = solde -> accepté', () => {
    expect(validateCheckout([line('cola', 2)], products, 3_000, cfg).ok).toBe(true);
  });
  it('total = solde + 100 -> INSUFFICIENT_FUNDS avec montant manquant', () => {
    expect(validateCheckout([line('cola', 2)], products, 2_900, cfg)).toEqual({
      ok: false,
      error: { code: 'INSUFFICIENT_FUNDS', totalAr: 3_000, missingAr: 100 },
    });
  });
  it('solde 0 : tout manque', () => {
    const r = validateCheckout([line('eau', 1)], products, 0, cfg);
    expect(r).toEqual({ ok: false, error: { code: 'INSUFFICIENT_FUNDS', totalAr: 500, missingAr: 500 } });
  });
  it('CART_EXCEEDS_CAP prioritaire sur INSUFFICIENT_FUNDS, même avec solde 0', () => {
    const r = validateCheckout([line('luxe', 10)], products, 0, cfg);
    expect(!r.ok && r.error.code).toBe('CART_EXCEEDS_CAP');
  });
  it('total = plafond avec solde = plafond -> accepté', () => {
    const r = validateCheckout([line('luxe', 8), line('eau', 8)], [LUXE, p('eau', 500, 8)], 100_000, cfg);
    expect(r.ok).toBe(true);
  });
  it('les erreurs de panier remontent telles quelles', () => {
    const r = validateCheckout([], products, 1_000, cfg);
    expect(r).toEqual({ ok: false, error: { code: 'EMPTY_CART' } });
  });
  it.each([-100, 150, 100_100, NaN])('solde corrompu %p -> lève', (b) => {
    expect(() => validateCheckout([line('cola', 1)], products, b, cfg)).toThrow(/Invariant/);
  });
});
