import { describe, expect, it } from 'vitest';
import { rowToState, stateToValues } from './machine-state-mapper';
import { IDLE } from '../../domain/machine-state';
import type { MachineState } from '../../domain/machine-state';

const samples: MachineState[] = [
  IDLE,
  { kind: 'CLIENT_ACTIVE', userId: 'u1', startedAt: 10, lastActivityAt: 20, phase: 'SELECTING' },
  { kind: 'CLIENT_ACTIVE', userId: 'u1', startedAt: 10, lastActivityAt: 20, phase: 'DISPENSING' },
  { kind: 'MAINTENANCE', adminId: 'a1', startedAt: 10, lastActivityAt: 20 },
];

describe('mapper', () => {
  it.each(samples)('aller-retour %o', (s) => {
    expect(rowToState({ id: 1, ...stateToValues(s) })).toEqual(s);
  });
  it('stateToValues met à NULL les colonnes hors-sujet', () => {
    expect(stateToValues(IDLE)).toEqual({ kind: 'IDLE', userId: null, adminId: null, startedAt: null, lastActivityAt: null, phase: null });
  });
  it.each([
    [
      'CLIENT_ACTIVE sans user',
      { kind: 'CLIENT_ACTIVE', userId: null, adminId: null, startedAt: 1, lastActivityAt: 1, phase: 'SELECTING' },
    ],
    ['CLIENT_ACTIVE sans phase', { kind: 'CLIENT_ACTIVE', userId: 'u', adminId: null, startedAt: 1, lastActivityAt: 1, phase: null }],
    ['CLIENT_ACTIVE phase inconnue', { kind: 'CLIENT_ACTIVE', userId: 'u', adminId: null, startedAt: 1, lastActivityAt: 1, phase: 'X' }],
    ['MAINTENANCE sans admin', { kind: 'MAINTENANCE', userId: null, adminId: null, startedAt: 1, lastActivityAt: 1, phase: null }],
    ['type inconnu', { kind: 'BROKEN', userId: null, adminId: null, startedAt: null, lastActivityAt: null, phase: null }],
  ])('ligne incohérente rejetée : %s', (_n, v) => {
    expect(() => rowToState({ id: 1, ...v })).toThrow(/Invariant/);
  });
});
