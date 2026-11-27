import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Le Caddyfile impose « script-src 'self'; style-src 'self' » : aucun script ni style en ligne.
 * Ces tests empêchent d'en introduire un par inadvertance (l'interface serait alors BLOQUÉE en production).
 */
const root = join(__dirname, '..');
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const sources = walk(join(root, 'src')).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\./.test(f) && !f.includes('/test/'));

describe('compatibilité avec la CSP stricte', () => {
  it('index.html : aucun script ni style en ligne', () => {
    const html = readFileSync(join(root, 'index.html'), 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, tag).toMatch(/\bsrc=/);
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i); // onclick=...
  });
  it('sources : aucun style en ligne, innerHTML, eval ni new Function', () => {
    expect(sources.length).toBeGreaterThan(10);
    for (const f of sources) {
      const s = readFileSync(f, 'utf8');
      expect(s, f).not.toMatch(/\bstyle=\{/);
      expect(s, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|\beval\(|new Function\(/);
    }
  });
  it('build (si présent) : index.html compilé sans script en ligne', () => {
    const dist = join(root, 'dist', 'index.html');
    if (!existsSync(dist)) return;
    const html = readFileSync(dist, 'utf8');
    for (const tag of html.match(/<script\b[^>]*>/g) ?? []) expect(tag, tag).toMatch(/\bsrc=/);
    for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) expect((m[1] ?? '').trim(), 'script en ligne').toBe('');
  });
});
