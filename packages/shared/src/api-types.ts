/**
 * Contrat HTTP partagé serveur / interface. Le serveur ne peut émettre QUE ces codes d'erreur
 * (le type de `send()` l'impose), et l'interface a un message pour chacun (type exhaustif).
 */
export const API_ERROR_CODES = [
  // machine
  'MACHINE_BUSY',
  'OUT_OF_SERVICE',
  'DISPENSING_IN_PROGRESS',
  'NOT_OWNER',
  'SESSION_EXPIRED',
  'NO_SESSION',
  'TRANSITION_FORBIDDEN',
  // authentification
  'INVALID_CREDENTIALS',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'FORBIDDEN_ORIGIN',
  // requête
  'VALIDATION_ERROR',
  'BAD_REQUEST',
  'PAYLOAD_TOO_LARGE',
  'UNSUPPORTED_MEDIA_TYPE',
  'RATE_LIMITED',
  'NOT_FOUND',
  'INTERNAL',
  'MACHINE_LOCKED',
  'DB_UNAVAILABLE',
  'ORDER_NOT_DISPENSABLE',
  // panier et commande
  'EMPTY_CART',
  'INVALID_QTY',
  'DUPLICATE_LINE',
  'UNKNOWN_PRODUCT',
  'INACTIVE_PRODUCT',
  'INSUFFICIENT_STOCK',
  'CART_EXCEEDS_CAP',
  'INSUFFICIENT_FUNDS',
  'INVALID_IDEMPOTENCY_KEY',
  'IDEMPOTENCY_KEY_REUSED',
  // dépôt
  'BILL_REJECTED',
  'INSERTION_ID_REUSED',
  'NOT_SAFE_INTEGER',
  'NOT_POSITIVE',
  'NOT_MULTIPLE_OF_STEP',
  'BILL_NOT_ACCEPTED',
  'WALLET_CAP_EXCEEDED',
  // administration
  'MAINTENANCE_REQUIRED',
  'MAINTENANCE_OWNED_BY_OTHER',
  'INVALID_PRICE',
  'STOCK_OUT_OF_RANGE',
  'INVALID_SECRET',
  'LOGIN_TAKEN',
  'PRODUCT_NAME_TAKEN',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface MeResponse {
  readonly userId: string;
  readonly login: string;
  readonly role: 'CLIENT' | 'ADMIN';
  /** Temps restant avant expiration (ms), calculé par le SERVEUR (pas d'écart d'horloge) ; null si sans expiration (distribution). */
  readonly remainingMs: number | null;
}
export interface ProductDto {
  readonly id: string;
  readonly name: string;
  readonly priceAr: number;
  readonly stock: number;
}
export interface WalletDto {
  readonly balanceAr: number;
  readonly walletCapAr: number;
  readonly acceptedBills: readonly number[];
}
export interface DepositResult {
  readonly balanceAr: number;
  readonly replayed: boolean;
}
export type OrderStatus = 'PENDING_DISPENSE' | 'DISPENSED' | 'PARTIALLY_DISPENSED' | 'FAILED';
export interface OrderOutcome {
  readonly orderId: string;
  readonly status: OrderStatus;
  readonly totalAr: number;
  readonly refundedAr: number;
  readonly balanceAr: number;
  readonly items: readonly { readonly productId: string; readonly qty: number; readonly deliveredQty: number }[];
  readonly replayed: boolean;
}
export interface AdminProductDto extends ProductDto {
  readonly active: boolean;
}
export type PublicMachineStatus = 'IDLE' | 'IN_USE' | 'MAINTENANCE';
export type AdminMachineDto =
  | { readonly status: 'IDLE' }
  | { readonly status: 'IN_USE'; readonly phase: 'SELECTING' | 'DISPENSING' }
  | { readonly status: 'MAINTENANCE'; readonly ownedByMe: boolean; readonly remainingMs: number };
export interface UserDto {
  readonly id: string;
  readonly login: string;
  readonly locked: boolean;
}
export interface AuditEntryDto {
  readonly id: number;
  readonly actorId: string | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly oldValue: unknown;
  readonly newValue: unknown;
  readonly createdAt: number;
}
