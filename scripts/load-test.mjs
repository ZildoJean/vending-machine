#!/usr/bin/env node
// Test de charge : plusieurs clients se disputent la machine (exclusive). Vérifie, sous contention :
//  1. l'EXCLUSIVITÉ (un seul client à la fois) ; 2. aucune erreur 5xx ; 3. la CONSERVATION de l'argent et du stock.
// Variables : BASE_URL, ADMIN_LOGIN, ADMIN_PASSWORD, WORKERS (8), ORDERS (3 par client), API_PREFIX, READ_SECONDS (5).
const BASE = (process.env.BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
const PREFIX = process.env.API_PREFIX ?? '';
const ORIGIN = process.env.ORIGIN ?? new URL(BASE).origin;
const WORKERS = Number(process.env.WORKERS ?? 8);
const ORDERS = Number(process.env.ORDERS ?? 3);
const READ_SECONDS = Number(process.env.READ_SECONDS ?? 5);
const { ADMIN_LOGIN, ADMIN_PASSWORD } = process.env;
if (!ADMIN_LOGIN || !ADMIN_PASSWORD) {
  console.error('ADMIN_LOGIN et ADMIN_PASSWORD requis');
  process.exit(2);
}

const lat = new Map(); // route -> [ms]
const statuses = new Map(); // "route status" -> n
const record = (route, ms, status) => {
  (lat.get(route) ?? lat.set(route, []).get(route)).push(ms);
  const k = `${route} ${status}`;
  statuses.set(k, (statuses.get(k) ?? 0) + 1);
};

class Session {
  cookie = '';
  async call(method, path, body, headers = {}, route = `${method} ${path}`) {
    const t0 = performance.now();
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
      const [pair] = sc.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    record(route, performance.now() - t0, res.status);
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}
const pct = (a, p) => (a.length === 0 ? 0 : [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((p / 100) * a.length))]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (cond, label) => {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}`);
  if (!cond) failures++;
};

console.log(`Test de charge : ${WORKERS} clients x ${ORDERS} commandes sur ${BASE}${PREFIX}`);
const stamp = Date.now().toString(36);

// ---------- préparation
const admin = new Session();
await admin.call('POST', '/auth/login', { login: ADMIN_LOGIN, secret: ADMIN_PASSWORD });
await admin.call('POST', '/admin/maintenance/enter');
const initialStock = WORKERS * ORDERS * 2 + 10;
const prod = (await admin.call('POST', '/admin/products', { name: `Charge ${stamp}`, priceAr: 1500, initialStock })).json.product;
await admin.call('POST', '/admin/maintenance/exit');
const logins = Array.from({ length: WORKERS }, (_, i) => `load${stamp}x${i}`);
for (const l of logins) await admin.call('POST', '/admin/users', { login: l, secret: '482915' });

// ---------- A : exclusivité
console.log('\nA. exclusivité : tous les clients se connectent EN MÊME TEMPS');
const sessions = logins.map(() => new Session());
const burst = await Promise.all(
  sessions.map((s, i) => s.call('POST', '/auth/login', { login: logins[i], secret: '482915' }, {}, 'login (rafale)')),
);
const winners = burst.map((r, i) => (r.status === 200 ? i : -1)).filter((i) => i >= 0);
check(winners.length === 1, `exactement 1 connexion réussie sur ${WORKERS} (obtenu : ${winners.length})`);
check(burst.filter((r) => r.status === 409).length === WORKERS - 1, `les ${WORKERS - 1} autres reçoivent 409 MACHINE_BUSY`);
await sessions[winners[0]].call('POST', '/auth/logout');

// ---------- B : contention
console.log(`\nB. contention : chaque client enchaîne ${ORDERS} parcours complets (connexion, dépôt, commande)`);
const outcomes = [];
let deposited = 0;
let retries = 0;
const t0 = performance.now();
await Promise.all(
  logins.map(async (login) => {
    const s = new Session();
    for (let n = 0; n < ORDERS; n++) {
      for (;;) {
        const r = await s.call('POST', '/auth/login', { login, secret: '482915' }, undefined, 'login');
        if (r.status === 200) break;
        if (r.status !== 409) throw new Error(`connexion inattendue : ${r.status}`);
        retries++;
        await sleep(40 + Math.random() * 120);
      }
      const dep = await s.call('POST', '/wallet/deposit', { bill: 5000, insertionId: crypto.randomUUID() }, undefined, 'dépôt');
      if (dep.status === 200) deposited += 5000;
      const ord = await s.call(
        'POST',
        '/orders',
        { items: [{ productId: prod.id, qty: 2 }] },
        { 'idempotency-key': `load-${stamp}-${crypto.randomUUID()}` },
        'commande',
      );
      if (ord.status === 200) outcomes.push(ord.json);
    }
  }),
);
const elapsed = (performance.now() - t0) / 1000;
console.log(
  `   ${outcomes.length} commandes en ${elapsed.toFixed(1)} s (${(outcomes.length / elapsed).toFixed(2)}/s), ${retries} reprises de connexion (machine occupée)`,
);
check(outcomes.length === WORKERS * ORDERS, `toutes les commandes ont abouti (${outcomes.length}/${WORKERS * ORDERS})`);
check(new Set(outcomes.map((o) => o.orderId)).size === outcomes.length, 'aucune commande en double');

// ---------- C : lectures
console.log(`\nC. lectures publiques pendant ${READ_SECONDS} s (50 requêtes simultanées)`);
const stop = Date.now() + READ_SECONDS * 1000;
let reads = 0;
await Promise.all(
  Array.from({ length: 50 }, async () => {
    const s = new Session();
    while (Date.now() < stop) {
      await s.call('GET', '/machine/status', undefined, {}, 'GET /machine/status (charge)');
      reads++;
    }
  }),
);
console.log(`   ${(reads / READ_SECONDS).toFixed(0)} requêtes/s`);

// ---------- réconciliation
console.log('\nRéconciliation (argent et stock)');
let balances = 0;
for (const login of logins) {
  const s = new Session();
  const r = await s.call('POST', '/auth/login', { login, secret: '482915' }, undefined, 'login (bilan)');
  if (r.status !== 200) throw new Error('bilan : connexion refusée');
  balances += (await s.call('GET', '/wallet')).json.balanceAr;
  await s.call('POST', '/auth/logout');
}
const kept = outcomes.reduce((n, o) => n + o.totalAr - o.refundedAr, 0);
const deliveredUnits = outcomes.reduce((n, o) => n + o.items.reduce((m, i) => m + i.deliveredQty, 0), 0);
const stockNow = (await admin.call('GET', '/admin/products')).json.products.find((p) => p.id === prod.id).stock;
check(balances + kept === deposited, `argent : soldes (${balances}) + encaissé (${kept}) = déposé (${deposited})`);
check(kept === deliveredUnits * 1500, `argent gardé (${kept}) = valeur des boissons servies (${deliveredUnits} x 1 500)`);
check(initialStock - stockNow === deliveredUnits, `stock : ${initialStock} - ${stockNow} = ${deliveredUnits} unités servies`);
const fiveXX = [...statuses].filter(([k]) => /\s5\d\d$/.test(k)).reduce((n, [, v]) => n + v, 0);
check(fiveXX === 0, `aucune réponse 5xx (${fiveXX})`);
await admin.call('POST', '/auth/logout');

console.log('\nLatences (ms)            n     p50     p95     p99     max');
for (const [route, a] of [...lat].sort()) {
  console.log(
    `${route.padEnd(24)} ${String(a.length).padStart(5)} ${pct(a, 50).toFixed(0).padStart(7)} ${pct(a, 95).toFixed(0).padStart(7)} ${pct(a, 99).toFixed(0).padStart(7)} ${Math.max(
      ...a,
    )
      .toFixed(0)
      .padStart(7)}`,
  );
}
console.log(
  '\nCodes de réponse :',
  [...statuses]
    .sort()
    .map(([k, v]) => `${k}=${v}`)
    .join(' | '),
);
console.log(failures === 0 ? '\nCHARGE OK : exclusivité, argent et stock cohérents' : `\n${failures} vérification(s) en échec`);
process.exit(failures === 0 ? 0 : 1);
