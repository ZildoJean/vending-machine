import { err, ok } from '@vending/shared';
import type { DepositError, MachineError, MoneyConfig, Result, TimeoutConfig } from '@vending/shared';
import type { Clock } from '../domain/clock';
import { statesEqual, transition } from '../domain/machine-state';
import { validateDeposit } from '../domain/money';
import type { BillAcceptor, UnitOfWork } from './ports';

export type DepositFailure =
  | { readonly kind: 'MACHINE'; readonly error: MachineError }
  | { readonly kind: 'REJECTED'; readonly reason: string }
  | { readonly kind: 'DEPOSIT'; readonly error: DepositError }
  | { readonly kind: 'INSERTION_ID_REUSED' };

export interface DepositOutcome {
  readonly balanceAr: number;
  /** true : cette insertion avait déjà été créditée ; rien n'a été recrédité. */
  readonly replayed: boolean;
}

export class DepositService {
  constructor(
    private readonly d: {
      readonly uow: UnitOfWork;
      readonly clock: Clock;
      readonly acceptor: BillAcceptor;
      readonly money: MoneyConfig;
      readonly timeouts: TimeoutConfig;
    },
  ) {}

  /**
   * UN billet par appel. `insertionId` identifie l'insertion physique : la rejouer ne crédite pas deux fois.
   * Autorisé seulement en SELECTING (jamais pendant la distribution) ; compte comme une activité.
   */
  deposit(userId: string, bill: unknown, insertionId: string): Promise<Result<DepositOutcome, DepositFailure>> {
    const { uow, clock, acceptor, money, timeouts } = this.d;
    return uow.run(async (tx): Promise<Result<DepositOutcome, DepositFailure>> => {
      const state = await tx.machine.loadForUpdate();
      const now = clock.now();
      const touched = transition(state, { type: 'CLIENT_ACTIVITY', userId }, now, timeouts);
      if (!touched.ok) {
        if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state);
        return err({ kind: 'MACHINE', error: touched.error });
      }

      const existing = await tx.wallet.findDeposit(insertionId);
      if (existing !== null) {
        if (existing.userId !== userId || existing.amountAr !== bill) return err({ kind: 'INSERTION_ID_REUSED' });
        if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state);
        return ok({ balanceAr: await tx.wallet.balance(userId), replayed: true });
      }

      const balance = await tx.wallet.balanceForUpdate(userId);
      const inspected = typeof bill === 'number' ? acceptor.inspect(bill) : { accepted: false as const, reason: 'NOT_A_NUMBER' };
      if (!inspected.accepted) return err({ kind: 'REJECTED', reason: inspected.reason });

      const next = validateDeposit(balance, bill, money);
      if (!next.ok) {
        if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state);
        return err({ kind: 'DEPOSIT', error: next.error });
      }
      await tx.wallet.appendDeposit(userId, inspected.amountAr, insertionId, now);
      if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state);
      return ok({ balanceAr: next.value, replayed: false });
    });
  }
}
