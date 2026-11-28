import type { FastifyReply } from 'fastify';
import type { ApiErrorCode, CheckoutFailure, MachineError } from '@vending/shared';
import type { AdminFailure } from '../../application/admin-service';
import type { CheckoutError } from '../../application/checkout-service';
import type { DepositFailure } from '../../application/deposit-service';

export interface ErrorBody {
  readonly error: { readonly code: ApiErrorCode; readonly message: string; readonly details?: Record<string, unknown> };
}

export function send(
  reply: FastifyReply,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: Record<string, unknown>,
): FastifyReply {
  const body: ErrorBody = { error: { code, message, ...(details ? { details } : {}) } };
  return reply.code(status).send(body);
}

export type MachineContext = 'client' | 'machine-admin' | 'catalog-admin';

const CLIENT: Record<MachineError, [number, string]> = {
  MACHINE_BUSY: [409, 'La machine est utilisée par un autre client.'],
  OUT_OF_SERVICE: [503, 'La machine est en maintenance.'],
  DISPENSING_IN_PROGRESS: [409, 'Distribution en cours, veuillez patienter.'],
  NOT_OWNER: [403, "Cette session n'est pas la vôtre."],
  SESSION_EXPIRED: [401, 'Votre session a expiré, reconnectez-vous.'],
  NO_SESSION: [401, 'Aucune session ouverte.'],
  TRANSITION_FORBIDDEN: [409, "Action impossible dans l'état actuel de la machine."],
};

export function machineError(reply: FastifyReply, error: MachineError, ctx: MachineContext): FastifyReply {
  if (ctx === 'catalog-admin' && (error === 'NO_SESSION' || error === 'TRANSITION_FORBIDDEN' || error === 'SESSION_EXPIRED')) {
    return send(reply, 409, 'MAINTENANCE_REQUIRED', "Entrez d'abord en maintenance (elle expire après 15 min d'inactivité).");
  }
  if (ctx !== 'client' && error === 'NOT_OWNER') {
    return send(reply, 409, 'MAINTENANCE_OWNED_BY_OTHER', 'La maintenance est tenue par un autre administrateur.');
  }
  const [status, message] = CLIENT[error];
  return send(reply, status, error, message);
}

export function cartFailure(reply: FastifyReply, f: CheckoutFailure): FastifyReply {
  const messages: Record<CheckoutFailure['code'], string> = {
    EMPTY_CART: 'Le panier est vide.',
    INVALID_QTY: 'Quantité invalide.',
    DUPLICATE_LINE: 'Un produit apparaît deux fois dans le panier.',
    UNKNOWN_PRODUCT: 'Produit inconnu.',
    INACTIVE_PRODUCT: "Ce produit n'est plus vendu.",
    INSUFFICIENT_STOCK: 'Stock insuffisant.',
    CART_EXCEEDS_CAP: 'Le total du panier dépasse le plafond du wallet : réduisez la commande.',
    INSUFFICIENT_FUNDS: 'Solde insuffisant.',
  };
  const { code, ...rest } = f;
  return send(reply, 422, code, messages[code], rest);
}

export function checkoutError(reply: FastifyReply, e: CheckoutError): FastifyReply {
  switch (e.kind) {
    case 'MACHINE':
      return machineError(reply, e.error, 'client');
    case 'CART':
      return cartFailure(reply, e.failure);
    case 'REQUEST':
      return e.error === 'INVALID_IDEMPOTENCY_KEY'
        ? send(reply, 400, e.error, 'En-tête Idempotency-Key manquant ou invalide (8 à 100 caractères).')
        : send(reply, 409, e.error, "Cette clé d'idempotence a déjà servi pour une autre commande.");
  }
}

export function depositFailure(reply: FastifyReply, f: DepositFailure): FastifyReply {
  switch (f.kind) {
    case 'MACHINE':
      return machineError(reply, f.error, 'client');
    case 'REJECTED':
      return send(reply, 422, 'BILL_REJECTED', 'Billet refusé par le monnayeur.');
    case 'INSERTION_ID_REUSED':
      return send(reply, 409, 'INSERTION_ID_REUSED', "Cet identifiant d'insertion a déjà servi pour un autre billet.");
    case 'DEPOSIT':
      return send(
        reply,
        422,
        f.error,
        f.error === 'WALLET_CAP_EXCEEDED' ? 'Billet refusé : le plafond du wallet serait dépassé.' : 'Billet non accepté.',
      );
  }
}

export function adminFailure(reply: FastifyReply, f: AdminFailure, ctx: MachineContext): FastifyReply {
  switch (f.kind) {
    case 'MACHINE':
      return machineError(reply, f.error, ctx);
    case 'NOT_FOUND':
      return send(reply, 404, 'NOT_FOUND', 'Ressource introuvable.');
    case 'INVALID_PRICE':
      return send(reply, 422, 'INVALID_PRICE', 'Prix invalide (multiple de 100, positif, plafond du wallet).', { reason: f.error });
    case 'STOCK_OUT_OF_RANGE':
      return send(reply, 422, 'STOCK_OUT_OF_RANGE', 'Le stock résultant serait hors limites.', { resultingStock: f.resultingStock });
    case 'INVALID_SECRET':
      return send(reply, 422, 'INVALID_SECRET', 'Secret refusé (format ou trop simple).', { reason: f.reason });
    case 'CONFLICT':
      return send(reply, 409, f.code, f.code === 'LOGIN_TAKEN' ? 'Ce login existe déjà.' : 'Ce nom de produit existe déjà.');
  }
}
