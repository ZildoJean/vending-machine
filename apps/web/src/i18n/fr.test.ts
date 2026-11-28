import { describe, expect, it } from 'vitest';
import { API_ERROR_CODES } from '@vending/shared';
import { ApiError, NetworkError } from '../api/client';
import { ACTION_LABELS, GENERIC_MESSAGE, MESSAGES, NETWORK_MESSAGE, describeError } from './fr';

describe('messages', () => {
  it('chaque code du contrat a un message en français, non vide', () => {
    for (const code of API_ERROR_CODES) {
      expect(MESSAGES[code], code).toBeTruthy();
      expect(MESSAGES[code].length).toBeGreaterThan(5);
    }
    expect(Object.keys(MESSAGES).sort()).toEqual([...API_ERROR_CODES].sort()); // pas de code fantôme
  });
  it('aucun message ne divulgue de détail technique', () => {
    for (const m of Object.values(MESSAGES)) expect(m).not.toMatch(/stack|sql|postgres|argon|token|jeton|cookie/i);
  });
});

describe('describeError', () => {
  it('erreur réseau', () => expect(describeError(new NetworkError())).toBe(NETWORK_MESSAGE));
  it('erreur inconnue ou non API', () => {
    expect(describeError(new Error('boom'))).toBe(GENERIC_MESSAGE);
    expect(describeError('x')).toBe(GENERIC_MESSAGE);
    expect(describeError(new ApiError(502, 'UNKNOWN', 'x'))).toBe(GENERIC_MESSAGE);
  });
  it('détails intégrés : montant manquant, plafond, stock, secret', () => {
    expect(describeError(new ApiError(422, 'INSUFFICIENT_FUNDS', 'x', { missingAr: 1_500 }))).toBe(
      'Solde insuffisant : il manque 1\u00A0500\u00A0Ar.',
    );
    expect(describeError(new ApiError(422, 'CART_EXCEEDS_CAP', 'x', { totalAr: 120_000 }))).toContain('120\u00A0000\u00A0Ar');
    expect(describeError(new ApiError(422, 'STOCK_OUT_OF_RANGE', 'x', { resultingStock: -3 }))).toContain('-3');
    expect(describeError(new ApiError(422, 'INVALID_SECRET', 'x', { reason: 'WEAK' }))).toContain('trop simple');
    expect(describeError(new ApiError(422, 'INVALID_SECRET', 'x', { reason: 'BAD_FORMAT' }))).toContain('6 chiffres');
  });
  it('sans détails : message par code', () => {
    expect(describeError(new ApiError(409, 'MACHINE_BUSY', 'x'))).toBe(MESSAGES.MACHINE_BUSY);
    expect(describeError(new ApiError(422, 'INSUFFICIENT_FUNDS', 'x'))).toBe(MESSAGES.INSUFFICIENT_FUNDS);
  });
});

describe("libellés d'audit", () => {
  it('couvrent toutes les actions écrites par le serveur', () => {
    for (const a of [
      'ADMIN_LOGIN',
      'ADMIN_CREATE',
      'MAINTENANCE_ENTER',
      'MAINTENANCE_EXIT',
      'SESSION_FORCE_CLOSE',
      'PRODUCT_CREATE',
      'PRODUCT_UPDATE',
      'STOCK_RESTOCK',
      'STOCK_ADJUST',
      'USER_CREATE',
      'USER_PIN_RESET',
    ]) {
      expect(ACTION_LABELS[a], a).toBeTruthy();
    }
  });
});
