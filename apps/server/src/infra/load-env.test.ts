import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadEnvFiles } from './load-env';

const KEYS = ['LE_A', 'LE_B', 'LE_C', 'LE_ROOT', 'LE_PEPPER'];
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'loadenv-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const k of KEYS) delete process.env[k];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('loadEnvFiles', () => {
  it('lit un fichier .env de type WINDOWS (CRLF), commentaires et guillemets compris', () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), '# commentaire\r\nLE_A=valeur1\r\nLE_B="avec espaces"\r\n\r\nLE_PEPPER=abc/def+ghi==\r\n');
    expect(loadEnvFiles(d, '')).toEqual([join(d, '.env')]);
    expect(process.env.LE_A).toBe('valeur1'); // pas de « \r » parasite
    expect(process.env.LE_B).toBe('avec espaces');
    expect(process.env.LE_PEPPER).toBe('abc/def+ghi==');
  });

  it("une variable DÉJÀ définie (terminal, conteneur) n'est jamais écrasée", () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'LE_A=depuis_le_fichier\nLE_B=autre\n');
    process.env.LE_A = 'depuis_le_terminal';
    loadEnvFiles(d, '');
    expect(process.env.LE_A).toBe('depuis_le_terminal');
    expect(process.env.LE_B).toBe('autre');
  });

  it('cherche aussi à la racine du projet (apps/server -> deux niveaux au-dessus)', () => {
    const root = tmp();
    const server = join(root, 'apps', 'server');
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, '.env'), 'LE_ROOT=trouvé\n');
    expect(loadEnvFiles(server, '')).toEqual([join(root, '.env')]);
    expect(process.env.LE_ROOT).toBe('trouvé');
  });

  it("le .env du dossier courant l'emporte sur celui de la racine", () => {
    const root = tmp();
    const server = join(root, 'apps', 'server');
    mkdirSync(server, { recursive: true });
    writeFileSync(join(root, '.env'), 'LE_C=racine\nLE_A=racine\n');
    writeFileSync(join(server, '.env'), 'LE_C=local\n');
    loadEnvFiles(server, '');
    expect(process.env.LE_C).toBe('local');
    expect(process.env.LE_A).toBe('racine');
  });

  it('aucun fichier : rien ne se passe, aucune erreur (cas des conteneurs)', () => {
    expect(loadEnvFiles(tmp(), '')).toEqual([]);
  });

  it('ENV_FILE : chemin explicite pris en compte', () => {
    const d = tmp();
    writeFileSync(join(d, 'autre.env'), 'LE_A=explicite\n');
    expect(loadEnvFiles(d, join(d, 'autre.env'))).toEqual([join(d, 'autre.env')]);
    expect(process.env.LE_A).toBe('explicite');
  });

  it('ne renvoie que des chemins, jamais de valeurs', () => {
    const d = tmp();
    writeFileSync(join(d, '.env'), 'LE_A=secret-tres-long\n');
    expect(JSON.stringify(loadEnvFiles(d, ''))).not.toContain('secret-tres-long');
  });
});
