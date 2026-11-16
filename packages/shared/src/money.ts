/** Tous les montants sont des entiers en ariary (1 = 1 Ar). Jamais de flottant. */

export interface MoneyConfig {
  /** Granularité imposée aux prix, soldes et dépôts. */
  readonly step: number;
  /** Solde maximal du wallet. */
  readonly walletCap: number;
  /** Coupures acceptées par le BillAcceptor (un billet par insertion). */
  readonly acceptedBills: readonly number[];
  /** Mode développement uniquement : accepte tout multiple de `step`. */
  readonly freeAmountMode: boolean;
}

export type AmountError = 'NOT_SAFE_INTEGER' | 'NOT_POSITIVE' | 'NOT_MULTIPLE_OF_STEP';
export type DepositError = AmountError | 'BILL_NOT_ACCEPTED' | 'WALLET_CAP_EXCEEDED';
export type PriceError = AmountError | 'PRICE_ABOVE_CAP';

export const MONEY_CONFIG: MoneyConfig = {
  step: 100,
  walletCap: 100_000,
  acceptedBills: [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000],
  freeAmountMode: false,
};

/** Affichage seulement : "20 000 Ar" (espace insécable). Ne sert jamais à parser. */
export function formatAr(n: number): string {
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`formatAr: entier sûr attendu, reçu ${String(n)}`);
  }
  const sign = n < 0 ? '-' : '';
  const digits = String(Math.abs(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00A0');
  return `${sign}${digits}\u00A0Ar`;
}
