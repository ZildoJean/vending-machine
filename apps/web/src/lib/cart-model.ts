import type { ProductDto } from '@vending/shared';

/** productId -> quantité (> 0). Jamais de quantité nulle ou supérieure au stock affiché. */
export type Cart = Readonly<Record<string, number>>;

export type CartStatus =
  | { readonly kind: 'EMPTY' }
  | { readonly kind: 'OK'; readonly totalAr: number }
  | { readonly kind: 'NEED_MONEY'; readonly totalAr: number; readonly missingAr: number }
  | { readonly kind: 'OVER_CAP'; readonly totalAr: number };

/** Fixe la quantité d'un produit, bornée à [0, stock] et entière. NaN/Infinity : panier inchangé. */
export function setQty(cart: Cart, product: ProductDto, qty: number): Cart {
  if (!Number.isFinite(qty)) return cart;
  const q = Math.min(Math.max(0, Math.floor(qty)), Math.max(0, product.stock));
  const { [product.id]: _removed, ...rest } = cart;
  void _removed;
  return q === 0 ? rest : { ...rest, [product.id]: q };
}

/** Retire les produits disparus et ramène les quantités au stock courant (le stock peut avoir baissé). */
export function prune(cart: Cart, products: readonly ProductDto[]): Cart {
  const byId = new Map(products.map((p) => [p.id, p]));
  let next: Cart = {};
  for (const [id, qty] of Object.entries(cart)) {
    const p = byId.get(id);
    if (p !== undefined) next = setQty(next, p, qty);
  }
  const same = Object.keys(next).length === Object.keys(cart).length && Object.entries(next).every(([k, v]) => cart[k] === v);
  return same ? cart : next;
}

export function cartLines(cart: Cart): { productId: string; qty: number }[] {
  return Object.entries(cart).map(([productId, qty]) => ({ productId, qty }));
}

export function totalOf(cart: Cart, products: readonly ProductDto[]): number {
  const byId = new Map(products.map((p) => [p.id, p]));
  return Object.entries(cart).reduce((sum, [id, qty]) => sum + (byId.get(id)?.priceAr ?? 0) * qty, 0);
}

/** Même priorité que le serveur : plafond avant solde. Indicatif : le serveur reste juge. */
export function cartStatus(cart: Cart, products: readonly ProductDto[], balanceAr: number, walletCapAr: number): CartStatus {
  if (Object.keys(cart).length === 0) return { kind: 'EMPTY' };
  const totalAr = totalOf(cart, products);
  if (totalAr > walletCapAr) return { kind: 'OVER_CAP', totalAr };
  if (totalAr > balanceAr) return { kind: 'NEED_MONEY', totalAr, missingAr: totalAr - balanceAr };
  return { kind: 'OK', totalAr };
}
