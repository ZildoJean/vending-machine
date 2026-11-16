import { describe, expect, it } from 'vitest';
import { formatAr } from './money';

describe('formatAr', () => {
  it.each([
    [0, '0\u00A0Ar'],
    [100, '100\u00A0Ar'],
    [1_000, '1\u00A0000\u00A0Ar'],
    [20_000, '20\u00A0000\u00A0Ar'],
    [100_000, '100\u00A0000\u00A0Ar'],
    [-1_500, '-1\u00A0500\u00A0Ar'],
  ])('%i -> %s', (n, expected) => {
    expect(formatAr(n)).toBe(expected);
  });

  it.each([1.5, NaN, Infinity, 1e21])('refuse %s', (n) => {
    expect(() => formatAr(n)).toThrow(RangeError);
  });
});
