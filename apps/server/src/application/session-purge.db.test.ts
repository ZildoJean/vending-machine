import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTH_POLICY } from '@vending/shared';
import { ADMIN_LOGIN, ADMIN_PASSWORD, createHarness } from '../testing/http-harness';
import type { Harness } from '../testing/http-harness';
import { resetMachine } from '../testing/pg-fixtures';

let h: Harness;
beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
const count = async () => Number((await h.pool.query('SELECT count(*) AS n FROM sessions')).rows[0].n);

describe('purge des sessions mortes', () => {
  it('supprime les sessions administrateur expirées ou inactives, garde les vivantes', async () => {
    await h.pool.query('DELETE FROM sessions');
    await h.login(ADMIN_LOGIN, ADMIN_PASSWORD);
    expect(await h.services.auth.purgeStaleSessions()).toBe(0); // vivante : rien à supprimer
    h.clock.advance(AUTH_POLICY.adminIdleMs);
    expect(await h.services.auth.purgeStaleSessions()).toBe(1);
    expect(await count()).toBe(0);
  });

  it("une session client ancienne est supprimée SEULEMENT si elle n'est plus celle de la machine", async () => {
    await resetMachine(h.pool);
    await h.pool.query('DELETE FROM sessions');
    await h.createClient('purgecli', '135792');
    await h.login('purgecli', '135792');
    h.clock.advance(25 * 3_600_000); // plus de 24 h, mais la machine désigne encore cette session
    expect(await h.services.auth.purgeStaleSessions()).toBe(0);
    await resetMachine(h.pool); // la machine n'est plus à ce client
    expect(await h.services.auth.purgeStaleSessions()).toBe(1);
  });

  it("une session client récente et morte n'est pas touchée avant 24 h (nettoyée à la demande)", async () => {
    await resetMachine(h.pool);
    await h.pool.query('DELETE FROM sessions');
    await h.createClient('purgecli2', '135792');
    await h.login('purgecli2', '135792');
    await resetMachine(h.pool);
    expect(await h.services.auth.purgeStaleSessions()).toBe(0);
    expect(await count()).toBe(1);
  });
});
