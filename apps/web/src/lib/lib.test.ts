import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ProductDto } from '@vending/shared';
import { canInsert } from './bills';
import { cartLines, cartStatus, prune, setQty, totalOf } from './cart-model';
import type { Cart } from './cart-model';
import { formatMmSs, remainingAt } from './countdown';
import { IdempotencyKeys } from './idempotency';
import { uuid } from './uuid';

const P = (id: string, priceAr: number, stock: number): ProductDto => ({ id, name: id, priceAr, stock });
const cola = P('cola', 1_500, 5);
const eau = P('eau', 500, 2);
const none = P('none', 700, 0);
const products = [cola, eau, none];

describe('setQty', () => {
  it('borne à [0, stock], entier, retire à 0', () => {
    expect(setQty({}, cola, 3)).toEqual({ cola: 3 });
    expect(setQty({}, cola, 99)).toEqual({ cola: 5 });
    expect(setQty({ cola: 3 }, cola, 0)).toEqual({});
    expect(setQty({ cola: 3 }, cola, -4)).toEqual({});
    expect(setQty({}, cola, 2.9)).toEqual({ cola: 2 });
    expect(setQty({}, none, 1)).toEqual({}); // épuisé : jamais dans le panier
  });
  it('NaN et Infinity : panier inchangé (même référence)', () => {
    const c: Cart = { cola: 2 };
    expect(setQty(c, cola, NaN)).toBe(c);
    expect(setQty(c, cola, Infinity)).toBe(c);
  });
  it("ne modifie pas le panier d'origine", () => {
    const c: Cart = { cola: 2 };
    setQty(c, eau, 1);
    expect(c).toEqual({ cola: 2 });
  });
});

describe('prune', () => {
  it('retire les produits disparus, ramène au stock courant', () => {
    expect(prune({ cola: 5, eau: 2, ghost: 1 }, [P('cola', 1_500, 3), eau])).toEqual({ cola: 3, eau: 2 });
  });
  it('rien à changer : même référence', () => {
    const c: Cart = { cola: 2 };
    expect(prune(c, products)).toBe(c);
  });
  it('un produit passé à 0 en stock sort du panier', () => {
    expect(prune({ cola: 2 }, [P('cola', 1_500, 0)])).toEqual({});
  });
});

describe('cartStatus', () => {
  const cap = 100_000;
  it('vide', () => expect(cartStatus({}, products, 5_000, cap)).toEqual({ kind: 'EMPTY' }));
  it('OK : total = solde accepté', () => expect(cartStatus({ cola: 2 }, products, 3_000, cap)).toEqual({ kind: 'OK', totalAr: 3_000 }));
  it('NEED_MONEY avec le montant manquant exact', () =>
    expect(cartStatus({ cola: 2 }, products, 2_900, cap)).toEqual({ kind: 'NEED_MONEY', totalAr: 3_000, missingAr: 100 }));
  it('OVER_CAP prioritaire sur NEED_MONEY (comme le serveur)', () => {
    const big = [P('luxe', 12_000, 20)];
    expect(cartStatus({ luxe: 10 }, big, 0, cap)).toEqual({ kind: 'OVER_CAP', totalAr: 120_000 });
  });
  it('total = plafond : encore possible', () => {
    const big = [P('luxe', 10_000, 20)];
    expect(cartStatus({ luxe: 10 }, big, cap, cap)).toEqual({ kind: 'OK', totalAr: 100_000 });
  });
  it('cartLines reflète le panier', () =>
    expect(cartLines({ cola: 2, eau: 1 })).toEqual([
      { productId: 'cola', qty: 2 },
      { productId: 'eau', qty: 1 },
    ]));
});

describe('PROPRIÉTÉS du panier', () => {
  const prodArb = fc
    .array(
      fc.record({
        id: fc.constantFrom('a', 'b', 'c', 'd'),
        price: fc.integer({ min: 1, max: 200 }).map((n) => n * 100),
        stock: fc.integer({ min: 0, max: 6 }),
      }),
      { minLength: 1, maxLength: 4 },
    )
    .map((l) => [...new Map(l.map((p) => [p.id, P(p.id, p.price, p.stock)])).values()]);
  it("quelle que soit la suite d'opérations : quantités entières dans [1, stock], total = somme", () => {
    fc.assert(
      fc.property(prodArb, fc.array(fc.tuple(fc.nat(3), fc.integer({ min: -3, max: 12 })), { maxLength: 20 }), (ps, ops) => {
        let cart: Cart = {};
        for (const [i, q] of ops) {
          const p = ps[i % ps.length] as ProductDto;
          cart = setQty(cart, p, q);
        }
        let sum = 0;
        for (const [id, q] of Object.entries(cart)) {
          const p = ps.find((x) => x.id === id) as ProductDto;
          expect(Number.isInteger(q)).toBe(true);
          expect(q).toBeGreaterThanOrEqual(1);
          expect(q).toBeLessThanOrEqual(p.stock);
          sum += p.priceAr * q;
        }
        expect(totalOf(cart, ps)).toBe(sum);
        const st = cartStatus(cart, ps, 50_000, 100_000);
        if (st.kind === 'OK') expect(st.totalAr).toBeLessThanOrEqual(50_000);
        // prune est idempotent
        expect(prune(prune(cart, ps), ps)).toEqual(prune(cart, ps));
      }),
    );
  });
});

describe('canInsert', () => {
  it.each([
    [0, 20_000, true],
    [80_000, 20_000, true],
    [80_100, 20_000, false],
    [99_900, 100, true],
    [100_000, 100, false],
  ])('solde %i + billet %i -> %s', (b, bill, ok) => expect(canInsert(b, bill, 100_000)).toBe(ok));
});

describe('IdempotencyKeys', () => {
  it('même panier : même clé ; panier modifié : nouvelle clé ; reset : nouvelle clé', () => {
    const k = new IdempotencyKeys();
    const a = k.keyFor({ cola: 2, eau: 1 });
    expect(k.keyFor({ eau: 1, cola: 2 })).toBe(a); // ordre sans importance
    expect(k.keyFor({ cola: 3, eau: 1 })).not.toBe(a);
    const b = k.keyFor({ cola: 3, eau: 1 });
    k.reset();
    expect(k.keyFor({ cola: 3, eau: 1 })).not.toBe(b);
  });
  it('la clé respecte la contrainte serveur (8 à 100 caractères)', () => {
    const key = new IdempotencyKeys().keyFor({ a: 1 });
    expect(key.length).toBeGreaterThanOrEqual(8);
    expect(key.length).toBeLessThanOrEqual(100);
  });
});

describe('countdown', () => {
  it('remainingAt décroît avec le temps et ne descend pas sous 0', () => {
    expect(remainingAt(120_000, 1_000, 1_000)).toBe(120_000);
    expect(remainingAt(120_000, 1_000, 31_000)).toBe(90_000);
    expect(remainingAt(120_000, 1_000, 999_999)).toBe(0);
  });
  it("jamais plus que la mesure serveur, même si l'horloge d'affichage est en retard", () => {
    expect(remainingAt(900_000, 5_000, 4_200)).toBe(900_000);
    expect(formatMmSs(remainingAt(900_000, 5_000, 4_200))).toBe('15:00');
  });
  it.each([
    [120_000, '2:00'],
    [119_001, '2:00'],
    [90_000, '1:30'],
    [59_999, '1:00'],
    [5_000, '0:05'],
    [1, '0:01'],
    [0, '0:00'],
    [-5, '0:00'],
  ])('formatMmSs(%i) = %s', (ms, s) => expect(formatMmSs(ms)).toBe(s));
});

describe('uuid', () => {
  it('v4 valide et différents', () => {
    const re = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = uuid();
    expect(a).toMatch(re);
    expect(uuid()).not.toBe(a);
  });
  it('repli sans crypto.randomUUID : toujours un v4 valide', () => {
    const orig = globalThis.crypto.randomUUID;
    // @ts-expect-error simulation d'un environnement sans randomUUID
    globalThis.crypto.randomUUID = undefined;
    try {
      expect(uuid()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    } finally {
      globalThis.crypto.randomUUID = orig;
    }
  });
});
