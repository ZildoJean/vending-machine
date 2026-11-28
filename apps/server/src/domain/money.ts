import { err, ok } from '@vending/shared';
import type { AmountError, DepositError, MoneyConfig, PriceError, Result } from '@vending/shared';

/**
 * Valide un montant venant de l'extérieur (réseau). `unknown` volontaire :
 * "1000", NaN, Infinity, 1e21, 1000.5 ne doivent pas passer.
 * Ordre des contrôles : entier sûr -> positif -> multiple du pas.
 */
export function validateAmount(n: unknown, cfg: MoneyConfig): Result<number, AmountError> {
  if (typeof n !== 'number' || !Number.isSafeInteger(n)) return err('NOT_SAFE_INTEGER');
  if (n <= 0) return err('NOT_POSITIVE');
  if (n % cfg.step !== 0) return err('NOT_MULTIPLE_OF_STEP');
  return ok(n);
}

/**
 * Valide l'insertion d'UN billet. Renvoie le NOUVEAU solde.
 * Un billet qui ferait dépasser le plafond est rejeté en entier (rien n'est crédité).
 * Un solde invalide est un bug (donnée corrompue), pas une erreur utilisateur : on lève.
 */
export function validateDeposit(balance: number, bill: unknown, cfg: MoneyConfig): Result<number, DepositError> {
  assertValidBalance(balance, cfg);

  const amount = validateAmount(bill, cfg);
  if (!amount.ok) return amount;

  if (!cfg.freeAmountMode && !cfg.acceptedBills.includes(amount.value)) {
    return err('BILL_NOT_ACCEPTED');
  }
  const next = balance + amount.value;
  if (next > cfg.walletCap) return err('WALLET_CAP_EXCEEDED');
  return ok(next);
}

/** Valide un prix produit (saisi par l'admin). */
export function validatePrice(price: unknown, cfg: MoneyConfig): Result<number, PriceError> {
  const amount = validateAmount(price, cfg);
  if (!amount.ok) return amount;
  if (amount.value > cfg.walletCap) return err('PRICE_ABOVE_CAP');
  return ok(amount.value);
}

/** Invariant du wallet : entier, >= 0, multiple du pas, <= plafond. */
export function assertValidBalance(balance: number, cfg: MoneyConfig): void {
  if (!Number.isSafeInteger(balance) || balance < 0 || balance % cfg.step !== 0 || balance > cfg.walletCap) {
    throw new Error(`Invariant violé : solde invalide (${String(balance)})`);
  }
}

/** À appeler au démarrage : une configuration incohérente doit empêcher la machine de démarrer. */
export function assertValidMoneyConfig(cfg: MoneyConfig): void {
  const problems: string[] = [];
  if (!Number.isSafeInteger(cfg.step) || cfg.step <= 0) problems.push('step doit être un entier > 0');
  if (!Number.isSafeInteger(cfg.walletCap) || cfg.walletCap <= 0) {
    problems.push('walletCap doit être un entier > 0');
  } else if (cfg.step > 0 && cfg.walletCap % cfg.step !== 0) {
    problems.push('walletCap doit être un multiple de step');
  }
  if (cfg.acceptedBills.length === 0) problems.push('acceptedBills ne doit pas être vide');
  if (new Set(cfg.acceptedBills).size !== cfg.acceptedBills.length) {
    problems.push('acceptedBills contient des doublons');
  }
  for (const b of cfg.acceptedBills) {
    if (!Number.isSafeInteger(b) || b <= 0) problems.push(`coupure invalide : ${String(b)}`);
    else if (cfg.step > 0 && b % cfg.step !== 0) {
      problems.push(`coupure ${b} n'est pas un multiple de step (${cfg.step})`);
    }
    if (b > cfg.walletCap) problems.push(`coupure ${b} supérieure au plafond`);
  }
  if (problems.length > 0) throw new Error(`MoneyConfig invalide : ${problems.join(' ; ')}`);
}
