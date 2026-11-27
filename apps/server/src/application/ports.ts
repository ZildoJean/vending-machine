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
  /** Dernière commande d'un client (la plus récente). */
  findLastByUser(userId: string): Promise<OrderRecord | null>;
  /** Insère la commande, ses lignes (prix figés), le débit PURCHASE et les mouvements SALE. */
  place(order: NewOrder): Promise<string>;
  /** +1 unité livrée. Lève OrderNotDispensableError si la commande n'est plus en cours. */
  markUnitDelivered(orderId: string, productId: string): Promise<void>;
  /** Clôt la commande, écrit le REFUND éventuel et les SALE_REVERSAL. */
  finish(orderId: string, finish: OrderFinish): Promise<void>;
}
export interface CatalogStore {
  /** Produits vendables (actifs), triés par nom. */
  listActive(): Promise<Product[]>;
  /** Verrouille les produits (ordre d'id croissant) ; ignore les ids inexistants. */
  loadForUpdate(productIds: readonly string[]): Promise<Product[]>;
}
export interface WalletStore {
  balanceForUpdate(userId: string): Promise<number>;
  balance(userId: string): Promise<number>;
  findDeposit(insertionId: string): Promise<{ readonly userId: string; readonly amountAr: number } | null>;
  appendDeposit(userId: string, amountAr: number, insertionId: string, createdAt: number): Promise<void>;
}

export type Role = 'CLIENT' | 'ADMIN';

export interface UserStore {
  /**
   * Réserve ATOMIQUEMENT une tentative de connexion AVANT toute vérification du secret :
   * des essais en parallèle ne peuvent donc pas dépasser `maxAttempts`. Renvoie null si le login
   * est inconnu OU verrouillé (indiscernables, volontairement).
   */
  reserveAttempt(
    login: string,
    now: number,
    policy: { readonly maxAttempts: number; readonly lockMs: number },
  ): Promise<{ readonly id: string; readonly role: Role; readonly secretHash: string } | null>;
  recordSuccess(userId: string): Promise<void>;
  create(input: { readonly login: string; readonly role: Role; readonly secretHash: string; readonly createdAt: number }): Promise<string>;
  /** Remplace le secret et lève le verrouillage. Renvoie false si l'utilisateur n'existe pas. */
  setSecret(userId: string, secretHash: string): Promise<boolean>;
  findById(userId: string): Promise<{ readonly id: string; readonly login: string; readonly role: Role } | null>;
  /** Comptes clients (jamais de hachage), triés par login. */
  listClients(): Promise<{ readonly id: string; readonly login: string; readonly lockedUntil: number | null }[]>;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly login: string;
  readonly role: Role;
  readonly machineStartedAt: number | null;
  readonly lastSeenAt: number;
  readonly expiresAt: number | null;
}
export interface SessionStore {
  /** Supprime l'éventuelle session précédente de l'utilisateur puis crée la nouvelle (une seule par utilisateur). */
  replace(input: {
    readonly userId: string;
    readonly tokenHash: string;
    readonly machineStartedAt: number | null;
    readonly now: number;
    readonly expiresAt: number | null;
  }): Promise<void>;
  findByHash(tokenHash: string): Promise<SessionRecord | null>;
  touch(sessionId: string, now: number): Promise<void>;
  deleteById(sessionId: string): Promise<void>;
  deleteByUser(userId: string): Promise<void>;
  /** Supprime les sessions mortes (administrateur expiré ou inactif ; client ancien ET qui n'est plus la session de la machine). Renvoie le nombre supprimé. */
  deleteStale(now: number, p: { readonly adminIdleMs: number; readonly clientMaxAgeMs: number }): Promise<number>;
}

export interface ProductRecord {
  readonly id: string;
  readonly name: string;
  readonly priceAr: number;
  readonly stock: number;
  readonly active: boolean;
}
export interface ProductAdminStore {
  list(): Promise<ProductRecord[]>;
  findForUpdate(id: string): Promise<ProductRecord | null>;
  create(name: string, priceAr: number): Promise<string>;
  update(id: string, patch: { readonly name?: string; readonly priceAr?: number; readonly active?: boolean }): Promise<void>;
  addMovement(m: {
    readonly productId: string;
    readonly delta: number;
    readonly reason: 'RESTOCK' | 'ADMIN_ADJUST';
    readonly actorId: string;
    readonly createdAt: number;
  }): Promise<void>;
}

export interface AuditEntry {
  readonly id: number;
  readonly actorId: string | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly createdAt: number;
}
export interface AuditStore {
  append(e: {
    readonly actorId: string | null;
    readonly action: string;
    readonly entity: string;
    readonly entityId: string | null;
    readonly oldValue?: unknown;
    readonly newValue?: unknown;
    readonly createdAt: number;
  }): Promise<void>;
  list(limit: number): Promise<AuditEntry[]>;
}

/** Hachage des secrets (PIN, mots de passe) : argon2id + poivre côté serveur. */
export interface SecretHasher {
  hash(secret: string): Promise<string>;
  verify(hash: string, secret: string): Promise<boolean>;
}

/** Le monnayeur : valide un billet inséré. Simulé ici ; un vrai pilote pourrait refuser un billet. */
export type BillInspection = { readonly accepted: true; readonly amountAr: number } | { readonly accepted: false; readonly reason: string };
export interface BillAcceptor {
  inspect(bill: number): BillInspection;
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
  readonly users: UserStore;
  readonly sessions: SessionStore;
  readonly products: ProductAdminStore;
  readonly audit: AuditStore;
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
export type DispenseOutcome = { readonly delivered: true } | { readonly delivered: false; readonly reason: string };
export interface Dispenser {
  dispense(req: DispenseRequest): Promise<DispenseOutcome>;
}

export interface Logger {
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
