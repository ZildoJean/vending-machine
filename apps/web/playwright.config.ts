import { defineConfig, devices } from '@playwright/test';

const WEB = 'http://localhost:4173';
const API = 'http://127.0.0.1:3000';

/**
 * La machine est EXCLUSIVE (un seul client à la fois) : un seul worker, tests en série, et chaque test
 * rend la machine libre. Ces parcours s'exécutent en CI (navigateurs téléchargés) ou en local après
 * `pnpm --filter @vending/web exec playwright install`.
 * Prérequis : base migrée, rôle restreint, administrateur créé (voir .github/workflows/ci.yml, tâche e2e).
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  globalSetup: './e2e/global-setup.ts',
  use: { baseURL: WEB, trace: 'retain-on-failure', screenshot: 'only-on-failure', locale: 'fr-FR' },
  webServer: [
    {
      command: 'node ../server/dist/main.js',
      url: `${API}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        NODE_ENV: 'development', // cookie non Secure : l'application est servie en http://localhost
        PORT: '3000',
        HOST: '127.0.0.1',
        ALLOWED_ORIGINS: WEB,
        LOG_LEVEL: 'warn',
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        PIN_PEPPER: process.env.PIN_PEPPER ?? '',
      },
    },
    { command: 'pnpm exec vite preview --port 4173 --strictPort', url: WEB, reuseExistingServer: !process.env.CI, timeout: 60_000 },
  ],
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }, // 412 px de large, écran tactile
  ],
});
