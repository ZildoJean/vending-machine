import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// L'interface appelle /api/... sur sa propre origine ; ce proxy retire le préfixe et transmet au serveur.
// Même origine => cookie SameSite=Strict sans CORS. L'en-tête Origin du navigateur est conservé :
// ouvrir l'application par http://localhost:5173 (l'origine autorisée par défaut côté serveur).
const proxy = {
  '/api': { target: process.env.API_URL ?? 'http://127.0.0.1:3000', rewrite: (p: string) => p.replace(/^\/api/, '') },
};

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { port: 5173, strictPort: true, proxy },
  // `vite preview` (build de production servi localement) : utilisé par les tests Playwright
  preview: { port: 4173, strictPort: true, proxy },
  build: { sourcemap: false, target: 'es2022' },
});
