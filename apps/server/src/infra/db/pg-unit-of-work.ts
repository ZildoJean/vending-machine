import { eq, sql } from 'drizzle-orm';
import type { MachineStateStore, TxContext, UnitOfWork } from '../../application/ports';
import type { MachineState } from '../../domain/machine-state';
import type { Db, Tx } from './client';
import { LockTimeoutError, PG_LOCK_NOT_AVAILABLE, pgErrorCode } from './errors';
import { PgCatalogStore, PgOrderStore, PgWalletStore } from './pg-checkout-stores';
import { rowToState, stateToValues } from './machine-state-mapper';
import { machineState } from './schema';

class PgMachineStateStore implements MachineStateStore {
  constructor(private readonly tx: Tx) {}

  private async read(lock: boolean): Promise<MachineState> {
    const q = this.tx.select().from(machineState).where(eq(machineState.id, 1));
    const rows = await (lock ? q.for('update') : q);
    const row = rows[0];
    if (rows.length !== 1 || row === undefined) throw new Error('Invariant violé : singleton machine_state absent');
    return rowToState(row);
  }
  load(): Promise<MachineState> {
    return this.read(false);
  }
  loadForUpdate(): Promise<MachineState> {
    return this.read(true);
  }
  async save(state: MachineState): Promise<void> {
    const updated = await this.tx
      .update(machineState)
      .set(stateToValues(state))
      .where(eq(machineState.id, 1))
      .returning({ id: machineState.id });
    if (updated.length !== 1) throw new Error('Invariant violé : mise à jour du singleton machine_state');
  }
}

export interface PgUnitOfWorkOptions {
  /** Attente maximale d'un verrou (ms). Sans cela, une transaction bloquée figerait la machine. */
  readonly lockTimeoutMs: number;
}

export class PgUnitOfWork implements UnitOfWork {
  constructor(
    private readonly db: Db,
    private readonly opts: PgUnitOfWorkOptions = { lockTimeoutMs: 5_000 },
  ) {
    if (!Number.isSafeInteger(opts.lockTimeoutMs) || opts.lockTimeoutMs <= 0) {
      throw new RangeError('lockTimeoutMs doit être un entier > 0');
    }
  }

  async run<T>(work: (tx: TxContext) => Promise<T>): Promise<T> {
    try {
      return await this.db.transaction(async (tx) => {
        // entier validé ci-dessus : SET ne accepte pas de paramètre lié
        await tx.execute(sql.raw(`SET LOCAL lock_timeout = ${this.opts.lockTimeoutMs}`));
        return work({
          machine: new PgMachineStateStore(tx),
          orders: new PgOrderStore(tx),
          catalog: new PgCatalogStore(tx),
          wallet: new PgWalletStore(tx),
        });
      });
    } catch (e) {
      if (pgErrorCode(e) === PG_LOCK_NOT_AVAILABLE) throw new LockTimeoutError({ cause: e });
      throw e;
    }
  }
}
