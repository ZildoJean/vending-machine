import { IDLE } from '../../domain/machine-state';
import type { MachineState } from '../../domain/machine-state';
import type { machineState } from './schema';

type Row = typeof machineState.$inferSelect;
export type MachineStateValues = Omit<Row, 'id'>;

function bad(what: string): never {
  throw new Error(`Invariant violé : ligne machine_state incohérente (${what})`);
}

/** La base garantit déjà la forme (CHECK) ; on revérifie quand même, sans rien supposer. */
export function rowToState(row: Row): MachineState {
  switch (row.kind) {
    case 'IDLE':
      return IDLE;
    case 'CLIENT_ACTIVE':
      if (row.userId === null || row.startedAt === null || row.lastActivityAt === null) bad('CLIENT_ACTIVE incomplet');
      if (row.phase !== 'SELECTING' && row.phase !== 'DISPENSING') bad('phase');
      return {
        kind: 'CLIENT_ACTIVE',
        userId: row.userId,
        startedAt: row.startedAt,
        lastActivityAt: row.lastActivityAt,
        phase: row.phase,
      };
    case 'MAINTENANCE':
      if (row.adminId === null || row.startedAt === null || row.lastActivityAt === null) bad('MAINTENANCE incomplet');
      return { kind: 'MAINTENANCE', adminId: row.adminId, startedAt: row.startedAt, lastActivityAt: row.lastActivityAt };
    default:
      return bad(`kind ${row.kind}`);
  }
}

export function stateToValues(s: MachineState): MachineStateValues {
  switch (s.kind) {
    case 'IDLE':
      return { kind: 'IDLE', userId: null, adminId: null, startedAt: null, lastActivityAt: null, phase: null };
    case 'CLIENT_ACTIVE':
      return { kind: s.kind, userId: s.userId, adminId: null, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, phase: s.phase };
    case 'MAINTENANCE':
      return { kind: s.kind, userId: null, adminId: s.adminId, startedAt: s.startedAt, lastActivityAt: s.lastActivityAt, phase: null };
  }
}
