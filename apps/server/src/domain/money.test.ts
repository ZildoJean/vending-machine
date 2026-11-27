import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { MONEY_CONFIG } from '@vending/shared';
import type { MoneyConfig } from '@vending/shared';
import { assertValidBalance, assertValidMoneyConfig, validateAmount, validateDeposit, validatePrice } from './money';

const cfg = MONEY_CONFIG;
const free: MoneyConfig = { ...cfg, freeAmountMode: true };

describe('validateAmount', () => {
  it.each(['1000', NaN, Infinity, -Infinity, 1e21, 1000.5, null, undefined, {}, [], true])('rejette le non-entier %p', (v) => {
    expect(validateAmount(v, cfg)).toEqual({ ok: false, error: 'NOT_SAFE_INTEGER' });
  });
  it.each([0, -100, -1000])('rejette %i (non positif)', (v) => {
    expect(validateAmount(v, cfg)).toEqual({ ok: false, error: 'NOT_POSITIVE' });
  });
  it.each([1, 99, 101, 1050, 1250])('rejette %i (pas un multiple de 100)', (v) => {
    expect(validateAmount(v, cfg)).toEqual({ ok: false, error: 'NOT_MULTIPLE_OF_STEP' });
  });
  it('accepte un multiple de 100', () => {
    expect(validateAmount(1500, cfg)).toEqual({ ok: true, value: 1500 });
  });
});

describe('validateDeposit', () => {
  it('solde 0 + billet 20 000 -> 20 000', () => {
    expect(validateDeposit(0, 20_000, cfg)).toEqual({ ok: true, value: 20_000 });
  });
  it('accepte chaque coupure de la liste', () => {
    for (const b of cfg.acceptedBills) {
      expect(validateDeposit(0, b, cfg)).toEqual({ ok: true, value: b });
    }
  });

  describe('plafond 100 000', () => {
    it('80 000 + 20 000 atteint exactement le plafond : accepté', () => {
      expect(validateDeposit(80_000, 20_000, cfg)).toEqual({ ok: true, value: 100_000 });
    });
    it('80 100 + 20 000 dépasse : rejeté', () => {
      expect(validateDeposit(80_100, 20_000, cfg)).toEqual({ ok: false, error: 'WALLET_CAP_EXCEEDED' });
    });
    it('80 100 + 10 000 passe encore (le rejet dépend du solde ET de la coupure)', () => {
      expect(validateDeposit(80_100, 10_000, cfg)).toEqual({ ok: true, value: 90_100 });
    });
    it('99 900 + 100 atteint le plafond : accepté', () => {
      expect(validateDeposit(99_900, 100, cfg)).toEqual({ ok: true, value: 100_000 });
    });
    it('99 900 + 200 : rejeté', () => {
      expect(validateDeposit(99_900, 200, cfg)).toEqual({ ok: false, error: 'WALLET_CAP_EXCEEDED' });
    });
    it.each(cfg.acceptedBills)('100 000 + %i : rejeté', (b) => {
      expect(validateDeposit(100_000, b, cfg)).toEqual({ ok: false, error: 'WALLET_CAP_EXCEEDED' });
    });
  });

  describe('liste blanche', () => {
    it('1 500 : multiple de 100 mais pas une coupure -> BILL_NOT_ACCEPTED', () => {
      expect(validateDeposit(0, 1_500, cfg)).toEqual({ ok: false, error: 'BILL_NOT_ACCEPTED' });
    });
    it('1 050 : le contrôle du pas passe avant la liste blanche', () => {
      expect(validateDeposit(0, 1_050, cfg)).toEqual({ ok: false, error: 'NOT_MULTIPLE_OF_STEP' });
    });
    it.each(['1000', NaN, Infinity, -1000, 0, 1000.5])('rejette %p', (v) => {
      expect(validateDeposit(0, v, cfg).ok).toBe(false);
    });
  });

  describe('mode libre (développement)', () => {
    it('accepte 37 700 (multiple de 100, pas une coupure)', () => {
      expect(validateDeposit(0, 37_700, free)).toEqual({ ok: true, value: 37_700 });
    });
    it('rejette toujours 1 050', () => {
      expect(validateDeposit(0, 1_050, free)).toEqual({ ok: false, error: 'NOT_MULTIPLE_OF_STEP' });
    });
    it('respecte toujours le plafond', () => {
      expect(validateDeposit(50_000, 60_000, free)).toEqual({ ok: false, error: 'WALLET_CAP_EXCEEDED' });
    });
  });

  it.each([-100, 150, 100_100, 1.5, NaN])('solde corrompu %p : lève une erreur (bug, pas entrée)', (bad) => {
    expect(() => validateDeposit(bad, 100, cfg)).toThrow(/Invariant/);
  });

  it('PROPRIÉTÉ : solde toujours dans [0, plafond], multiple du pas, et rejet <=> dépassement', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: cfg.walletCap / cfg.step }).map((k) => k * cfg.step),
        fc.constantFrom(...cfg.acceptedBills),
        (balance, bill) => {
          const r = validateDeposit(balance, bill, cfg);
          if (balance + bill > cfg.walletCap) {
            expect(r).toEqual({ ok: false, error: 'WALLET_CAP_EXCEEDED' });
          } else {
            expect(r).toEqual({ ok: true, value: balance + bill });
            if (r.ok) {
              expect(r.value % cfg.step).toBe(0);
              expect(r.value).toBeLessThanOrEqual(cfg.walletCap);
            }
          }
        },
      ),
    );
  });

  it('PROPRIÉTÉ : aucune entrée arbitraire ne produit un solde invalide', () => {
    fc.assert(
      fc.property(fc.anything(), (v) => {
        const r = validateDeposit(0, v, cfg);
        if (r.ok) {
          expect(Number.isSafeInteger(r.value)).toBe(true);
          expect(r.value % cfg.step).toBe(0);
          expect(cfg.acceptedBills).toContain(r.value);
        }
      }),
    );
  });
});

describe('validatePrice', () => {
  it.each([
    [1_250, 'NOT_MULTIPLE_OF_STEP'],
    [0, 'NOT_POSITIVE'],
    [-100, 'NOT_POSITIVE'],
    [100_100, 'PRICE_ABOVE_CAP'],
    ['1000', 'NOT_SAFE_INTEGER'],
  ])('rejette %p -> %s', (v, error) => {
    expect(validatePrice(v, cfg)).toEqual({ ok: false, error });
  });
  it.each([100, 1_500, 100_000])('accepte %i', (v) => {
    expect(validatePrice(v, cfg)).toEqual({ ok: true, value: v });
  });
});

describe('assertValidBalance', () => {
  it.each([0, 100, 100_000])('accepte %i', (b) => {
    expect(() => assertValidBalance(b, cfg)).not.toThrow();
  });
});

describe('assertValidMoneyConfig', () => {
  it('accepte la configuration par défaut', () => {
    expect(() => assertValidMoneyConfig(cfg)).not.toThrow();
  });
  it("détecte une coupure qui n'est pas multiple du pas (ex. 150)", () => {
    expect(() => assertValidMoneyConfig({ ...cfg, acceptedBills: [...cfg.acceptedBills, 150] })).toThrow(/150/);
  });
  it('détecte un doublon', () => {
    expect(() => assertValidMoneyConfig({ ...cfg, acceptedBills: [100, 100] })).toThrow(/doublons/);
  });
  it('détecte une liste vide', () => {
    expect(() => assertValidMoneyConfig({ ...cfg, acceptedBills: [] })).toThrow(/vide/);
  });
  it('détecte un plafond non multiple du pas', () => {
    expect(() => assertValidMoneyConfig({ ...cfg, walletCap: 100_050 })).toThrow(/walletCap/);
  });
  it('détecte une coupure supérieure au plafond', () => {
    expect(() => assertValidMoneyConfig({ ...cfg, acceptedBills: [200_000] })).toThrow(/plafond/);
  });
  it('détecte un pas invalide', () => {
    expect(() => assertValidMoneyConfig({ ...cfg, step: 0 })).toThrow(/step/);
  });
});
