import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApiSession } from './api';

// relatif au dossier de travail (apps/web) : fonctionne que Playwright charge ce fichier en CJS ou en ESM
export const STATE_FILE = process.env.E2E_STATE_FILE ?? join(process.cwd(), 'e2e', '.state.json');
export interface E2eState {
  readonly product: string;
  readonly clientLogin: string;
  readonly clientPin: string;
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} requis pour préparer les tests de bout en bout`);
  return v;
}
function expectStatus(label: string, actual: number, expected: number): void {
  if (actual !== expected) throw new Error(`Préparation : ${label} a répondu ${actual} (attendu ${expected})`);
}

/** Crée un produit (stock 50) et un compte client UNIQUES pour cette exécution, via l'API (comme un administrateur). */
export default async function globalSetup(): Promise<void> {
  const stamp = Date.now().toString(36);
  const state: E2eState = { product: `E2E Cola ${stamp}`, clientLogin: `e2e${stamp}`, clientPin: '482915' };
  const admin = new ApiSession();
  expectStatus(
    'connexion administrateur',
    (await admin.call('POST', '/auth/login', { login: need('E2E_ADMIN_LOGIN'), secret: need('E2E_ADMIN_PASSWORD') })).status,
    200,
  );
  expectStatus('entrée en maintenance', (await admin.call('POST', '/admin/maintenance/enter')).status, 200);
  expectStatus(
    'création du produit',
    (await admin.call('POST', '/admin/products', { name: state.product, priceAr: 1500, initialStock: 50 })).status,
    201,
  );
  expectStatus('sortie de maintenance', (await admin.call('POST', '/admin/maintenance/exit')).status, 200);
  expectStatus(
    'création du client',
    (await admin.call('POST', '/admin/users', { login: state.clientLogin, secret: state.clientPin })).status,
    201,
  );
  expectStatus('déconnexion', (await admin.call('POST', '/auth/logout')).status, 204);
  writeFileSync(STATE_FILE, JSON.stringify(state));
}
