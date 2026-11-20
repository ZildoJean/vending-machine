import type { MoneyConfig } from '@vending/shared';

/** Registre append-only. Montants signés : DEPOSIT et REFUND > 0, PURCHASE < 0. */
export type LedgerEntry =
  | { readonly type: 'DEPOSIT'; readonly amountAr: number; readonly insertionId: string }
  | { readonly type: 'PURCHASE'; readonly amountAr: number; readonly orderId: string }
  | { readonly type: 'REFUND'; readonly amountAr: number; readonly orderId: string };

function assertPositiveInt(n: number, what: string): void {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new RangeError(`Invariant violé : ${what} doit être un entier > 0 (reçu ${String(n)})`);
  }
}

export function depositEntry(amountAr: number, insertionId: string): LedgerEntry {
  assertPositiveInt(amountAr, 'dépôt');
  return { type: 'DEPOSIT', amountAr, insertionId };
}

export function purchaseEntry(totalAr: number, orderId: string): LedgerEntry {
  assertPositiveInt(totalAr, 'achat');
  return { type: 'PURCHASE', amountAr: -totalAr, orderId };
}

export function refundEntry(amountAr: number, orderId: string): LedgerEntry {
  assertPositiveInt(amountAr, 'remboursement');
  return { type: 'REFUND', amountAr, orderId };
}

/**
 * Rejoue le registre dans l'ordre et vérifie les invariants à CHAQUE étape :
 * signe cohérent avec le type, multiples du pas, solde jamais < 0 ni > plafond.
 * Toute violation lève : un registre incohérent est un bug, jamais une entrée utilisateur.
 */
export function balanceOf(entries: readonly LedgerEntry[], cfg: MoneyConfig): number {
  let balance = 0;
  for (const [i, e] of entries.entries()) {
    const a = e.amountAr;
    const bad =
      !Number.isSafeInteger(a) ||
      a === 0 ||
      a % cfg.step !== 0 ||
      (e.type === 'PURCHASE' ? a > 0 : a < 0);
    if (bad) throw new Error(`Invariant violé : entrée de registre invalide (#${i}, ${e.type})`);
    balance += a;
    if (balance < 0 || balance > cfg.walletCap) {
      throw new Error(`Invariant violé : solde hors bornes après l'entrée #${i} (${balance})`);
    }
  }
  return balance;
}
