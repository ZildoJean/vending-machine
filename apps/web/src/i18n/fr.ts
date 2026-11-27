import { formatAr } from '@vending/shared';
import type { ApiErrorCode } from '@vending/shared';
import { ApiError, NetworkError } from '../api/client';

/** Record exhaustif : le compilateur refuse qu'un code du contrat n'ait pas de message. */
export const MESSAGES: Record<ApiErrorCode, string> = {
  MACHINE_BUSY: 'La machine est utilisée par un autre client. Réessayez dans un instant.',
  OUT_OF_SERVICE: 'La machine est en maintenance. Revenez plus tard.',
  DISPENSING_IN_PROGRESS: 'Une distribution est en cours, veuillez patienter.',
  NOT_OWNER: "Cette session n'est pas la vôtre.",
  SESSION_EXPIRED: 'Votre session a expiré par inactivité. Reconnectez-vous.',
  NO_SESSION: 'Aucune session ouverte. Connectez-vous.',
  TRANSITION_FORBIDDEN: "Action impossible dans l'état actuel de la machine.",
  INVALID_CREDENTIALS: 'Identifiants invalides, ou compte temporairement verrouillé.',
  UNAUTHENTICATED: 'Connexion requise.',
  FORBIDDEN: 'Accès refusé.',
  FORBIDDEN_ORIGIN: "Origine non autorisée : ouvrez l'application par l'adresse officielle.",
  VALIDATION_ERROR: 'Saisie invalide, vérifiez les champs.',
  BAD_REQUEST: 'Requête incorrecte.',
  PAYLOAD_TOO_LARGE: 'Requête trop volumineuse.',
  UNSUPPORTED_MEDIA_TYPE: 'Format de requête non pris en charge.',
  RATE_LIMITED: 'Trop de tentatives. Patientez une minute avant de réessayer.',
  NOT_FOUND: 'Introuvable.',
  INTERNAL: "Erreur interne du serveur. Réessayez ; si le problème persiste, prévenez l'exploitant.",
  MACHINE_LOCKED: 'La machine est momentanément indisponible. Réessayez dans une seconde.',
  DB_UNAVAILABLE: 'Service momentanément indisponible.',
  ORDER_NOT_DISPENSABLE: 'Cette commande est déjà clôturée.',
  EMPTY_CART: 'Choisissez au moins une boisson.',
  INVALID_QTY: 'Quantité invalide.',
  DUPLICATE_LINE: 'Une boisson apparaît deux fois dans la commande.',
  UNKNOWN_PRODUCT: "Cette boisson n'existe plus.",
  INACTIVE_PRODUCT: "Cette boisson n'est plus vendue.",
  INSUFFICIENT_STOCK: "Stock insuffisant : quelqu'un a pris la dernière unité ? Vérifiez les quantités.",
  CART_EXCEEDS_CAP: 'Le total dépasse le plafond du wallet : retirez des boissons.',
  INSUFFICIENT_FUNDS: 'Solde insuffisant.',
  INVALID_IDEMPOTENCY_KEY: 'Identifiant de commande invalide.',
  IDEMPOTENCY_KEY_REUSED: 'Cet identifiant de commande a déjà servi pour une autre commande.',
  BILL_REJECTED: 'Billet refusé par le monnayeur.',
  INSERTION_ID_REUSED: 'Cette insertion a déjà été enregistrée pour un autre billet.',
  NOT_SAFE_INTEGER: 'Montant invalide.',
  NOT_POSITIVE: 'Montant invalide.',
  NOT_MULTIPLE_OF_STEP: 'Montant invalide.',
  BILL_NOT_ACCEPTED: "Ce billet n'est pas accepté.",
  WALLET_CAP_EXCEEDED: 'Billet refusé : le plafond du wallet serait dépassé.',
  MAINTENANCE_REQUIRED: "Entrez d'abord en maintenance (elle expire après 15 minutes d'inactivité).",
  MAINTENANCE_OWNED_BY_OTHER: 'La maintenance est tenue par un autre administrateur.',
  INVALID_PRICE: 'Prix invalide : multiple de 100 Ar, positif, et pas plus que le plafond du wallet.',
  STOCK_OUT_OF_RANGE: 'Le stock résultant serait hors limites (0 à 10 000).',
  INVALID_SECRET: 'Secret refusé : format incorrect ou trop simple.',
  LOGIN_TAKEN: 'Ce login existe déjà.',
  PRODUCT_NAME_TAKEN: 'Ce nom de produit existe déjà.',
};

/** Affiché quand la session se ferme APRÈS une validation dont la réponse a été perdue. */
export const UNCERTAIN_ORDER_NOTICE =
  'Votre session est fermée. Si vous veniez de valider une commande, elle a peut-être été traitée : reconnectez-vous et consultez « Ma dernière commande » avant de recommander. Rien ne sera débité deux fois.';

export const NETWORK_MESSAGE = 'Impossible de joindre la machine. Vérifiez la connexion.';
export const GENERIC_MESSAGE = 'Une erreur est survenue.';

/** Message affichable pour n'importe quelle erreur, avec les détails utiles du serveur. */
export function describeError(e: unknown): string {
  if (e instanceof NetworkError) return NETWORK_MESSAGE;
  if (!(e instanceof ApiError)) return GENERIC_MESSAGE;
  const d = e.details ?? {};
  if (e.code === 'INSUFFICIENT_FUNDS' && typeof d.missingAr === 'number') return `Solde insuffisant : il manque ${formatAr(d.missingAr)}.`;
  if (e.code === 'CART_EXCEEDS_CAP' && typeof d.totalAr === 'number')
    return `Le total (${formatAr(d.totalAr)}) dépasse le plafond du wallet : retirez des boissons.`;
  if (e.code === 'STOCK_OUT_OF_RANGE' && typeof d.resultingStock === 'number')
    return `Le stock résultant (${d.resultingStock}) serait hors limites (0 à 10 000).`;
  if (e.code === 'INVALID_SECRET' && d.reason === 'WEAK') return 'Secret trop simple (suite, répétition) : choisissez-en un autre.';
  if (e.code === 'INVALID_SECRET' && d.reason === 'BAD_FORMAT') return 'Le PIN doit comporter exactement 6 chiffres.';
  return e.code === 'UNKNOWN' ? GENERIC_MESSAGE : MESSAGES[e.code];
}

export const ACTION_LABELS: Record<string, string> = {
  ADMIN_LOGIN: 'Connexion administrateur',
  ADMIN_CREATE: "Création d'un administrateur",
  MAINTENANCE_ENTER: 'Entrée en maintenance',
  MAINTENANCE_EXIT: 'Sortie de maintenance',
  SESSION_FORCE_CLOSE: 'Fermeture forcée de la session client',
  PRODUCT_CREATE: "Création d'un produit",
  PRODUCT_UPDATE: "Modification d'un produit",
  STOCK_RESTOCK: 'Réapprovisionnement',
  STOCK_ADJUST: 'Correction de stock',
  USER_CREATE: "Création d'un compte client",
  USER_PIN_RESET: 'Réinitialisation de PIN',
};
