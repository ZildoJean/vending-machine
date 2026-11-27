import type { Product } from '../domain/cart';
import { toOutcome } from './checkout-service';
import type { CheckoutOutcome } from './checkout-service';
import type { UnitOfWork } from './ports';

/** Lectures du client connecté (aucune écriture, aucun verrou de machine). */
export class ClientQueries {
  constructor(private readonly uow: UnitOfWork) {}

  products(): Promise<Product[]> {
    return this.uow.run((tx) => tx.catalog.listActive());
  }
  balance(userId: string): Promise<number> {
    return this.uow.run((tx) => tx.wallet.balance(userId));
  }
  async lastOrder(userId: string): Promise<CheckoutOutcome | null> {
    return this.uow.run(async (tx) => {
      const order = await tx.orders.findLastByUser(userId);
      return order === null ? null : toOutcome(order, await tx.wallet.balance(userId), true);
    });
  }
}
