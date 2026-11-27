#!/usr/bin/env node
// Test de fumée post-déploiement : parcours complet contre une instance EN COURS D'EXÉCUTION.
// BASE_URL (défaut http://127.0.0.1:3000), ORIGIN (défaut = BASE_URL), ADMIN_LOGIN, ADMIN_PASSWORD, API_PREFIX (ex. /api derrière Caddy).
// Crée un produit et un compte client de test (noms horodatés) : à lancer sur une base de test ou en connaissance de cause.
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const ORIGIN = process.env.ORIGIN ?? new URL(BASE).origin;
const PREFIX = process.env.API_PREFIX ?? '';
const { ADMIN_LOGIN, ADMIN_PASSWORD } = process.env;
if (!ADMIN_LOGIN || !ADMIN_PASSWORD) {
  console.error('ADMIN_LOGIN et ADMIN_PASSWORD requis');
  process.exit(2);
}

let failures = 0;
const ok = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures++;
};

class Session {
  cookie = '';
  async call(method, path, body, headers = {}) {
    const res = await fetch(`${BASE}${PREFIX}${path}`, {
      method,
      headers: {
        origin: ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      this.cookie = /max-age=0|expires=thu, 01 jan 1970/i.test(attrs.join(';')) || pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
  }
}

const stamp = Date.now().toString(36);
console.log(`Test de fumée : ${BASE}${PREFIX}`);

console.log('1. santé');
const anon = new Session();
const health = await anon.call('GET', '/health');
ok(health.status === 200 && health.json.status === 'ok', 'GET /health = ok (base joignable)');
ok((await anon.call('GET', '/machine/status')).json?.status === 'IDLE', 'machine libre au départ');
ok((await anon.call('GET', '/me')).status === 401, 'route protégée refusée sans session');

console.log('2. administrateur : maintenance et catalogue');
const admin = new Session();
const al = await admin.call('POST', '/auth/login', { login: ADMIN_LOGIN, secret: ADMIN_PASSWORD });
ok(al.status === 200 && al.json.role === 'ADMIN', 'connexion administrateur');
ok(/httponly/i.test(al.headers.get('set-cookie') ?? ''), 'cookie HttpOnly');
ok((await admin.call('POST', '/admin/maintenance/enter')).status === 200, 'entrée en maintenance');
const pname = `Smoke ${stamp}`;
const created = await admin.call('POST', '/admin/products', { name: pname, priceAr: 1500, initialStock: 5 });
ok(created.status === 201, 'création du produit');
const pid = created.json?.product?.id;
ok((await admin.call('POST', '/admin/maintenance/exit')).status === 200, 'sortie de maintenance');
const login = `smoke${stamp}`;
ok((await admin.call('POST', '/admin/users', { login, secret: '482915' })).status === 201, 'création du compte client');

console.log('3. client : dépôt, commande, résultat');
const client = new Session();
ok((await client.call('POST', '/auth/login', { login, secret: '000999' })).status === 401, 'mauvais PIN refusé');
const cl = await client.call('POST', '/auth/login', { login, secret: '482915' });
ok(cl.status === 200 && cl.json.role === 'CLIENT', 'connexion client');
ok((await client.call('GET', '/admin/users')).status === 403, "le client n'accède pas à l'administration");
const iid = crypto.randomUUID();
const dep = await client.call('POST', '/wallet/deposit', { bill: 5000, insertionId: iid });
ok(dep.status === 200 && dep.json.balanceAr === 5000, 'dépôt de 5 000 Ar');
const dep2 = await client.call('POST', '/wallet/deposit', { bill: 5000, insertionId: iid });
ok(dep2.status === 200 && dep2.json.replayed === true && dep2.json.balanceAr === 5000, 'rejeu du même billet : pas de double crédit');
const key = `smoke-${stamp}-${crypto.randomUUID()}`;
const ord = await client.call('POST', '/orders', { items: [{ productId: pid, qty: 2 }] }, { 'idempotency-key': key });
ok(
  ord.status === 200 && ord.json.status === 'DISPENSED' && ord.json.totalAr === 3000 && ord.json.balanceAr === 2000,
  'commande de 2 boissons servie, solde 2 000 Ar',
);
ok((await client.call('GET', '/wallet')).status === 401, 'session fermée après la commande');
const again = await client.call('POST', '/auth/login', { login, secret: '482915' });
ok(again.status === 200, 'reconnexion');
const last = await client.call('GET', '/orders/last');
ok(last.status === 200 && last.json.status === 'DISPENSED' && last.json.balanceAr === 2000, 'dernière commande retrouvée');
const replay = await client.call('POST', '/orders', { items: [{ productId: pid, qty: 2 }] }, { 'idempotency-key': key });
ok(replay.status === 200 && replay.json.replayed === true && replay.json.balanceAr === 2000, 'rejeu de la commande : rien refait');
ok((await client.call('POST', '/auth/logout')).status === 204, 'déconnexion');

console.log('4. audit');
const audit = await admin.call('GET', '/admin/audit?limit=20');
const actions = (audit.json?.entries ?? []).map((e) => e.action);
ok(
  ['MAINTENANCE_ENTER', 'PRODUCT_CREATE', 'USER_CREATE'].every((a) => actions.includes(a)),
  'actions administrateur journalisées',
);
await admin.call('POST', '/auth/logout');

console.log(failures === 0 ? '\nTOUT EST OK' : `\n${failures} vérification(s) en échec`);
process.exit(failures === 0 ? 0 : 1);
