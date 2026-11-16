import { describe, expect, it } from 'vitest';
import { ok } from '@vending/shared';

describe('liaison workspace', () => {
  it('le serveur importe @vending/shared', () => {
    expect(ok(1).ok).toBe(true);
  });
});
