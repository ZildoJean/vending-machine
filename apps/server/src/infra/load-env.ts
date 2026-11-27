import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Charge le fichier `.env` (développement). Cherche d'abord dans le dossier courant, puis à la racine du projet
 * (deux niveaux au-dessus d'apps/server). Ne REMPLACE JAMAIS une variable déjà définie : un export dans le terminal ou
 * une variable de conteneur garde la priorité. En production (Docker), aucun fichier n'est présent : rien ne se passe.
 * Renvoie les chemins chargés (jamais les valeurs).
 */
export function loadEnvFiles(cwd: string = process.cwd(), explicit: string | undefined = process.env.ENV_FILE): string[] {
  const candidates = [explicit, join(cwd, '.env'), resolve(cwd, '..', '..', '.env')].filter(
    (p): p is string => typeof p === 'string' && p !== '',
  );
  const loaded: string[] = [];
  for (const file of [...new Set(candidates)]) {
    if (!existsSync(file)) continue;
    process.loadEnvFile(file); // Node >= 20.12 : n'écrase pas les variables existantes
    loaded.push(file);
  }
  return loaded;
}
