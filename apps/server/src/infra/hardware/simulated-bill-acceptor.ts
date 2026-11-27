import type { BillAcceptor, BillInspection } from '../../application/ports';

/**
 * Monnayeur simulé : n'accepte que les coupures de la liste. `rejectIf` permet de simuler un billet
 * refusé (ex. froissé). Un vrai pilote matériel remplacerait cette classe sans toucher au métier.
 */
export class SimulatedBillAcceptor implements BillAcceptor {
  constructor(
    private readonly acceptedBills: readonly number[],
    private readonly rejectIf: (bill: number) => string | null = () => null,
  ) {}
  inspect(bill: number): BillInspection {
    if (!this.acceptedBills.includes(bill)) return { accepted: false, reason: 'UNKNOWN_DENOMINATION' };
    const reason = this.rejectIf(bill);
    return reason === null ? { accepted: true, amountAr: bill } : { accepted: false, reason };
  }
}
