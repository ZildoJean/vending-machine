import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { createTestDb, explainTestDbProblem } from './pg-test-db';

const ADMIN = process.env.TEST_PG_ADMIN_URL ?? 'postgres://vending:vending@localhost:5432/postgres';
const urlWith = (user: string, password: string, port?: string): string => {
  const u = new URL(ADMIN);
  u.username = user;
  u.password = password;
  if (port !== undefined) u.port = port;
  return u.toString();
};

describe("explainTestDbProblem : consignes claires quand l'environnement de test est mal réglé", () => {
  it('rôle sans CREATEDB (SQLSTATE 42501) : donne la commande exacte et les alternatives par système', () => {
    const msg = explainTestDbProblem({ code: '42501' }, 'postgres://vending:x@localhost:5432/postgres');
    expect(msg).toContain('ALTER ROLE "vending" CREATEDB CREATEROLE;');
    expect(msg).toContain('TEST_PG_ADMIN_URL');
    expect(msg).toMatch(/PowerShell/);
    expect(msg).not.toContain('postgres://vending:x'); // jamais le mot de passe
  });
  it('mot de passe incorrect : masque le mot de passe', () => {
    const msg = explainTestDbProblem({ code: '28P01' }, 'postgres://vending:secret@localhost:5432/postgres');
    expect(msg).toMatch(/mot de passe ou rôle incorrect/);
    expect(msg).not.toContain('secret');
  });
  it('serveur arrêté ou mauvais port, y compris via AggregateError (localhost IPv4 + IPv6)', () => {
    expect(explainTestDbProblem({ code: 'ECONNREFUSED' }, 'postgres://a:b@localhost:5433/postgres')).toContain('localhost:5433');
    expect(explainTestDbProblem({ errors: [{ code: 'ECONNREFUSED' }] }, 'postgres://a:b@localhost:5432/postgres')).toMatch(/injoignable/);
  });
  it('erreur inconnue : aucune consigne inventée', () => {
    expect(explainTestDbProblem({ code: 'XX000' }, ADMIN)).toBeNull();
  });
});

describe('createTestDb contre un vrai PostgreSQL', () => {
  it('rôle réel SANS CREATEDB : erreur explicite avec la solution (et non une erreur brute)', async (ctx) => {
    const role = `limite_${randomBytes(4).toString('hex')}`;
    const admin = new Pool({ connectionString: ADMIN, max: 1 });
    try {
      try {
        await admin.query(`CREATE ROLE ${role} LOGIN PASSWORD 'pw-test-123'`);
      } catch {
        ctx.skip(); // ce rôle de test ne peut pas créer de rôle : cas non testable ici
      }
      await expect(createTestDb(urlWith(role, 'pw-test-123'))).rejects.toThrow(new RegExp(`ALTER ROLE "${role}" CREATEDB`));
    } finally {
      await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
      await admin.end();
    }
  });

  it('mauvais mot de passe et mauvais port : consignes claires', async () => {
    await expect(createTestDb(urlWith('role_inexistant', 'mauvais'))).rejects.toThrow(/mot de passe ou rôle incorrect/);
    await expect(createTestDb(urlWith('x', 'y', '1'))).rejects.toThrow(/injoignable/);
  });
});
