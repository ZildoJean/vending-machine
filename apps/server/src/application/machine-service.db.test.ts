import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Pool } from 'pg';
import { TIMEOUT_CONFIG } from '@vending/shared';
import { IDLE, settle, transition } from '../domain/machine-state';
import type { MachineEvent, MachineState, TransitionResult } from '../domain/machine-state';
import { createDb } from '../infra/db/client';
import { LockTimeoutError } from '../infra/db/errors';
import { PgUnitOfWork } from '../infra/db/pg-unit-of-work';
import { FakeClock } from '../testing/fake-clock';
import { mkUser, readMachineRow, resetMachine } from '../testing/pg-fixtures';
import { createTestDb } from '../testing/pg-test-db';
import type { TestDb } from '../testing/pg-test-db';
import { MachineService } from './machine-service';

const cfg = TIMEOUT_CONFIG;
const T0 = 1_000_000;
let db: TestDb;
let pool: Pool;
let uow: PgUnitOfWork;
let clock: FakeClock;
let svc: MachineService;
let clients: string[];
let admins: string[];

beforeAll(async () => {
  db = await createTestDb();
  pool = db.pool;
  uow = new PgUnitOfWork(createDb(pool));
  clients = await Promise.all(Array.from({ length: 10 }, () => mkUser(pool, 'CLIENT')));
  admins = await Promise.all(Array.from({ length: 2 }, () => mkUser(pool, 'ADMIN')));
});
afterAll(async () => {
  await db?.drop(); // db peut être absent si la création a échoué : ne pas masquer la vraie erreur
});
beforeEach(async () => {
  await resetMachine(pool);
  clock = new FakeClock(T0);
  svc = new MachineService(uow, clock, cfg);
});

const login = (userId: string): MachineEvent => ({ type: 'LOGIN_CLIENT', userId });
const rowKind = async () => (await readMachineRow(pool)).kind;
const c = (i: number): string => clients[i] as string;
const a = (i: number): string => admins[i] as string;

describe('persistance', () => {
  it('un événement accepté est écrit en base ; un refus ne la modifie pas', async () => {
    expect((await svc.apply(login(c(0)))).ok).toBe(true);
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'CLIENT_ACTIVE', user_id: c(0), started_at: T0, phase: 'SELECTING' });
    const before = await readMachineRow(pool);
    expect(await svc.apply(login(c(1)))).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
    expect(await readMachineRow(pool)).toEqual(before);
  });

  it('parcours complet : login, validation, force close refusée, fin, retour à IDLE', async () => {
    await svc.apply(login(c(0)));
    await svc.apply({ type: 'CLIENT_ACTIVITY', userId: c(0) });
    await svc.apply({ type: 'START_DISPENSE', userId: c(0) });
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'DISPENSING' });
    expect(await svc.apply({ type: 'FORCE_CLOSE' })).toMatchObject({ ok: false, error: 'DISPENSING_IN_PROGRESS' });
    expect(await rowKind()).toBe('CLIENT_ACTIVE');
    await svc.apply({ type: 'END_DISPENSE' });
    expect(await rowKind()).toBe('IDLE');
  });

  it('SESSION_EXPIRED : le retour à IDLE est bien écrit malgré le refus', async () => {
    await svc.apply(login(c(0)));
    clock.advance(cfg.clientInactivityMs);
    expect(await svc.apply({ type: 'CLIENT_ACTIVITY', userId: c(0) })).toMatchObject({ ok: false, error: 'SESSION_EXPIRED' });
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'IDLE', user_id: null });
  });

  it("client fantôme expiré : l'admin entre en maintenance sans fermeture forcée", async () => {
    await svc.apply(login(c(0)));
    clock.advance(cfg.clientInactivityMs);
    expect((await svc.apply({ type: 'ENTER_MAINTENANCE', adminId: a(0) })).ok).toBe(true);
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'MAINTENANCE', admin_id: a(0), user_id: null });
  });

  it('status() : expiré -> IDLE écrit ; DISPENSING jamais touché', async () => {
    await svc.apply(login(c(0)));
    clock.advance(cfg.clientInactivityMs);
    expect(await svc.status()).toEqual(IDLE);
    expect(await rowKind()).toBe('IDLE');
    await svc.apply(login(c(1)));
    await svc.apply({ type: 'START_DISPENSE', userId: c(1) });
    clock.advance(3_600_000);
    expect(await svc.status()).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'DISPENSING' });
  });

  it('transaction annulée : aucun effet en base', async () => {
    await expect(
      uow.run(async (tx) => {
        await tx.machine.loadForUpdate();
        await tx.machine.save({ kind: 'MAINTENANCE', adminId: a(0), startedAt: 1, lastActivityAt: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await rowKind()).toBe('IDLE');
  });
});

describe('concurrence réelle', () => {
  it('10 connexions simultanées : exactement une réussit, les 9 autres reçoivent MACHINE_BUSY', async () => {
    const results = await Promise.all(clients.map((u) => svc.apply(login(u))));
    const winners = results.flatMap((r, i) => (r.ok ? [c(i)] : []));
    expect(winners).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'MACHINE_BUSY')).toBe(true);
    expect(await readMachineRow(pool)).toMatchObject({ kind: 'CLIENT_ACTIVE', user_id: winners[0] });
  });

  it('client contre administrateur, 15 manches : un seul gagnant à chaque fois', async () => {
    for (let round = 0; round < 15; round++) {
      await resetMachine(pool);
      const [r1, r2] = await Promise.all([svc.apply(login(c(0))), svc.apply({ type: 'ENTER_MAINTENANCE', adminId: a(0) })]);
      expect([r1.ok, r2.ok].filter(Boolean)).toHaveLength(1);
      const kind = await rowKind();
      expect(kind).toBe(r1.ok ? 'CLIENT_ACTIVE' : 'MAINTENANCE');
    }
  });

  it('double validation simultanée du même client : une seule passe', async () => {
    await svc.apply(login(c(0)));
    const results = await Promise.all([
      svc.apply({ type: 'START_DISPENSE', userId: c(0) }),
      svc.apply({ type: 'START_DISPENSE', userId: c(0) }),
      svc.apply({ type: 'START_DISPENSE', userId: c(0) }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error === 'TRANSITION_FORBIDDEN')).toBe(true);
  });

  it('un client en cours ne peut pas être expulsé par une lecture de status() concurrente', async () => {
    await svc.apply(login(c(0)));
    const out = await Promise.all([svc.status(), svc.apply({ type: 'CLIENT_ACTIVITY', userId: c(0) }), svc.status()]);
    expect(out[1]).toMatchObject({ ok: true });
    expect(await rowKind()).toBe('CLIENT_ACTIVE');
  });
});

describe('verrou : délai maximal et lecture non bloquante', () => {
  const hold = async () => {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query('SELECT * FROM machine_state WHERE id = 1 FOR UPDATE');
    return async () => {
      await holder.query('ROLLBACK');
      holder.release();
    };
  };

  it("verrou tenu trop longtemps : LockTimeoutError au lieu d'un blocage infini, puis reprise normale", async () => {
    const short = new MachineService(new PgUnitOfWork(createDb(pool), { lockTimeoutMs: 200 }), clock, cfg);
    const release = await hold();
    const guard = setTimeout(() => void release(), 4_000); // filet : sans délai de verrou, on débloque pour échouer proprement
    try {
      const t0 = Date.now();
      await expect(short.apply(login(c(0)))).rejects.toBeInstanceOf(LockTimeoutError);
      expect(Date.now() - t0).toBeLessThan(3_000);
    } finally {
      clearTimeout(guard);
      await release().catch(() => undefined); // toujours libérer, même si l'assertion échoue
    }
    expect((await short.apply(login(c(0)))).ok).toBe(true);
  });

  it('status() sur un état non expiré ne attend PAS le verrou', async () => {
    await svc.apply(login(c(0)));
    const short = new MachineService(new PgUnitOfWork(createDb(pool), { lockTimeoutMs: 200 }), clock, cfg);
    const release = await hold();
    try {
      expect((await short.status()).kind).toBe('CLIENT_ACTIVE');
    } finally {
      await release();
    }
  });

  it('options invalides refusées', () => {
    expect(() => new PgUnitOfWork(createDb(pool), { lockTimeoutMs: 0 })).toThrow(RangeError);
    expect(() => new PgUnitOfWork(createDb(pool), { lockTimeoutMs: 1.5 })).toThrow(RangeError);
  });
});

describe('PROPRIÉTÉS contre le vrai PostgreSQL', () => {
  it("tout MachineState valide du domaine est accepté par les CHECK et relu à l'identique", async () => {
    const stateArb: fc.Arbitrary<MachineState> = fc.oneof(
      fc.constant(IDLE),
      fc
        .record({
          kind: fc.constant('CLIENT_ACTIVE' as const),
          userId: fc.constantFrom(...clients),
          startedAt: fc.integer({ min: 0, max: 10 ** 12 }),
          extra: fc.integer({ min: 0, max: 10 ** 9 }),
          phase: fc.constantFrom('SELECTING' as const, 'DISPENSING' as const),
        })
        .map((r) => ({ kind: r.kind, userId: r.userId, startedAt: r.startedAt, lastActivityAt: r.startedAt + r.extra, phase: r.phase })),
      fc
        .record({
          adminId: fc.constantFrom(...admins),
          startedAt: fc.integer({ min: 0, max: 10 ** 12 }),
          extra: fc.integer({ min: 0, max: 10 ** 9 }),
        })
        .map((r) => ({ kind: 'MAINTENANCE' as const, adminId: r.adminId, startedAt: r.startedAt, lastActivityAt: r.startedAt + r.extra })),
    );
    await fc.assert(
      fc.asyncProperty(stateArb, async (s) => {
        const back = await uow.run(async (tx) => {
          await tx.machine.loadForUpdate();
          await tx.machine.save(s);
          return tx.machine.load();
        });
        expect(back).toEqual(s);
      }),
      { numRuns: 100 },
    );
  });

  it("suites aléatoires d'événements : base + service == domaine pur (même résultats, même état)", async () => {
    const eventArb: fc.Arbitrary<MachineEvent> = fc.oneof(
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'LOGIN_CLIENT', userId: c(i) })),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'LOGOUT_CLIENT', userId: c(i) })),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'CLIENT_ACTIVITY', userId: c(i) })),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'START_DISPENSE', userId: c(i) })),
      fc.constant<MachineEvent>({ type: 'END_DISPENSE' }),
      fc.constant<MachineEvent>({ type: 'FORCE_CLOSE' }),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'ENTER_MAINTENANCE', adminId: a(i) })),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'EXIT_MAINTENANCE', adminId: a(i) })),
      fc.constantFrom(0, 1).map((i): MachineEvent => ({ type: 'ADMIN_ACTIVITY', adminId: a(i) })),
    );
    const dtArb = fc.oneof(
      fc.constant(0),
      fc.integer({ min: 1, max: 5_000 }),
      fc.integer({ min: 100_000, max: 130_000 }),
      fc.integer({ min: 890_000, max: 910_000 }),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(dtArb, eventArb), { maxLength: 25 }), async (steps) => {
        await resetMachine(pool);
        const fc2 = new FakeClock(T0);
        const service = new MachineService(uow, fc2, cfg);
        let model: MachineState = IDLE;
        for (const [dt, ev] of steps) {
          fc2.advance(dt);
          const expected: TransitionResult = transition(model, ev, fc2.now(), cfg);
          const actual = await service.apply(ev);
          expect(actual).toEqual(expected);
          model = expected.state;
          const row = await readMachineRow(pool);
          expect(row.kind).toBe(model.kind);
        }
        expect(await service.status()).toEqual(settle(model, fc2.now(), cfg));
      }),
      { numRuns: 25 },
    );
  });
});
