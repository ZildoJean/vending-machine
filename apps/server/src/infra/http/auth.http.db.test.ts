import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AUTH_POLICY, TIMEOUT_CONFIG } from '@vending/shared';
import { resetMachine, readMachineRow } from '../../testing/pg-fixtures';
import { ScriptedDispenser } from '../../testing/scripted-dispenser';
import { hashToken } from '../../application/auth-service';
import { ADMIN_LOGIN, ADMIN_PASSWORD, createHarness, ORIGIN, T0 } from '../../testing/http-harness';
import type { Harness } from '../../testing/http-harness';
import { SESSION_COOKIE } from './app';

let h: Harness;
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
  h.clock.advance(0);
});
const uniq = (p: string): string => `${p}${++n}x`;
const body = (res: { body: string }) => JSON.parse(res.body) as { error: { code: string; message: string } };

describe('connexion client', () => {
  it('identifiants valides : 200, cookie httpOnly + SameSite=Strict + Secure, aucun jeton dans le corps', async () => {
    const login = uniq('alice');
    await h.createClient(login, '135792');
    const { res, token } = await h.login(login, '135792');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ role: 'CLIENT', login });
    expect(res.body).not.toContain(token ?? 'x');
    const c = res.cookies.find((k) => k.name === SESSION_COOKIE);
    expect(c).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    expect(c?.maxAge).toBeUndefined(); // cookie de session
    expect(token?.length).toBeGreaterThanOrEqual(40);
  });

  it("le jeton n'est JAMAIS stocké : seulement son SHA-256", async () => {
    const login = uniq('bob');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    const rows = (await h.pool.query('SELECT token_hash FROM sessions')).rows as { token_hash: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).toBe(hashToken(token as string));
    expect(rows[0]?.token_hash).not.toBe(token);
    expect(rows[0]?.token_hash).toHaveLength(64);
  });

  it("le PIN n'est pas stocké en clair : hachage argon2id", async () => {
    const login = uniq('carol');
    await h.createClient(login, '135792');
    const r = await h.pool.query('SELECT pin_hash FROM users WHERE login = $1', [login]);
    expect((r.rows[0] as { pin_hash: string }).pin_hash).toMatch(/^\$argon2id\$/);
    expect((r.rows[0] as { pin_hash: string }).pin_hash).not.toContain('135792');
  });

  it('login insensible à la casse', async () => {
    const login = uniq('Dora');
    await h.createClient(login, '135792');
    expect((await h.login(login.toUpperCase(), '135792')).res.statusCode).toBe(200);
  });

  it("inconnu, mauvais PIN : réponses STRICTEMENT identiques (pas d'énumération de comptes)", async () => {
    const login = uniq('erin');
    await h.createClient(login, '135792');
    const wrong = await h.login(login, '999111');
    const unknown = await h.login(uniq('personne'), '999111');
    expect(wrong.res.statusCode).toBe(401);
    expect(unknown.res.statusCode).toBe(401);
    expect(wrong.res.body).toBe(unknown.res.body);
    expect(body(wrong.res).error.code).toBe('INVALID_CREDENTIALS');
  });

  it('autre client déjà en session : identifiants faux -> 401 (rien révélé), corrects -> 409 MACHINE_BUSY', async () => {
    const [a, b] = [uniq('fay'), uniq('gus')];
    await h.createClient(a, '135792');
    await h.createClient(b, '246813');
    expect((await h.login(a, '135792')).res.statusCode).toBe(200);
    expect((await h.login(b, '000999')).res.statusCode).toBe(401);
    const busy = await h.login(b, '246813');
    expect(busy.res.statusCode).toBe(409);
    expect(body(busy.res).error.code).toBe('MACHINE_BUSY');
    expect(busy.token).toBeUndefined();
  });

  it("même client qui se reconnecte : accepté, l'ancien jeton est révoqué", async () => {
    const login = uniq('hana');
    await h.createClient(login, '135792');
    const first = await h.login(login, '135792');
    const second = await h.login(login, '135792');
    expect(second.res.statusCode).toBe(200);
    expect((await h.call('GET', '/me', { cookie: first.token })).statusCode).toBe(401);
    expect((await h.call('GET', '/me', { cookie: second.token })).statusCode).toBe(200);
  });

  it('machine en maintenance : 503 OUT_OF_SERVICE', async () => {
    const login = uniq('ivan');
    await h.createClient(login, '135792');
    const admin = await h.loginAdmin();
    expect((await h.call('POST', '/admin/maintenance/enter', { cookie: admin })).statusCode).toBe(200);
    const r = await h.login(login, '135792');
    expect(r.res.statusCode).toBe(503);
    expect(body(r.res).error.code).toBe('OUT_OF_SERVICE');
    await h.call('POST', '/admin/maintenance/exit', { cookie: admin });
  });
});

describe('verrouillage du compte', () => {
  it('5 mauvais PIN verrouillent : même le BON PIN est refusé (réponse identique), puis déverrouillage dans le temps', async () => {
    const login = uniq('jules');
    await h.createClient(login, '135792');
    for (let i = 0; i < AUTH_POLICY.maxAttempts; i++) expect((await h.login(login, '000999')).res.statusCode).toBe(401);
    const locked = await h.login(login, '135792');
    expect(locked.res.statusCode).toBe(401);
    expect(body(locked.res).error.code).toBe('INVALID_CREDENTIALS');
    h.clock.advance(AUTH_POLICY.lockMs - 1);
    expect((await h.login(login, '135792')).res.statusCode).toBe(401); // encore verrouillé à 1 ms près
    h.clock.advance(1);
    expect((await h.login(login, '135792')).res.statusCode).toBe(200);
  });

  it('après déverrouillage, le compteur repart de zéro (pas de re-verrouillage immédiat)', async () => {
    const login = uniq('kim');
    await h.createClient(login, '135792');
    for (let i = 0; i < AUTH_POLICY.maxAttempts; i++) await h.login(login, '000999');
    h.clock.advance(AUTH_POLICY.lockMs);
    expect((await h.login(login, '000999')).res.statusCode).toBe(401); // 1re tentative d'une nouvelle série
    expect((await h.login(login, '135792')).res.statusCode).toBe(200);
  });

  it('un succès remet le compteur à zéro', async () => {
    const login = uniq('lea');
    await h.createClient(login, '135792');
    for (let i = 0; i < AUTH_POLICY.maxAttempts - 1; i++) await h.login(login, '000999');
    expect((await h.login(login, '135792')).res.statusCode).toBe(200);
    await h.pool.query('DELETE FROM sessions');
    await resetMachine(h.pool);
    for (let i = 0; i < AUTH_POLICY.maxAttempts - 1; i++) await h.login(login, '000999');
    expect((await h.login(login, '135792')).res.statusCode).toBe(200); // pas verrouillé
  });

  it('50 tentatives PARALLÈLES : au plus 5 sont réellement vérifiées (pas de contournement par concurrence)', async () => {
    const login = uniq('max');
    await h.createClient(login, '135792');
    const stored = ((await h.pool.query('SELECT pin_hash FROM users WHERE login = $1', [login])).rows[0] as { pin_hash: string }).pin_hash;
    h.hasher.verified.length = 0;
    const results = await Promise.all(Array.from({ length: 50 }, (_, i) => h.login(login, String(100_000 + i))));
    expect(results.every((r) => r.res.statusCode === 401)).toBe(true);
    expect(h.hasher.verified.filter((x) => x === stored).length).toBeLessThanOrEqual(AUTH_POLICY.maxAttempts);
    const row = (await h.pool.query('SELECT failed_attempts, locked_until FROM users WHERE login = $1', [login])).rows[0] as {
      failed_attempts: number;
      locked_until: string | null;
    };
    expect(row.failed_attempts).toBe(AUTH_POLICY.maxAttempts);
    expect(Number(row.locked_until)).toBe(h.clock.now() + AUTH_POLICY.lockMs);
  });

  it("un login inconnu coûte autant qu'un vrai : une vérification factice est faite", async () => {
    h.hasher.verified.length = 0;
    await h.login(uniq('fantome'), '123123');
    expect(h.hasher.verified).toHaveLength(1);
  });
});

describe('validité des sessions', () => {
  it('sans cookie, cookie invalide ou jeton inconnu : 401', async () => {
    expect((await h.call('GET', '/me')).statusCode).toBe(401);
    expect((await h.call('GET', '/me', { cookie: 'x'.repeat(43) })).statusCode).toBe(401);
    expect((await h.call('GET', '/me', { cookie: 'court' })).statusCode).toBe(401);
    expect((await h.call('GET', '/products')).statusCode).toBe(401);
    expect((await h.call('GET', '/wallet')).statusCode).toBe(401);
  });

  it('inactivité de 2 min : la session client expire (401 SESSION_EXPIRED, cookie effacé)', async () => {
    const login = uniq('nina');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    h.clock.advance(TIMEOUT_CONFIG.clientInactivityMs - 1);
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(200);
    h.clock.advance(1);
    const r = await h.call('GET', '/me', { cookie: token });
    expect(r.statusCode).toBe(401);
    expect(body(r).error.code).toBe('SESSION_EXPIRED');
    expect(r.cookies.find((c) => c.name === SESSION_COOKIE)?.value).toBe('');
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(401); // la ligne de session a été supprimée
  });

  it('une simple lecture NE prolonge PAS la session client (seules les actions comptent)', async () => {
    const login = uniq('omar');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    for (let i = 0; i < 3; i++) {
      h.clock.advance(TIMEOUT_CONFIG.clientInactivityMs / 3);
      await h.call('GET', '/wallet', { cookie: token });
    }
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(401);
  });

  it("jeton d'une session précédente (nouveau propriétaire entre-temps) : refusé", async () => {
    const [a, b] = [uniq('pia'), uniq('quin')];
    await h.createClient(a, '135792');
    await h.createClient(b, '246813');
    const first = await h.login(a, '135792');
    h.clock.advance(TIMEOUT_CONFIG.clientInactivityMs);
    expect((await h.login(b, '246813')).res.statusCode).toBe(200); // a expiré : b prend la machine
    expect((await h.call('GET', '/me', { cookie: first.token })).statusCode).toBe(401);
  });

  it('un jeton client ne donne pas accès aux routes admin (403) et inversement', async () => {
    const login = uniq('rita');
    await h.createClient(login, '135792');
    const client = (await h.login(login, '135792')).token;
    const admin = await h.loginAdmin();
    expect((await h.call('GET', '/admin/products', { cookie: client })).statusCode).toBe(403);
    expect((await h.call('POST', '/admin/maintenance/enter', { cookie: client })).statusCode).toBe(403);
    expect((await h.call('GET', '/products', { cookie: admin })).statusCode).toBe(403);
    expect((await h.call('GET', '/wallet', { cookie: admin })).statusCode).toBe(403);
  });

  it('déconnexion : jeton révoqué, machine libérée', async () => {
    const login = uniq('sam');
    await h.createClient(login, '135792');
    const { token } = await h.login(login, '135792');
    const out = await h.call('POST', '/auth/logout', { cookie: token });
    expect(out.statusCode).toBe(204);
    expect((await h.call('GET', '/me', { cookie: token })).statusCode).toBe(401);
    expect((await readMachineRow(h.pool)).kind).toBe('IDLE');
    expect((await h.call('POST', '/auth/logout', { cookie: token })).statusCode).toBe(204); // idempotent
  });

  it('déconnexion refusée pendant la distribution', async () => {
    const slow = await createHarness({
      dispenser: new ScriptedDispenser(async () => (await new Promise((r) => setTimeout(r, 400)), { delivered: true })),
    });
    try {
      const login = 'tom1x';
      await slow.createClient(login, '135792', 5_000);
      const prod = await slow.product(1_000, 5);
      const { token } = await slow.login(login, '135792');
      const order = slow.call('POST', '/orders', {
        cookie: token,
        headers: { 'idempotency-key': 'key-logout-test-1' },
        body: { items: [{ productId: prod, qty: 1 }] },
      });
      await new Promise((r) => setTimeout(r, 150));
      const out = await slow.call('POST', '/auth/logout', { cookie: token });
      expect(out.statusCode).toBe(409);
      expect(JSON.parse(out.body).error.code).toBe('DISPENSING_IN_PROGRESS');
      expect((await order).statusCode).toBe(200);
    } finally {
      await slow.close();
    }
  });
});

describe('administrateur', () => {
  it('connexion admin : cookie de 8 h, audit ADMIN_LOGIN, pas de prise de la machine', async () => {
    const { res } = await h.login(ADMIN_LOGIN, ADMIN_PASSWORD);
    expect(res.statusCode).toBe(200);
    expect(res.cookies.find((c) => c.name === SESSION_COOKIE)?.maxAge).toBe(AUTH_POLICY.adminAbsoluteMs / 1000);
    expect((await readMachineRow(h.pool)).kind).toBe('IDLE');
    const audit = await h.pool.query(`SELECT 1 FROM audit_log WHERE action = 'ADMIN_LOGIN'`);
    expect(audit.rowCount).toBeGreaterThan(0);
  });

  it('inactivité de 30 min : session admin expirée', async () => {
    const token = await h.loginAdmin();
    h.clock.advance(AUTH_POLICY.adminIdleMs - 1);
    expect((await h.call('GET', '/admin/products', { cookie: token })).statusCode).toBe(200); // renouvelle l'activité
    h.clock.advance(AUTH_POLICY.adminIdleMs);
    const r = await h.call('GET', '/admin/products', { cookie: token });
    expect(r.statusCode).toBe(401);
    expect(body(r).error.code).toBe('SESSION_EXPIRED');
  });

  it('durée absolue de 8 h, même avec une activité continue (pas de 20 min < inactivité de 30 min)', async () => {
    const token = await h.loginAdmin();
    const steps = AUTH_POLICY.adminAbsoluteMs / (20 * 60_000); // 24
    for (let i = 1; i <= steps; i++) {
      h.clock.advance(20 * 60_000);
      const r = await h.call('GET', '/admin/products', { cookie: token });
      expect(r.statusCode).toBe(i < steps ? 200 : 401);
    }
  });

  it("la déconnexion de l'admin le fait sortir de la maintenance", async () => {
    const token = await h.loginAdmin();
    await h.call('POST', '/admin/maintenance/enter', { cookie: token });
    expect((await readMachineRow(h.pool)).kind).toBe('MAINTENANCE');
    await h.call('POST', '/auth/logout', { cookie: token });
    expect((await readMachineRow(h.pool)).kind).toBe('IDLE');
  });

  it('mauvais mot de passe admin : mêmes règles de verrouillage', async () => {
    for (let i = 0; i < AUTH_POLICY.maxAttempts; i++) expect((await h.login(ADMIN_LOGIN, 'mauvais-mot-de-passe')).res.statusCode).toBe(401);
    expect((await h.login(ADMIN_LOGIN, ADMIN_PASSWORD)).res.statusCode).toBe(401);
    h.clock.advance(AUTH_POLICY.lockMs);
    expect((await h.login(ADMIN_LOGIN, ADMIN_PASSWORD)).res.statusCode).toBe(200);
  });
});

void ORIGIN;
void T0;
