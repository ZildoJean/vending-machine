/** La commande n'est plus en cours de distribution (déjà clôturée, reprise ou inexistante). */
export class OrderNotDispensableError extends Error {
  constructor(orderId: string) {
    super(`Commande ${orderId} non distribuable (déjà clôturée ou inconnue)`);
    this.name = 'OrderNotDispensableError';
  }
}
