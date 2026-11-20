import { err, ok } from '@vending/shared';
import type { CheckoutFailure, MoneyConfig, QuoteFailure, Result } from '@vending/shared';
import { assertValidBalance, validatePrice } from './money';

export interface Product {
  readonly id: string;
  readonly name: string;
  readonly priceAr: number;
  readonly stock: number;
  readonly active: boolean;
}

/** Ligne telle que reçue du réseau : rien n'est supposé. Tout prix éventuel est ignoré. */
export interface RawCartLine {
  readonly productId: unknown;
  readonly qty: unknown;
}

export interface QuoteLine {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceAr: number;
  readonly lineTotalAr: number;
}

export interface Quote {
  readonly lines: readonly QuoteLine[];
  readonly totalAr: number;
}

function indexProducts(products: readonly Product[]): Map<string, Product> {
  const byId = new Map<string, Product>();
  for (const p of products) {
    if (byId.has(p.id)) throw new Error(`Invariant violé : produit en double (${p.id})`);
    byId.set(p.id, p);
  }
  return byId;
}

/** Un produit vendable avec un prix ou un stock invalide est un bug de données, pas une erreur client. */
function assertSellable(p: Product, cfg: MoneyConfig): void {
  if (!validatePrice(p.priceAr, cfg).ok || !Number.isSafeInteger(p.stock) || p.stock < 0) {
    throw new Error(`Invariant violé : produit invalide (${p.id})`);
  }
}

/**
 * Recalcule le devis depuis les produits de la base ; le client ne fournit jamais de prix.
 * Contrôles par ligne, dans l'ordre : quantité -> doublon -> inconnu -> inactif -> stock.
 * La première erreur rencontrée (dans l'ordre des lignes) est renvoyée.
 * Le plafond n'est évalué qu'une fois toutes les lignes valides.
 */
export function quoteCart(
  cart: readonly RawCartLine[],
  products: readonly Product[],
  cfg: MoneyConfig,
): Result<Quote, QuoteFailure> {
  if (cart.length === 0) return err({ code: 'EMPTY_CART' });

  const byId = indexProducts(products);
  const seen = new Set<string>();
  const lines: QuoteLine[] = [];
  let total = 0;

  for (const [lineIndex, raw] of cart.entries()) {
    const qty = raw.qty;
    if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty <= 0) {
      return err({ code: 'INVALID_QTY', lineIndex });
    }
    const id = raw.productId;
    if (typeof id === 'string' && seen.has(id)) return err({ code: 'DUPLICATE_LINE', lineIndex });

    const product = typeof id === 'string' ? byId.get(id) : undefined;
    if (product === undefined) return err({ code: 'UNKNOWN_PRODUCT', lineIndex });
    seen.add(product.id);

    if (!product.active) return err({ code: 'INACTIVE_PRODUCT', lineIndex });
    assertSellable(product, cfg);
    if (qty > product.stock) return err({ code: 'INSUFFICIENT_STOCK', lineIndex });

    const lineTotalAr = product.priceAr * qty;
    total += lineTotalAr;
    lines.push({ productId: product.id, qty, unitPriceAr: product.priceAr, lineTotalAr });
  }

  if (total > cfg.walletCap) return err({ code: 'CART_EXCEEDS_CAP', totalAr: total });
  return ok({ lines, totalAr: total });
}

/**
 * Devis + vérification du solde. CART_EXCEEDS_CAP est prioritaire sur INSUFFICIENT_FUNDS :
 * demander "insérez plus d'argent" pour un panier impayable serait faux.
 * `balance` invalide => exception (bug de registre).
 */
export function validateCheckout(
  cart: readonly RawCartLine[],
  products: readonly Product[],
  balance: number,
  cfg: MoneyConfig,
): Result<Quote, CheckoutFailure> {
  assertValidBalance(balance, cfg);
  const quote = quoteCart(cart, products, cfg);
  if (!quote.ok) return quote;
  if (quote.value.totalAr > balance) {
    return err({
      code: 'INSUFFICIENT_FUNDS',
      totalAr: quote.value.totalAr,
      missingAr: quote.value.totalAr - balance,
    });
  }
  return quote;
}
