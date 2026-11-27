import { createHmac } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import type { SecretHasher } from '../../application/ports';

export interface Argon2Options {
  /** Poivre secret (hors base de données) : sans lui, une fuite de la base ne permet PAS de retrouver un PIN à 6 chiffres. */
  readonly pepper: string;
  readonly memoryCost?: number;
  readonly timeCost?: number;
}

export class Argon2SecretHasher implements SecretHasher {
  constructor(private readonly opts: Argon2Options) {
    if (opts.pepper.length < 32) throw new RangeError('Le poivre doit faire au moins 32 caractères');
  }
  private prehash(secret: string): string {
    return createHmac('sha256', this.opts.pepper).update(secret).digest('base64');
  }
  hash(secret: string): Promise<string> {
    return hash(this.prehash(secret), {
      memoryCost: this.opts.memoryCost ?? 19_456, // 19 Mio : recommandation OWASP pour argon2id
      timeCost: this.opts.timeCost ?? 2,
      parallelism: 1,
    });
  }
  async verify(hashed: string, secret: string): Promise<boolean> {
    try {
      return await verify(hashed, this.prehash(secret));
    } catch {
      return false; // hachage illisible : jamais d'exception vers l'appelant
    }
  }
}
