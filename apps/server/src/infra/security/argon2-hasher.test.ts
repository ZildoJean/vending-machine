import { describe, expect, it } from 'vitest';
import { Argon2SecretHasher } from './argon2-hasher';

const fast = { memoryCost: 8_192, timeCost: 1 };
const A = 'poivre-A-poivre-A-poivre-A-poivre-A-1234';
const B = 'poivre-B-poivre-B-poivre-B-poivre-B-1234';

describe('Argon2SecretHasher', () => {
  it('hache en argon2id, sans jamais contenir le secret', async () => {
    const h = await new Argon2SecretHasher({ pepper: A, ...fast }).hash('135792');
    expect(h).toMatch(/^\$argon2id\$/);
    expect(h).not.toContain('135792');
  });
  it('vérifie le bon secret, refuse le mauvais', async () => {
    const hasher = new Argon2SecretHasher({ pepper: A, ...fast });
    const h = await hasher.hash('135792');
    expect(await hasher.verify(h, '135792')).toBe(true);
    expect(await hasher.verify(h, '135793')).toBe(false);
  });
  it('deux hachages du même secret diffèrent (sel aléatoire)', async () => {
    const hasher = new Argon2SecretHasher({ pepper: A, ...fast });
    expect(await hasher.hash('135792')).not.toBe(await hasher.hash('135792'));
  });
  it('le POIVRE compte : avec un autre poivre, la même base ne valide plus le bon PIN', async () => {
    const h = await new Argon2SecretHasher({ pepper: A, ...fast }).hash('135792');
    expect(await new Argon2SecretHasher({ pepper: B, ...fast }).verify(h, '135792')).toBe(false);
  });
  it('un hachage illisible renvoie false, jamais une exception', async () => {
    const hasher = new Argon2SecretHasher({ pepper: A, ...fast });
    expect(await hasher.verify('pas-un-hash', '135792')).toBe(false);
    expect(await hasher.verify('', '135792')).toBe(false);
  });
  it('poivre trop court refusé', () => {
    expect(() => new Argon2SecretHasher({ pepper: 'court' })).toThrow(RangeError);
  });
});
