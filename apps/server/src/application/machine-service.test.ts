import { describe, expect, it } from 'vitest';
import { TIMEOUT_CONFIG } from '@vending/shared';
import type { Clock } from '../domain/clock';
import { IDLE } from '../domain/machine-state';
import { FakeClock } from '../testing/fake-clock';
import { FakeUnitOfWork } from '../testing/fake-uow';
import { MachineService } from './machine-service';

const cfg = TIMEOUT_CONFIG;
const T0 = 1_000_000;
const setup = () => {
  const uow = new FakeUnitOfWork();
  const clock = new FakeClock(T0);
  return { uow, clock, svc: new MachineService(uow, clock, cfg) };
};

describe('MachineService.apply', () => {
  it('ordre : verrou, PUIS horloge, PUIS écriture', async () => {
    const uow = new FakeUnitOfWork();
    const clock: Clock = { now: () => (uow.log.push('now'), T0) };
    await new MachineService(uow, clock, cfg).apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    expect(uow.log).toEqual(['loadForUpdate', 'now', 'save:CLIENT_ACTIVE']);
  });

  it('écrit l\'état accepté', async () => {
    const { uow, svc } = setup();
    const r = await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    expect(r.ok).toBe(true);
    expect(uow.state).toEqual({ kind: 'CLIENT_ACTIVE', userId: 'u1', startedAt: T0, lastActivityAt: T0, phase: 'SELECTING' });
  });

  it('un refus sans changement d\'état n\'écrit rien', async () => {
    const { uow, svc } = setup();
    await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    uow.log.length = 0;
    const r = await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u2' });
    expect(r).toMatchObject({ ok: false, error: 'MACHINE_BUSY' });
    expect(uow.log).toEqual(['loadForUpdate']);
  });

  it('un refus SESSION_EXPIRED PERSISTE le retour à IDLE', async () => {
    const { uow, clock, svc } = setup();
    await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    clock.advance(cfg.clientInactivityMs);
    const r = await svc.apply({ type: 'CLIENT_ACTIVITY', userId: 'u1' });
    expect(r).toMatchObject({ ok: false, error: 'SESSION_EXPIRED' });
    expect(uow.state).toEqual(IDLE);
    expect(uow.log.at(-1)).toBe('save:IDLE');
  });

  it('une exception dans la transaction annule l\'écriture', async () => {
    const { uow, svc } = setup();
    await expect(
      uow.run(async (tx) => {
        await tx.machine.save({ kind: 'MAINTENANCE', adminId: 'a1', startedAt: 1, lastActivityAt: 1 });
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(uow.state).toEqual(IDLE);
    expect((await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' })).ok).toBe(true);
  });
});

describe('MachineService.status', () => {
  it('état non expiré : lecture sans verrou, aucune écriture', async () => {
    const { uow, svc } = setup();
    await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    uow.log.length = 0;
    expect((await svc.status()).kind).toBe('CLIENT_ACTIVE');
    expect(uow.log).toEqual(['load']);
  });
  it('état expiré : verrou, retour à IDLE persisté', async () => {
    const { uow, clock, svc } = setup();
    await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    clock.advance(cfg.clientInactivityMs);
    uow.log.length = 0;
    expect(await svc.status()).toEqual(IDLE);
    expect(uow.state).toEqual(IDLE);
    expect(uow.log).toEqual(['load', 'loadForUpdate', 'save:IDLE']);
  });
  it('DISPENSING reste DISPENSING, même très tard', async () => {
    const { clock, svc } = setup();
    await svc.apply({ type: 'LOGIN_CLIENT', userId: 'u1' });
    await svc.apply({ type: 'START_DISPENSE', userId: 'u1' });
    clock.advance(3_600_000);
    expect(await svc.status()).toMatchObject({ kind: 'CLIENT_ACTIVE', phase: 'DISPENSING' });
  });
});
