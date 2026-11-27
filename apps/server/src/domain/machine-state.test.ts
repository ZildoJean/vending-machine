import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { TIMEOUT_CONFIG } from '@vending/shared';
import type { MachineError } from '@vending/shared';
import { FakeClock } from '../testing/fake-clock';
import { IDLE, assertValidTimeoutConfig, isExpired, transition } from './machine-state';
import type { MachineEvent, MachineState } from './machine-state';

const cfg = TIMEOUT_CONFIG;
const CLIENT_MS = cfg.clientInactivityMs; // 120 000
const MAINT_MS = cfg.maintenanceInactivityMs; // 900 000
const T0 = 1_000_000;

const selecting = (userId = 'u1', last = T0): MachineState => ({
  kind: 'CLIENT_ACTIVE',
  userId,
  startedAt: last,
  lastActivityAt: last,
  phase: 'SELECTING',
});
const dispensing = (userId = 'u1', last = T0): MachineState => ({
  kind: 'CLIENT_ACTIVE',
  userId,
  startedAt: last,
  lastActivityAt: last,
  phase: 'DISPENSING',
});
const maintenance = (adminId = 'a1', last = T0): MachineState => ({
  kind: 'MAINTENANCE',
  adminId,
  startedAt: last,
  lastActivityAt: last,
});

const login = (userId: string): MachineEvent => ({ type: 'LOGIN_CLIENT', userId });
const logout = (userId: string): MachineEvent => ({ type: 'LOGOUT_CLIENT', userId });
const activity = (userId: string): MachineEvent => ({ type: 'CLIENT_ACTIVITY', userId });
const startD = (userId: string): MachineEvent => ({ type: 'START_DISPENSE', userId });
const endD: MachineEvent = { type: 'END_DISPENSE' };
const force: MachineEvent = { type: 'FORCE_CLOSE' };
const enterM = (adminId: string): MachineEvent => ({ type: 'ENTER_MAINTENANCE', adminId });
const exitM = (adminId: string): MachineEvent => ({ type: 'EXIT_MAINTENANCE', adminId });
const adminAct = (adminId: string): MachineEvent => ({ type: 'ADMIN_ACTIVITY', adminId });

describe('isExpired', () => {
  it('IDLE : jamais', () => {
    expect(isExpired(IDLE, T0 + 10 ** 9, cfg)).toBe(false);
  });
  it.each([
    [CLIENT_MS - 1, false],
    [CLIENT_MS, true], // seuil inclusif
    [CLIENT_MS + 1, true],
  ])('client SELECTING : inactivité %i ms -> expiré = %s', (idle, expected) => {
    expect(isExpired(selecting('u1', T0), T0 + idle, cfg)).toBe(expected);
  });
  it('client DISPENSING : jamais, même après 1 heure ou 1 an', () => {
    expect(isExpired(dispensing(), T0 + 3_600_000, cfg)).toBe(false);
    expect(isExpired(dispensing(), T0 + 365 * 86_400_000, cfg)).toBe(false);
  });
  it.each([
    [MAINT_MS - 1, false],
    [MAINT_MS, true],
  ])('maintenance : inactivité %i ms -> expiré = %s (14 min 59,999 s / 15 min 00 s)', (idle, expected) => {
    expect(isExpired(maintenance('a1', T0), T0 + idle, cfg)).toBe(expected);
  });
  it("horloge qui recule : pas d'expiration", () => {
    expect(isExpired(selecting('u1', T0), T0 - 5_000, cfg)).toBe(false);
  });
  it.each([-1, 1.5, NaN, Infinity])('horloge invalide %p -> lève', (now) => {
    expect(() => isExpired(IDLE, now, cfg)).toThrow(RangeError);
    expect(() => transition(IDLE, login('u1'), now, cfg)).toThrow(RangeError);
  });
});

describe('assertValidTimeoutConfig', () => {
  it('accepte la configuration par défaut', () => {
    expect(() => assertValidTimeoutConfig(cfg)).not.toThrow();
  });
  it.each([0, -1, 1.5, NaN])('refuse un délai %p', (v) => {
    expect(() => assertValidTimeoutConfig({ ...cfg, clientInactivityMs: v })).toThrow(/clientInactivityMs/);
    expect(() => assertValidTimeoutConfig({ ...cfg, maintenanceInactivityMs: v })).toThrow(/maintenanceInactivityMs/);
  });
});

type Case = [label: string, state: MachineState, event: MachineEvent, expected: MachineState | MachineError];
const NOW = T0 + 1_000; // état non expiré dans tous les cas ci-dessous

const matrix: Case[] = [
  // ---- IDLE
  ['IDLE + login', IDLE, login('u1'), { kind: 'CLIENT_ACTIVE', userId: 'u1', startedAt: NOW, lastActivityAt: NOW, phase: 'SELECTING' }],
  ['IDLE + entrer maintenance', IDLE, enterM('a1'), { kind: 'MAINTENANCE', adminId: 'a1', startedAt: NOW, lastActivityAt: NOW }],
  ['IDLE + force close (idempotent)', IDLE, force, IDLE],
  ['IDLE + logout', IDLE, logout('u1'), 'NO_SESSION'],
  ['IDLE + activité', IDLE, activity('u1'), 'NO_SESSION'],
  ['IDLE + start dispense', IDLE, startD('u1'), 'NO_SESSION'],
  ['IDLE + end dispense', IDLE, endD, 'TRANSITION_FORBIDDEN'],
  ['IDLE + sortie maintenance', IDLE, exitM('a1'), 'NO_SESSION'],
  ['IDLE + activité admin', IDLE, adminAct('a1'), 'NO_SESSION'],
  // ---- CLIENT SELECTING
  ['SELECTING + login autre client', selecting(), login('u2'), 'MACHINE_BUSY'],
  ['SELECTING + login même client (reconnexion)', selecting(), login('u1'), { ...selecting(), lastActivityAt: NOW } as MachineState],
  ['SELECTING + entrer maintenance', selecting(), enterM('a1'), 'MACHINE_BUSY'],
  ['SELECTING + logout propriétaire', selecting(), logout('u1'), IDLE],
  ['SELECTING + logout autre', selecting(), logout('u2'), 'NOT_OWNER'],
  ['SELECTING + activité propriétaire', selecting(), activity('u1'), { ...selecting(), lastActivityAt: NOW } as MachineState],
  ['SELECTING + activité autre', selecting(), activity('u2'), 'NOT_OWNER'],
  [
    'SELECTING + start dispense propriétaire',
    selecting(),
    startD('u1'),
    { ...selecting(), phase: 'DISPENSING', lastActivityAt: NOW } as MachineState,
  ],
  ['SELECTING + start dispense autre', selecting(), startD('u2'), 'NOT_OWNER'],
  ['SELECTING + end dispense', selecting(), endD, 'TRANSITION_FORBIDDEN'],
  ['SELECTING + force close', selecting(), force, IDLE],
  ['SELECTING + sortie maintenance', selecting(), exitM('a1'), 'TRANSITION_FORBIDDEN'],
  ['SELECTING + activité admin', selecting(), adminAct('a1'), 'TRANSITION_FORBIDDEN'],
  // ---- CLIENT DISPENSING
  ['DISPENSING + end dispense', dispensing(), endD, IDLE],
  ['DISPENSING + force close', dispensing(), force, 'DISPENSING_IN_PROGRESS'],
  ['DISPENSING + logout propriétaire', dispensing(), logout('u1'), 'DISPENSING_IN_PROGRESS'],
  ['DISPENSING + logout autre', dispensing(), logout('u2'), 'NOT_OWNER'],
  ['DISPENSING + activité propriétaire', dispensing(), activity('u1'), 'DISPENSING_IN_PROGRESS'],
  ['DISPENSING + activité autre', dispensing(), activity('u2'), 'NOT_OWNER'],
  ['DISPENSING + double validation', dispensing(), startD('u1'), 'TRANSITION_FORBIDDEN'],
  ['DISPENSING + start autre', dispensing(), startD('u2'), 'NOT_OWNER'],
  ['DISPENSING + login même client', dispensing(), login('u1'), 'DISPENSING_IN_PROGRESS'],
  ['DISPENSING + login autre', dispensing(), login('u2'), 'MACHINE_BUSY'],
  ['DISPENSING + entrer maintenance', dispensing(), enterM('a1'), 'MACHINE_BUSY'],
  ['DISPENSING + sortie maintenance', dispensing(), exitM('a1'), 'TRANSITION_FORBIDDEN'],
  ['DISPENSING + activité admin', dispensing(), adminAct('a1'), 'TRANSITION_FORBIDDEN'],
  // ---- MAINTENANCE
  ['MAINTENANCE + login client', maintenance(), login('u1'), 'OUT_OF_SERVICE'],
  ['MAINTENANCE + entrer (même admin)', maintenance(), enterM('a1'), 'MACHINE_BUSY'],
  ['MAINTENANCE + entrer (autre admin)', maintenance(), enterM('a2'), 'MACHINE_BUSY'],
  ['MAINTENANCE + sortie propriétaire', maintenance(), exitM('a1'), IDLE],
  ['MAINTENANCE + sortie autre admin', maintenance(), exitM('a2'), 'NOT_OWNER'],
  ['MAINTENANCE + activité admin propriétaire', maintenance(), adminAct('a1'), { ...maintenance(), lastActivityAt: NOW } as MachineState],
  ['MAINTENANCE + activité autre admin', maintenance(), adminAct('a2'), 'NOT_OWNER'],
  ['MAINTENANCE + logout', maintenance(), logout('u1'), 'NO_SESSION'],
  ['MAINTENANCE + activité client', maintenance(), activity('u1'), 'NO_SESSION'],
  ['MAINTENANCE + start dispense', maintenance(), startD('u1'), 'NO_SESSION'],
  ['MAINTENANCE + force close', maintenance(), force, 'TRANSITION_FORBIDDEN'],
  ['MAINTENANCE + end dispense', maintenance(), endD, 'TRANSITION_FORBIDDEN'],
];

describe('transition : matrice état x événement (non expiré)', () => {
  it.each(matrix)('%s', (_label, state, event, expected) => {
    const r = transition(state, event, NOW, cfg);
    if (typeof expected === 'string') {
      // refus : l'état n'est pas modifié
      expect(r).toEqual({ ok: false, error: expected, state });
    } else {
      expect(r).toEqual({ ok: true, state: expected });
    }
  });
});

describe('expiration traitée à la demande (proposition retenue)', () => {
  const expiredAt = T0 + CLIENT_MS;

  it('client expiré + entrer maintenance -> succès SANS fermeture forcée', () => {
    expect(transition(selecting('u1', T0), enterM('a1'), expiredAt, cfg)).toEqual({
      ok: true,
      state: { kind: 'MAINTENANCE', adminId: 'a1', startedAt: expiredAt, lastActivityAt: expiredAt },
    });
  });
  it('la même demande 1 ms plus tôt est refusée : le comportement dépend du moment de la requête', () => {
    const r = transition(selecting('u1', T0), enterM('a1'), expiredAt - 1, cfg);
    expect(r).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
  });
  it("client expiré + login d'un autre client -> nouvelle session", () => {
    const r = transition(selecting('u1', T0), login('u2'), expiredAt, cfg);
    expect(r).toEqual({ ok: true, state: selecting('u2', expiredAt) });
  });
  it('client expiré + re-login du même client -> session NEUVE (startedAt remis à now)', () => {
    const r = transition(selecting('u1', T0), login('u1'), expiredAt, cfg);
    expect(r).toEqual({ ok: true, state: selecting('u1', expiredAt) });
  });
  it('propriétaire expiré + activité -> SESSION_EXPIRED et état ramené à IDLE', () => {
    expect(transition(selecting('u1', T0), activity('u1'), expiredAt, cfg)).toEqual({
      ok: false,
      error: 'SESSION_EXPIRED',
      state: IDLE,
    });
  });
  it('propriétaire expiré + start dispense -> SESSION_EXPIRED (pas de débit possible)', () => {
    expect(transition(selecting('u1', T0), startD('u1'), expiredAt, cfg)).toEqual({
      ok: false,
      error: 'SESSION_EXPIRED',
      state: IDLE,
    });
  });
  it('propriétaire expiré + logout -> succès IDLE', () => {
    expect(transition(selecting('u1', T0), logout('u1'), expiredAt, cfg)).toEqual({ ok: true, state: IDLE });
  });
  it('un autre client expiré qui tente une activité -> NO_SESSION, état IDLE persisté', () => {
    expect(transition(selecting('u1', T0), activity('u2'), expiredAt, cfg)).toEqual({
      ok: false,
      error: 'NO_SESSION',
      state: IDLE,
    });
  });
  it('un événement refusé ne ressuscite pas une session expirée', () => {
    const first = transition(selecting('u1', T0), activity('u1'), expiredAt, cfg);
    const second = transition(first.state, activity('u1'), expiredAt + 1, cfg);
    expect(second).toEqual({ ok: false, error: 'NO_SESSION', state: IDLE });
  });
  it('force close sur session expirée -> succès IDLE (idempotent)', () => {
    expect(transition(selecting('u1', T0), force, expiredAt, cfg)).toEqual({ ok: true, state: IDLE });
  });
  it('login pendant une maintenance expirée -> accepté', () => {
    const r = transition(maintenance('a1', T0), login('u1'), T0 + MAINT_MS, cfg);
    expect(r).toEqual({ ok: true, state: selecting('u1', T0 + MAINT_MS) });
  });
  it("login 1 ms avant l'expiration de la maintenance -> OUT_OF_SERVICE", () => {
    expect(transition(maintenance('a1', T0), login('u1'), T0 + MAINT_MS - 1, cfg)).toMatchObject({
      ok: false,
      error: 'OUT_OF_SERVICE',
    });
  });
  it('admin expiré + sortie -> succès ; + activité -> SESSION_EXPIRED', () => {
    const at = T0 + MAINT_MS;
    expect(transition(maintenance('a1', T0), exitM('a1'), at, cfg)).toEqual({ ok: true, state: IDLE });
    expect(transition(maintenance('a1', T0), adminAct('a1'), at, cfg)).toEqual({
      ok: false,
      error: 'SESSION_EXPIRED',
      state: IDLE,
    });
  });
  it("DISPENSING n'expire jamais : un autre client reste refusé après 1 heure", () => {
    expect(transition(dispensing('u1', T0), login('u2'), T0 + 3_600_000, cfg)).toMatchObject({
      ok: false,
      error: 'MACHINE_BUSY',
    });
  });
});

describe('scénario avec horloge injectée', () => {
  it('activité glissante, puis inactivité, puis maintenance', () => {
    const clock = new FakeClock(T0);
    let s: MachineState = IDLE;
    const step = (e: MachineEvent) => {
      const r = transition(s, e, clock.now(), cfg);
      s = r.state;
      return r;
    };
    expect(step(login('u1')).ok).toBe(true);
    clock.advance(100_000);
    expect(step(activity('u1')).ok).toBe(true); // 100 s < 120 s
    clock.advance(100_000);
    expect(step(activity('u1')).ok).toBe(true); // 200 s au total, mais glissant
    clock.advance(CLIENT_MS - 1);
    expect(step(enterM('a1'))).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
    clock.advance(1);
    expect(step(enterM('a1')).ok).toBe(true);
    expect(s.kind).toBe('MAINTENANCE');
  });
  it('parcours complet : login, validation, fin de distribution, session fermée', () => {
    const clock = new FakeClock(T0);
    let s: MachineState = IDLE;
    for (const e of [login('u1'), activity('u1'), startD('u1'), endD]) {
      const r = transition(s, e, clock.now(), cfg);
      expect(r.ok).toBe(true);
      s = r.state;
      clock.advance(1_000);
    }
    expect(s).toEqual(IDLE);
    expect(transition(s, activity('u1'), clock.now(), cfg)).toMatchObject({ ok: false, error: 'NO_SESSION' });
  });
  it("horloge qui recule : l'activité ne fait jamais reculer lastActivityAt", () => {
    const r = transition(selecting('u1', T0), activity('u1'), T0 - 5_000, cfg);
    expect(r.ok && r.state.kind === 'CLIENT_ACTIVE' && r.state.lastActivityAt).toBe(T0);
  });
});

describe("PROPRIÉTÉS sur des suites aléatoires d'événements", () => {
  const eventArb: fc.Arbitrary<MachineEvent> = fc.oneof(
    fc.constantFrom('u1', 'u2').map(login),
    fc.constantFrom('u1', 'u2').map(logout),
    fc.constantFrom('u1', 'u2').map(activity),
    fc.constantFrom('u1', 'u2').map(startD),
    fc.constant(endD),
    fc.constant(force),
    fc.constantFrom('a1', 'a2').map(enterM),
    fc.constantFrom('a1', 'a2').map(exitM),
    fc.constantFrom('a1', 'a2').map(adminAct),
  );
  const dtArb = fc.oneof(
    fc.constant(0),
    fc.integer({ min: 1, max: 5_000 }),
    fc.integer({ min: 100_000, max: 130_000 }),
    fc.integer({ min: 890_000, max: 910_000 }),
  );

  it('invariants à chaque étape', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(dtArb, eventArb), { maxLength: 80 }), (steps) => {
        let s: MachineState = IDLE;
        let now = T0;
        for (const [dt, ev] of steps) {
          now += dt;
          const prev = s;
          const prevExpired = isExpired(prev, now, cfg);
          const r = transition(prev, ev, now, cfg);
          s = r.state;

          // I1 : une distribution en cours ne se termine QUE par END_DISPENSE
          if (prev.kind === 'CLIENT_ACTIVE' && prev.phase === 'DISPENSING' && ev.type !== 'END_DISPENSE') {
            expect(s).toEqual(prev);
          }
          // I2 : un refus ne change rien, sauf le nettoyage d'une session expirée
          if (!r.ok) expect(s).toEqual(prevExpired ? IDLE : prev);
          // I3 : sans expiration, on ne change jamais de propriétaire ni de mode directement
          if (!prevExpired) {
            if (prev.kind === 'CLIENT_ACTIVE' && s.kind === 'CLIENT_ACTIVE') expect(s.userId).toBe(prev.userId);
            if (prev.kind === 'MAINTENANCE' && s.kind === 'MAINTENANCE') expect(s.adminId).toBe(prev.adminId);
            if (prev.kind === 'CLIENT_ACTIVE') expect(s.kind).not.toBe('MAINTENANCE');
            if (prev.kind === 'MAINTENANCE') expect(s.kind).not.toBe('CLIENT_ACTIVE');
          }
          // I4 : horodatages cohérents
          if (s.kind !== 'IDLE') {
            expect(s.lastActivityAt).toBeLessThanOrEqual(now);
            expect(s.startedAt).toBeLessThanOrEqual(s.lastActivityAt);
          }
          // I5 : l'état persisté n'est jamais déjà expiré
          expect(isExpired(s, now, cfg)).toBe(false);
        }
      }),
      { numRuns: 500 },
    );
  });
});
