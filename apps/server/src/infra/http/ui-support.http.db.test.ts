import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { API_ERROR_CODES, AUTH_POLICY, TIMEOUT_CONFIG } from '@vending/shared';
import { resetMachine } from '../../testing/pg-fixtures';
import { createHarness } from '../../testing/http-harness';
import type { Harness } from '../../testing/http-harness';

let h: Harness;
let admin: string;
let n = 0;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await resetMachine(h.pool);
  await h.pool.query('DELETE FROM sessions');
  admin = await h.loginAdmin();
});
const uniq = (p: string): string => `${p}${++n}x`;
const json = <T = Record<string, any>>(res: { body: string }): T => JSON.parse(res.body) as T;

describe('GET /me : temps restant calculé par le serveur', () => {
  it('client : 2 min au départ, diminue avec le temps, ne dépend pas de la lecture', async () => {
    const login = uniq('rem');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    expect(json(await h.call('GET', '/me', { cookie: token })).remainingMs).toBe(TIMEOUT_CONFIG.clientInactivityMs);
    h.clock.advance(45_000);
    expect(json(await h.call('GET', '/me', { cookie: token })).remainingMs).toBe(TIMEOUT_CONFIG.clientInactivityMs - 45_000);
  });
  it('une action (dépôt) remet le compteur à 2 min', async () => {
    const login = uniq('act');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    h.clock.advance(100_000);
    await h.call('POST', '/wallet/deposit', { cookie: token, body: { bill: 1_000, insertionId: crypto.randomUUID() } });
    expect(json(await h.call('GET', '/me', { cookie: token })).remainingMs).toBe(TIMEOUT_CONFIG.clientInactivityMs);
  });
  it("administrateur : borné par l'inactivité (30 min) et par la durée absolue", async () => {
    const r = json(await h.call('GET', '/me', { cookie: admin }));
    expect(r.role).toBe('ADMIN');
    expect(r.remainingMs).toBe(AUTH_POLICY.adminIdleMs);
  });
});

describe('GET /admin/machine', () => {
  it('IDLE, IN_USE (sans identité), MAINTENANCE avec propriétaire et temps restant', async () => {
    expect(json(await h.call('GET', '/admin/machine', { cookie: admin }))).toEqual({ status: 'IDLE' });
    const login = uniq('use');
    await h.createClient(login, '135792');
    await h.login(login, '135792');
    const busy = await h.call('GET', '/admin/machine', { cookie: admin });
    expect(json(busy)).toEqual({ status: 'IN_USE', phase: 'SELECTING' });
    expect(busy.body).not.toContain(login);
    await h.call('POST', '/admin/session/force-close', { cookie: admin });
    await h.call('POST', '/admin/maintenance/enter', { cookie: admin });
    h.clock.advance(60_000);
    expect(json(await h.call('GET', '/admin/machine', { cookie: admin }))).toEqual({
      status: 'MAINTENANCE',
      ownedByMe: true,
      remainingMs: TIMEOUT_CONFIG.maintenanceInactivityMs - 60_000,
    });
  });
  it('maintenance expirée : IDLE ; autre administrateur : ownedByMe = false ; client : 403', async () => {
    await h.call('POST', '/admin/maintenance/enter', { cookie: admin });
    const second = await h.services.admin.createAdmin(uniq('boss'), 'Autre-mot-de-passe-99');
    const login = (await h.pool.query('SELECT login FROM users WHERE id = $1', [second.ok ? second.value.id : ''])).rows[0].login as string;
    const tok2 = (await h.login(login, 'Autre-mot-de-passe-99')).token;
    expect(json(await h.call('GET', '/admin/machine', { cookie: tok2 })).ownedByMe).toBe(false);
    h.clock.advance(TIMEOUT_CONFIG.maintenanceInactivityMs);
    expect(json(await h.call('GET', '/admin/machine', { cookie: tok2 }))).toEqual({ status: 'IDLE' });
    const cl = uniq('forb');
    await h.createClient(cl, '135792');
    const { token } = await h.login(cl, '135792');
    expect((await h.call('GET', '/admin/machine', { cookie: token })).statusCode).toBe(403);
  });
});

describe('GET /admin/users', () => {
  it("liste les CLIENTS seulement, sans aucun secret, avec l'état de verrouillage", async () => {
    const login = uniq('lst');
    await h.createClient(login, '135792');
    for (let i = 0; i < AUTH_POLICY.maxAttempts; i++) await h.login(login, '000999');
    const res = await h.call('GET', '/admin/users', { cookie: admin });
    expect(res.statusCode).toBe(200);
    const users = json<{ users: { id: string; login: string; locked: boolean }[] }>(res).users;
    expect(users.find((u) => u.login === login)).toMatchObject({ locked: true });
    expect(users.some((u) => u.id === h.adminId)).toBe(false);
    expect(res.body).not.toMatch(/argon2|pin_hash|secret/i);
    h.clock.advance(AUTH_POLICY.lockMs);
    expect(
      json<{ users: { login: string; locked: boolean }[] }>(await h.call('GET', '/admin/users', { cookie: admin })).users.find(
        (u) => u.login === login,
      )?.locked,
    ).toBe(false);
  });
  it('refusé aux clients et sans session', async () => {
    expect((await h.call('GET', '/admin/users')).statusCode).toBe(401);
    const login = uniq('cl');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    expect((await h.call('GET', '/admin/users', { cookie: token })).statusCode).toBe(403);
  });
});

describe("contrat des codes d'erreur", () => {
  it("la liste partagée n'a pas de doublon", () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
  it('les erreurs réellement émises appartiennent à la liste', async () => {
    const samples = [
      await h.call('GET', '/me'),
      await h.call('GET', '/nimporte'),
      await h.call('POST', '/auth/login', { body: {} }),
      await h.call('POST', '/auth/login', { origin: 'https://evil.example', body: { login: 'a', secret: 'b' } }),
      await h.login('inconnu', '123123').then((r) => r.res),
    ];
    for (const r of samples) expect(API_ERROR_CODES).toContain(json(r).error.code);
  });
});
