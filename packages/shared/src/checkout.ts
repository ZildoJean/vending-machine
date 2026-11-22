/** Codes d'erreur du panier, partagés avec le front pour l'affichage des messages. */

export type LineErrorCode =
  | 'INVALID_QTY'
  | 'DUPLICATE_LINE'
  | 'UNKNOWN_PRODUCT'
  | 'INACTIVE_PRODUCT'
  | 'INSUFFICIENT_STOCK';

export type QuoteFailure =
  | { readonly code: 'EMPTY_CART' }
  | { readonly code: LineErrorCode; readonly lineIndex: number }
  /** Le total du panier dépasse le plafond du wallet : aucun dépôt ne pourra jamais le couvrir. */
  | { readonly code: 'CART_EXCEEDS_CAP'; readonly totalAr: number };

export type CheckoutFailure =
  | QuoteFailure
  | { readonly code: 'INSUFFICIENT_FUNDS'; readonly totalAr: number; readonly missingAr: number };

export type CheckoutErrorCode = CheckoutFailure['code'];

/** Erreurs de la requête elle-même (avant toute règle métier). */
export type CheckoutRequestError = 'INVALID_IDEMPOTENCY_KEY' | 'IDEMPOTENCY_KEY_REUSED';
