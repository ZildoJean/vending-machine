/** La commande n'est plus en cours de distribution (déjà clôturée, reprise ou inexistante). */
export class OrderNotDispensableError extends Error {
  constructor(orderId: string) {
    super(`Commande ${orderId} non distribuable (déjà clôturée ou inconnue)`);
    this.name = 'OrderNotDispensableError';
  }
}

/** Conflit d'unicité détecté par la base (login déjà pris, nom de produit déjà pris...). */
export class ConflictError extends Error {
  constructor(readonly code: 'LOGIN_TAKEN' | 'PRODUCT_NAME_TAKEN') {
    super(`Conflit : ${code}`);
    this.name = 'ConflictError';
  }
}
