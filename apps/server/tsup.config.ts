import { defineConfig } from 'tsup';

// Un bundle par point d'entrée ; les dépendances npm restent externes (installées dans l'image),
// seul le paquet interne @vending/shared (TypeScript brut) est inclus.
export default defineConfig({
  entry: ['src/main.ts', 'src/migrate.ts', 'src/seed-admin.ts', 'src/setup-roles.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  sourcemap: false,
  splitting: true,
  noExternal: ['@vending/shared'],
});
