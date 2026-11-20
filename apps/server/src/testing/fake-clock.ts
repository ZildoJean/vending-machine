import type { Clock } from '../domain/clock';

export class FakeClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    if (!Number.isSafeInteger(ms) || ms < 0) throw new RangeError('advance: entier >= 0 attendu');
    this.t += ms;
  }
}
