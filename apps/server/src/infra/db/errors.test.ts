import { describe, expect, it } from 'vitest';
import { explainDbError, rootCode } from './errors';

const URL_ = 'postgres://vending:motdepasse-secret@localhost:5432/vending_dev';
const wrapped = (code: string) =>
  Object.assign(new Error('Failed query: CREATE SCHEMA IF NOT EXISTS "drizzle"'), { cause: Object.assign(new Error('x'), { code }) });

describe('rootCode', () => {
  it("traverse la cause de l'ORM et les AggregateError (IPv4 + IPv6)", () => {
    expect(rootCode(wrapped('ECONNREFUSED'))).toBe('ECONNREFUSED');
    expect(rootCode(Object.assign(new Error('agg'), { errors: [{ code: 'ECONNREFUSED' }, { code: 'ECONNREFUSED' }] }))).toBe(
      'ECONNREFUSED',
    );
    expect(rootCode(new Error('sans code'))).toBeUndefined();
    expect(rootCode('texte')).toBeUndefined();
  });
  it('ne boucle pas sur une cause circulaire', () => {
    const a: { cause?: unknown } = {};
    a.cause = a;
    expect(rootCode(a)).toBeUndefined();
  });
});

describe('explainDbError', () => {
  it('serveur arrêté : le message nomme le problème, pas « Failed query »', () => {
    const m = explainDbError(wrapped('ECONNREFUSED'), URL_);
    expect(m).toMatch(/injoignable sur localhost:5432/);
    expect(m).not.toMatch(/Failed query/);
  });
  it.each([['28P01'], ['28000']])('mot de passe ou rôle faux (%s)', (code) => {
    expect(explainDbError(wrapped(code), URL_)).toMatch(/rôle « vending » : mot de passe ou rôle incorrect/);
  });
  it('base inexistante (3D000) : donne la commande à lancer', () => {
    expect(explainDbError(wrapped('3D000'), URL_)).toContain('CREATE DATABASE vending_dev OWNER vending;');
  });
  it('droits insuffisants (42501) : renvoie vers le rôle propriétaire', () => {
    expect(explainDbError(wrapped('42501'), URL_)).toMatch(/PROPRIÉTAIRE/);
  });
  it('ne divulgue JAMAIS le mot de passe', () => {
    for (const c of ['ECONNREFUSED', '28P01', '3D000', '42501'])
      expect(explainDbError(wrapped(c), URL_)).not.toContain('motdepasse-secret');
  });
  it("erreur inconnue ou URL illisible : null / pas d'exception", () => {
    expect(explainDbError(new Error('autre'), URL_)).toBeNull();
    expect(explainDbError(wrapped('ECONNREFUSED'), 'pas une url')).toMatch(/injoignable/);
    expect(explainDbError(wrapped('ECONNREFUSED'), undefined)).toMatch(/injoignable/);
  });
});
