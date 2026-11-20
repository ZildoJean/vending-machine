import { describe, expect, it } from 'vitest';
import { MONEY_CONFIG } from '@vending/shared';
import { balanceOf, depositEntry, purchaseEntry, refundEntry } from './wallet';
import type { LedgerEntry } from './wallet';

const cfg = MONEY_CONFIG;

describe('constructeurs', () => {
  it('signes corrects', () => {
    expect(depositEntry(1_000, 'i1').amountAr).toBe(1_000);
    expect(purchaseEntry(500, 'o1').amountAr).toBe(-500);
    expect(refundEntry(500, 'o1').amountAr).toBe(500);
  });
  it.each([0, -100, 1.5, NaN])('refusent le montant %p', (n) => {
    expect(() => depositEntry(n, 'i')).toThrow(RangeError);
    expect(() => purchaseEntry(n, 'o')).toThrow(RangeError);
    expect(() => refundEntry(n, 'o')).toThrow(RangeError);
  });
});

describe('balanceOf', () => {
  it('registre vide -> 0', () => {
    expect(balanceOf([], cfg)).toBe(0);
  });
  it('rejoue dépôts, achats et remboursements', () => {
    const entries = [depositEntry(5_000, 'i1'), purchaseEntry(3_000, 'o1'), refundEntry(1_000, 'o1'), depositEntry(500, 'i2')];
    expect(balanceOf(entries, cfg)).toBe(3_500);
  });
  it('solde exactement à 0 et exactement au plafond : accepté', () => {
    expect(balanceOf([depositEntry(1_000, 'i'), purchaseEntry(1_000, 'o')], cfg)).toBe(0);
    const full = Array.from({ length: 5 }, (_, i) => depositEntry(20_000, `i${i}`));
    expect(balanceOf(full, cfg)).toBe(100_000);
  });
  it('solde négatif à une étape intermédiaire -> lève (même si le total final est positif)', () => {
    const entries = [purchaseEntry(1_000, 'o1'), depositEntry(5_000, 'i1')];
    expect(() => balanceOf(entries, cfg)).toThrow(/hors bornes/);
  });
  it('dépassement du plafond -> lève', () => {
    const entries = Array.from({ length: 6 }, (_, i) => depositEntry(20_000, `i${i}`));
    expect(() => balanceOf(entries, cfg)).toThrow(/hors bornes/);
  });
  it.each<[string, LedgerEntry]>([
    ['DEPOSIT négatif', { type: 'DEPOSIT', amountAr: -100, insertionId: 'i' }],
    ['PURCHASE positif', { type: 'PURCHASE', amountAr: 100, orderId: 'o' }],
    ['REFUND négatif', { type: 'REFUND', amountAr: -100, orderId: 'o' }],
    ['montant nul', { type: 'DEPOSIT', amountAr: 0, insertionId: 'i' }],
    ['pas multiple de 100', { type: 'DEPOSIT', amountAr: 150, insertionId: 'i' }],
    ['non entier', { type: 'DEPOSIT', amountAr: 100.5, insertionId: 'i' }],
  ])('entrée invalide (%s) -> lève', (_name, entry) => {
    expect(() => balanceOf([entry], cfg)).toThrow(/entrée de registre invalide/);
  });
});
