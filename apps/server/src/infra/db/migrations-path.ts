import { fileURLToPath } from 'node:url';

/**
 * Dossier des migrations, à côté de `src/` (développement) ou de `dist/` (production).
 * `fileURLToPath` et NON `URL.pathname` : `pathname` laisse « %20 » à la place des espaces et, sous Windows, renvoie
 * « /D:/… » (barre en trop) — la migration échouait alors avec « Can't find meta/_journal.json ».
 */
export function resolveMigrationsFolder(importMetaUrl: string): string {
  return fileURLToPath(new URL('../drizzle', importMetaUrl));
}
