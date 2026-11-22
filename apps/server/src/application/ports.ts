import type { Product, Quote } from '../domain/cart';
import type { MachineState } from '../domain/machine-state';

export interface MachineStateStore {
  /** Lecture SANS verrou (affichage seulement : peut être périmée dès le retour). */
  load(): Promise<MachineState>;
  /** Lecture AVEC verrou jusqu'à la fin de la transaction : obligatoire avant toute décision. */
  loadForUpdate(): Promise<MachineState>;
  save(state: MachineState): Promise<void>;
}

export type OrderStatus = 'PENDING_DISPENSE' | 'DISPENSED' | 'PARTIALLY_DISPENSED' | 'FAILED';

export interface OrderItemRecord {
  readonly productId: string;
  readonly qty: number;
  readonly unitPriceAr: number;
  readonly deliveredQty: number;
}
export interface OrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly status: OrderStatus;
  readonly totalAr: number;
  readonly refundedAr: number;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly finishedAt: number | null;
  /** Triées par productId (ordre de distribution déterministe). */
  readonly items: readonly OrderItemRecord[];
}
export interface NewOrder {
  readonly userId: string;
  readonly idempotencyKey: string;
  readonly createdAt: number;
  readonly quote: Quote;
}
export interface OrderFinish {
  readonly status: Exclude<OrderStatus, 'PENDING_DISPENSE'>;
  readonly refundedAr: number;
  readonly finishedAt: number;
  readonly restock: readonly { readonly productId: string; readonly qty: number }[];
}

export interface OrderStore {
  findByKey(userId: string, idempotencyKey: string): Promise<OrderRecord | null>;
  findById(orderId: string, opts: { readonly lock: boolean }): Promise<OrderRecord | null>;
  findPendingId(): Promise<string | null>;
  /** Insère la commande, ses lignes (prix figés), le débit PURCHASE et les mouvements SALE. */
  place(order: NewOrder): Promise<string>;
  /** +1 unité livrée. Lève OrderNotDispensableError si la commande n'est plus en cours. */
  markUnitDelivered(orderId: string, productId: string): Promise<void>;
  /** Clôt la commande, écrit le REFUND éventuel et les SALE_REVERSAL. */
  finish(orderId: string, finish: OrderFinish): Promise<void>;
}
export interface CatalogStore {
  /** Verrouille les produits (ordre d'id croissant) ; ignore les ids inexistants. */
  loadForUpdate(productIds: readonly string[]): Promise<Product[]>;
}
export interface WalletStore {
  balanceForUpdate(userId: string): Promise<number>;
  balance(userId: string): Promise<number>;
}

/**
 * Tout ce qu'une transaction peut toucher.
 * RÈGLE D'ORDRE DES VERROUS : machine_state d'abord, puis produits (id croissant), puis wallet.
 */
export interface TxContext {
  readonly machine: MachineStateStore;
  readonly orders: OrderStore;
  readonly catalog: CatalogStore;
  readonly wallet: WalletStore;
}

export interface UnitOfWork {
  /** Tout ou rien : si `work` lève, rien n'est écrit. */
  run<T>(work: (tx: TxContext) => Promise<T>): Promise<T>;
}

export interface DispenseRequest {
  /** Identifiant stable de l'unité (commande:produit:n) : permet un matériel idempotent. */
  readonly unitId: string;
  readonly productId: string;
}
export type DispenseOutcome =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly reason: string };
export interface Dispenser {
  dispense(req: DispenseRequest): Promise<DispenseOutcome>;
}

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
