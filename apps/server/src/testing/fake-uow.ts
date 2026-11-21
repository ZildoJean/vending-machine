import type { MachineStateStore, TxContext, UnitOfWork } from '../application/ports';
import { IDLE } from '../domain/machine-state';
import type { MachineState } from '../domain/machine-state';

/** UoW en mémoire qui journalise l'ordre des appels (pas d'isolation : sert à tester l'orchestration). */
export class FakeUnitOfWork implements UnitOfWork {
  state: MachineState = IDLE;
  readonly log: string[] = [];

  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    const snapshot = this.state;
    const store: MachineStateStore = {
      load: async () => {
        this.log.push('load');
        return this.state;
      },
      loadForUpdate: async () => {
        this.log.push('loadForUpdate');
        return this.state;
      },
      save: async (s) => {
        this.log.push(`save:${s.kind}`);
        this.state = s;
      },
    };
    try {
      return await work({ machine: store });
    } catch (e) {
      this.state = snapshot; // rollback
      this.log.push('rollback');
      throw e;
    }
  }
}
