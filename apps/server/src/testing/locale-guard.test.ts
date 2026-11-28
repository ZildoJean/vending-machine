import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Le TEXTE des erreurs PostgreSQL dépend de la langue du serveur (« droit refusé » en français). Un test qui le compare
 * échoue donc sur un PostgreSQL francophone sans que le code soit en cause. On compare le code SQLSTATE
 * (`toMatchObject({ code: '42501' })`) ou le NOM d'une contrainte (identique dans toutes les langues).
 */
const walk = (d: string): string[] =>
  readdirSync(d).flatMap((f) => {
    const p = join(d, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
const ENGLISH_DRIVER_TEXT =
  /permission denied|must be owner|authentication failed|already exists|does not exist|duplicate key|violates (?:check|unique|foreign)|syntax error|could not connect/i;

describe('les tests ne dépendent pas de la langue du serveur PostgreSQL', () => {
  it("aucune assertion ne compare du texte d'erreur PostgreSQL en anglais", () => {
    const files = walk(join(__dirname, '..')).filter((f) => f.endsWith('.test.ts') && !f.endsWith('locale-guard.test.ts'));
    expect(files.length).toBeGreaterThan(20);
    const offenders: string[] = [];
    // toute expression régulière LITTÉRALE contenant ces mots, même coupée sur plusieurs lignes par Prettier
    const regexLiteral = new RegExp(`/[^/\\n]*(?:${ENGLISH_DRIVER_TEXT.source})[^/\\n]*/[a-z]*`, 'i');
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (regexLiteral.test(line)) offenders.push(`${f.split('/src/')[1]}:${i + 1}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
