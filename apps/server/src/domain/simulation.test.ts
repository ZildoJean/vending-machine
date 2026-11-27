import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MONEY_CONFIG } from '@vending/shared';
import { quoteCart, validateCheckout } from './cart';
import type { Product } from './cart';
import { validateDeposit } from './money';
import { planRefund } from './refund';
import { balanceOf, depositEntry, purchaseEntry, refundEntry } from './wallet';
import type { LedgerEntry } from './wallet';

/**
 * Mini-simulateur : compose les fonctions du domaine sur des suites aléatoires d'opérations
 * et vérifie des invariants calculés INDÉPENDAMMENT (compteurs de l'oracle, pas le registre).
 * Il teste la cohérence du domaine, pas la base de données ni la concurrence.
 */
const cfg = MONEY_CONFIG;
const INITIAL: readonly Product[] = [
  { id: 'cola', name: 'cola', priceAr: 1_500, stock: 4, active: true },
  { id: 'eau', name: 'eau', priceAr: 500, stock: 6, active: true },
  { id: 'luxe', name: 'luxe', priceAr: 12_000, stock: 3, active: true },
];
const IDS = ['cola', 'eau', 'luxe', 'fantome'] as const;

type Op = { kind: 'deposit'; bill: number } | { kind: 'checkout'; lines: { id: number; qty: number }[]; seeds: number[] };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.record({
    kind: fc.constant('deposit' as const),
    bill: fc.oneof(fc.constantFrom(...cfg.acceptedBills), fc.integer({ min: -500, max: 30_000 })),
  }),
  fc.record({
    kind: fc.constant('checkout' as const),
    lines: fc.array(fc.record({ id: fc.integer({ min: 0, max: 3 }), qty: fc.integer({ min: -1, max: 6 }) }), { maxLength: 4 }),
    seeds: fc.array(fc.nat(), { maxLength: 4 }),
  }),
);

describe("simulation : conservation de l'argent et du stock", () => {
  it("PROPRIÉTÉ : sur toute suite d'opérations, les invariants tiennent à chaque étape", () => {
    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 60 }), (ops) => {
        const stock = new Map(INITIAL.map((p) => [p.id, p.stock]));
        const price = new Map(INITIAL.map((p) => [p.id, p.priceAr]));
        const out = new Map(INITIAL.map((p) => [p.id, 0]));
        const ledger: LedgerEntry[] = [];
        let balance = 0;
        let inserted = 0;
        let spent = 0;
        let refunded = 0;
        let n = 0;

        const snapshot = (): Product[] => INITIAL.map((p) => ({ ...p, stock: stock.get(p.id) ?? 0 }));

        for (const op of ops) {
          n += 1;
          if (op.kind === 'deposit') {
            const r = validateDeposit(balance, op.bill, cfg);
            if (r.ok) {
              ledger.push(depositEntry(op.bill, `ins${n}`));
              balance = r.value;
              inserted += op.bill;
            }
          } else {
            const cart = op.lines.map((l) => ({ productId: IDS[l.id], qty: l.qty }));
            const r = validateCheckout(cart, snapshot(), balance, cfg);
            if (r.ok) {
              const { lines, totalAr } = r.value;
              ledger.push(purchaseEntry(totalAr, `o${n}`));
              balance -= totalAr;
              spent += totalAr;
              for (const l of lines) stock.set(l.productId, (stock.get(l.productId) ?? 0) - l.qty);

              const delivered = lines.map((l, i) => ({
                productId: l.productId,
                count: (op.seeds[i] ?? 0) % (l.qty + 1),
              }));
              const plan = planRefund(lines, delivered);
              if (plan.refundAr > 0) {
                ledger.push(refundEntry(plan.refundAr, `o${n}`));
                balance += plan.refundAr;
                refunded += plan.refundAr;
              }
              for (const rs of plan.restock) stock.set(rs.productId, (stock.get(rs.productId) ?? 0) + rs.qty);
              for (const d of delivered) out.set(d.productId, (out.get(d.productId) ?? 0) + d.count);
            }
          }

          // 1. le registre rejoué (qui vérifie ses propres bornes) == solde suivi
          expect(balanceOf(ledger, cfg)).toBe(balance);
          // 2. conservation : argent inséré = solde + argent encaissé net
          expect(inserted).toBe(balance + (spent - refunded));
          // 3. l'argent gardé = valeur exacte des boissons réellement délivrées
          let value = 0;
          for (const [id, count] of out) value += count * (price.get(id) ?? 0);
          expect(spent - refunded).toBe(value);
          // 4. stock : rien de créé ni de perdu, jamais négatif
          for (const p of INITIAL) {
            const s = stock.get(p.id) ?? 0;
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s + (out.get(p.id) ?? 0)).toBe(p.stock);
          }
          // 5. solde dans les bornes et multiple du pas
          expect(balance % cfg.step).toBe(0);
          expect(balance).toBeGreaterThanOrEqual(0);
          expect(balance).toBeLessThanOrEqual(cfg.walletCap);
        }
      }),
      { numRuns: 300 },
    );
  });

  it("garde-fou : l'oracle détecterait une fuite (remboursement oublié)", () => {
    // Si on ne rembourse pas les unités non livrées, "argent gardé" != "valeur livrée".
    const lines = [{ productId: 'cola', qty: 2, unitPriceAr: 1_500, lineTotalAr: 3_000 }];
    const plan = planRefund(lines, [{ productId: 'cola', count: 1 }]);
    const keptWithRefund = 3_000 - plan.refundAr;
    const keptWithoutRefund = 3_000;
    const valueDelivered = 1 * 1_500;
    expect(keptWithRefund).toBe(valueDelivered);
    expect(keptWithoutRefund).not.toBe(valueDelivered);
    expect(
      quoteCart(
        lines.map((l) => ({ productId: l.productId, qty: l.qty })),
        INITIAL,
        cfg,
      ).ok,
    ).toBe(true);
  });
});
