import { describe, expect, it } from 'vitest';
import { TIMEOUT_CONFIG } from '@vending/shared';
import { IDLE, settle, statesEqual } from './machine-state';
import type { MachineState } from './machine-state';

const cfg = TIMEOUT_CONFIG;
const sel = (last: number, userId = 'u1', phase: 'SELECTING' | 'DISPENSING' = 'SELECTING'): MachineState => ({
  kind: 'CLIENT_ACTIVE',
  userId,
  startedAt: 0,
  lastActivityAt: last,
  phase,
});
const maint = (last: number, adminId = 'a1'): MachineState => ({ kind: 'MAINTENANCE', adminId, startedAt: 0, lastActivityAt: last });

describe('statesEqual', () => {
  it.each<[string, MachineState, MachineState, boolean]>([
    ['IDLE = IDLE', IDLE, IDLE, true],
    ['IDLE != client', IDLE, sel(5), false],
    ['client identique', sel(5), sel(5), true],
    ['client : activité différente', sel(5), sel(6), false],
    ['client : propriétaire différent', sel(5, 'u1'), sel(5, 'u2'), false],
    ['client : phase différente', sel(5, 'u1', 'SELECTING'), sel(5, 'u1', 'DISPENSING'), false],
    ['client != maintenance', sel(5), maint(5), false],
    ['maintenance identique', maint(5), maint(5), true],
    ['maintenance : admin différent', maint(5, 'a1'), maint(5, 'a2'), false],
    ['maintenance : activité différente', maint(5), maint(9), false],
  ])('%s', (_n, a, b, expected) => {
    expect(statesEqual(a, b)).toBe(expected);
    expect(statesEqual(b, a)).toBe(expected);
  });
  it('début différent', () => {
    expect(statesEqual({ ...sel(5), startedAt: 1 } as MachineState, sel(5))).toBe(false);
  });
});

describe('settle', () => {
  it('session non expirée : inchangée (même référence)', () => {
    const s = sel(1_000);
    expect(settle(s, 1_000 + cfg.clientInactivityMs - 1, cfg)).toBe(s);
  });
  it('session expirée -> IDLE (seuil inclusif)', () => {
    expect(settle(sel(1_000), 1_000 + cfg.clientInactivityMs, cfg)).toBe(IDLE);
    expect(settle(maint(1_000), 1_000 + cfg.maintenanceInactivityMs, cfg)).toBe(IDLE);
  });
  it('DISPENSING jamais ramené à IDLE', () => {
    const s = sel(0, 'u1', 'DISPENSING');
    expect(settle(s, 10 ** 9, cfg)).toBe(s);
  });
});
