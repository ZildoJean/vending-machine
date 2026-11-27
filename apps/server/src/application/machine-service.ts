import type { TimeoutConfig } from '@vending/shared';
import type { Clock } from '../domain/clock';
import { isExpired, settle, statesEqual, transition } from '../domain/machine-state';
import type { MachineEvent, MachineState, TransitionResult } from '../domain/machine-state';
import type { TxContext, UnitOfWork } from './ports';

/** verrou -> lecture -> horloge -> transition -> écriture, DANS la transaction `tx` de l'appelant. */
export async function applyMachineEvent(tx: TxContext, clock: Clock, cfg: TimeoutConfig, event: MachineEvent): Promise<TransitionResult> {
  const current = await tx.machine.loadForUpdate();
  const now = clock.now(); // APRÈS le verrou
  const result = transition(current, event, now, cfg);
  if (!statesEqual(current, result.state)) await tx.machine.save(result.state);
  return result;
}

export class MachineService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly cfg: TimeoutConfig,
  ) {}

  /**
   * verrou -> lecture -> horloge -> transition -> écriture, dans UNE transaction.
   * - L'heure est lue APRÈS l'obtention du verrou : sinon un événement qui attend le verrou
   *   pourrait être daté avant celui qui vient de le libérer (ordre du temps != ordre d'exécution).
   * - `result.state` est écrit même en cas de refus : une session expirée est ramenée à IDLE.
   */
  apply(event: MachineEvent): Promise<TransitionResult> {
    return this.uow.run((tx) => applyMachineEvent(tx, this.clock, this.cfg, event));
  }

  /**
   * État courant avec expiration évaluée. Lecture sans verrou ; on ne verrouille (et n'écrit)
   * que si la session observée est expirée.
   */
  async status(): Promise<MachineState> {
    const snapshot = await this.uow.run((tx) => tx.machine.load());
    if (!isExpired(snapshot, this.clock.now(), this.cfg)) return snapshot;
    return this.uow.run(async (tx) => {
      const current = await tx.machine.loadForUpdate();
      const next = settle(current, this.clock.now(), this.cfg);
      if (!statesEqual(current, next)) await tx.machine.save(next);
      return next;
    });
  }
}
