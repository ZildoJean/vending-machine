import { describe, expect, it } from 'vitest';
import { err, ok } from './result';

describe('Result', () => {
  it('ok() porte la valeur', () => {
    expect(ok(5)).toEqual({ ok: true, value: 5 });
  });
  it('err() porte l\'erreur', () => {
    expect(err('X')).toEqual({ ok: false, error: 'X' });
  });
});
