import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { resolveMigrationsFolder } from './migrations-path';

describe('resolveMigrationsFolder', () => {
  it('un chemin avec des ESPACES (ex. « Final project ») est décodé, pas laissé en « %20 »', () => {
    const dir = resolveMigrationsFolder('file:///tmp/Final%20project/vending/apps/server/src/migrate.ts');
    expect(dir).toBe('/tmp/Final project/vending/apps/server/drizzle');
    expect(dir).not.toContain('%20');
  });
  it('caractères accentués et spéciaux (ex. « Cours é ») correctement décodés', () => {
    expect(resolveMigrationsFolder('file:///tmp/Cours%20%C3%A9/app/dist/migrate.js')).toBe('/tmp/Cours é/app/drizzle');
  });
  it('fonctionne depuis dist/ comme depuis src/ (le dossier drizzle est son voisin)', () => {
    expect(resolveMigrationsFolder('file:///srv/app/dist/migrate.js')).toBe('/srv/app/drizzle');
    expect(resolveMigrationsFolder('file:///srv/app/src/migrate.ts')).toBe('/srv/app/drizzle');
  });
  it('contrat Windows : la même URL donne « D:\\… » (et non « /D:/… ») avec fileURLToPath', () => {
    const url = new URL('../drizzle', 'file:///D:/Cours/M1/Final%20project/vending-machine/apps/server/src/migrate.ts');
    expect(fileURLToPath(url, { windows: true })).toBe('D:\\Cours\\M1\\Final project\\vending-machine\\apps\\server\\drizzle');
    expect(url.pathname).toBe('/D:/Cours/M1/Final%20project/vending-machine/apps/server/drizzle'); // ce que l'ancien code utilisait
  });
});
