import { describe, expect, it } from 'vitest';
import { loadConfig } from './config';

const base = { DATABASE_URL: 'postgres://u:p@h/db', PIN_PEPPER: 'x'.repeat(40) };

describe('loadConfig', () => {
  it('valeurs par défaut sûres en développement', () => {
    const c = loadConfig(base);
    expect(c).toMatchObject({
      env: 'development',
      port: 3000,
      host: '127.0.0.1',
      cookieSecure: false,
      trustProxy: false,
      allowedOrigins: ['http://localhost:5173'],
    });
  });
  it('production : cookie Secure par défaut', () => {
    expect(loadConfig({ ...base, NODE_ENV: 'production' }).cookieSecure).toBe(true);
  });
  it('production : COOKIE_SECURE=false refusé', () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/COOKIE_SECURE/);
  });
  it("production : poivre d'exemple refusé", () => {
    expect(() => loadConfig({ ...base, NODE_ENV: 'production', PIN_PEPPER: 'CHANGE-ME-' + 'x'.repeat(30) })).toThrow(/valeur d'exemple/);
  });
  it('base ou poivre manquant / trop court', () => {
    expect(() => loadConfig({ PIN_PEPPER: base.PIN_PEPPER })).toThrow(/DATABASE_URL/);
    expect(() => loadConfig({ DATABASE_URL: base.DATABASE_URL })).toThrow(/PIN_PEPPER/);
    expect(() => loadConfig({ ...base, PIN_PEPPER: 'court' })).toThrow(/32 caractères/);
  });
  it("le message d'erreur ne révèle jamais la valeur du poivre", () => {
    try {
      loadConfig({ ...base, PIN_PEPPER: 'secret-trop-court' });
      expect.unreachable();
    } catch (e) {
      expect(String(e)).not.toContain('secret-trop-court');
    }
  });
  it('origines : liste séparée par des virgules, forme stricte', () => {
    expect(loadConfig({ ...base, ALLOWED_ORIGINS: 'https://a.example, https://b.example:8443' }).allowedOrigins).toEqual([
      'https://a.example',
      'https://b.example:8443',
    ]);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: 'https://a.example/chemin' })).toThrow(/origine incorrecte/);
    expect(() => loadConfig({ ...base, ALLOWED_ORIGINS: 'pas-une-url' })).toThrow(/origine incorrecte/);
  });
  it('limitation de débit : valeurs par défaut sûres, réglables, bornées', () => {
    expect(loadConfig(base).limits).toEqual({ windowMs: 60_000, globalMax: 300, loginMax: 10, depositMax: 60 });
    expect(loadConfig({ ...base, RATE_LIMIT_LOGIN_MAX: '50' }).limits.loginMax).toBe(50);
    expect(() => loadConfig({ ...base, RATE_LIMIT_LOGIN_MAX: '1' })).toThrow(/RATE_LIMIT_LOGIN_MAX/); // trop bas : le verrouillage de compte serait contourné par l'attente
    expect(() => loadConfig({ ...base, RATE_LIMIT_GLOBAL_MAX: 'beaucoup' })).toThrow(/RATE_LIMIT_GLOBAL_MAX/);
  });
  it('port hors bornes refusé', () => {
    expect(() => loadConfig({ ...base, PORT: '70000' })).toThrow(/PORT/);
  });
});
