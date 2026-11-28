import type { Cart } from './cart-model';
import { uuid } from './uuid';

const fingerprint = (cart: Cart): string => JSON.stringify(Object.entries(cart).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

/**
 * Une clé par panier : la même tentative rejouée (réponse perdue) réutilise la clé, donc ne peut
 * pas être débitée deux fois ; un panier modifié obtient une nouvelle clé.
 */
export class IdempotencyKeys {
  private current: { fp: string; key: string } | null = null;
  keyFor(cart: Cart): string {
    const fp = fingerprint(cart);
    if (this.current === null || this.current.fp !== fp) this.current = { fp, key: `order-${uuid()}` };
    return this.current.key;
  }
  reset(): void {
    this.current = null;
  }
}
