import { Writable } from 'node:stream';
import { setupAppRole } from '../infra/db/roles';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { Pool } from 'pg';
import { AUTH_POLICY, MONEY_CONFIG } from '@vending/shared';
import type { SecretHasher, Dispenser } from '../application/ports';
import { createServices } from '../infra/container';
import type { AppDeps, AppOptions } from '../infra/http/app';
import { buildApp, SESSION_COOKIE } from '../infra/http/app';
import { createDb } from '../infra/db/client';
import { PgUnitOfWork } from '../infra/db/pg-unit-of-work';
import { SimulatedBillAcceptor } from '../infra/hardware/simulated-bill-acceptor';
import { Argon2SecretHasher } from '../infra/security/argon2-hasher';
import { FakeClock } from './fake-clock';
import { deposit, mkProduct } from './pg-fixtures';
import { createTestDb } from './pg-test-db';
import type { TestDb } from './pg-test-db';
import { CapturingLogger, ScriptedDispenser } from './scripted-dispenser';

export const ORIGIN = 'http://localhost:5173';
export const ADMIN_LOGIN = 'boss';
export const ADMIN_PASSWORD = 'Un-bon-mot-de-passe-42';
export const T0 = 1_000_000;

/** Hacheur réel (argon2id + poivre) à coût réduit, qui compte les vérifications effectuées. */
export class SpyHasher implements SecretHasher {
  readonly verified: string[] = [];
  private readonly inner = new Argon2SecretHasher({ pepper: 'test-pepper-test-pepper-test-pepper-1234', memoryCost: 8_192, timeCost: 1 });
  hash(s: string): Promise<string> {
    return this.inner.hash(s);
  }
  verify(hash: string, s: string): Promise<boolean> {
    this.verified.push(hash);
    return this.inner.verify(hash, s);
  }
}

export interface HarnessOptions {
  readonly dispenser?: Dispenser;
  readonly limits?: Partial<AppOptions['limits']>;
  readonly override?: Partial<AppDeps>;
  readonly allowedOrigins?: readonly string[];
}

export interface Harness {
  readonly db: TestDb;
  readonly pool: Pool;
  readonly app: FastifyInstance;
  readonly clock: FakeClock;
  readonly hasher: SpyHasher;
  readonly services: ReturnType<typeof createServices>;
  readonly logs: string[];
  readonly adminId: string;
  call(
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    o?: { cookie?: string | undefined; body?: unknown; headers?: Record<string, string>; origin?: string | null },
  ): Promise<LightMyRequestResponse>;
  login(login: string, secret: string): Promise<{ res: LightMyRequestResponse; token: string | undefined }>;
  loginAdmin(): Promise<string>;
  createClient(login: string, pin: string, balance?: number): Promise<string>;
  /** Produit avec stock, créé directement en base (bypass de l'API : sert à préparer le décor). */
  product(price: number, stock: number): Promise<string>;
  close(): Promise<void>;
}

export async function createHarness(opts: HarnessOptions = {}): Promise<Harness> {
  const db = await createTestDb();
  const pool = db.pool;
  const clock = new FakeClock(T0);
  const hasher = new SpyHasher();
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const warn = new CapturingLogger();

  // TEST_APP_ROLE=1 : l'APPLICATION (services, routes) tourne avec le rôle restreint de production ;
  // `h.pool` (fixtures, vérifications SQL) reste le propriétaire.
  let appPool: Pool | null = null;
  if (process.env.TEST_APP_ROLE === '1') {
    const role = `app_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    await setupAppRole(pool, { role, password: 'app-pass-1234', database: db.name });
    const url = new URL(db.adminUrl);
    url.username = role;
    url.password = 'app-pass-1234';
    url.pathname = `/${db.name}`;
    appPool = new Pool({ connectionString: url.toString(), max: 6 });
  }
  const services = createServices({
    uow: new PgUnitOfWork(createDb(appPool ?? pool)),
    clock,
    dispenser: opts.dispenser ?? new ScriptedDispenser(),
    acceptor: new SimulatedBillAcceptor(MONEY_CONFIG.acceptedBills),
    hasher,
    logger: warn,
    ping: async () => void (await pool.query('SELECT 1')),
    policy: AUTH_POLICY,
  });
  const admin = await services.admin.createAdmin(ADMIN_LOGIN, ADMIN_PASSWORD);
  if (!admin.ok) throw new Error('harness : création admin impossible');

  const app = await buildApp(
    { ...services, ...opts.override },
    {
      logLevel: 'info',
      logStream: stream,
      cookieSecure: true,
      allowedOrigins: opts.allowedOrigins ?? [ORIGIN],
      trustProxy: false,
      limits: { windowMs: 60_000, globalMax: 10_000, loginMax: 10_000, depositMax: 10_000, ...opts.limits },
    },
  );
  await app.ready();

  const call: Harness['call'] = (method, url, o = {}) =>
    app.inject({
      method,
      url,
      ...(o.cookie ? { cookies: { [SESSION_COOKIE]: o.cookie } } : {}),
      headers: { ...(o.origin === null ? {} : { origin: o.origin ?? ORIGIN }), ...(o.headers ?? {}) },
      ...(o.body === undefined ? {} : { payload: o.body as object }),
    });
  const tokenOf = (res: LightMyRequestResponse): string | undefined => res.cookies.find((c) => c.name === SESSION_COOKIE)?.value;

  const h: Harness = {
    db,
    pool,
    app,
    clock,
    hasher,
    services,
    logs,
    adminId: admin.value.id,
    call,
    async login(login, secret) {
      const res = await call('POST', '/auth/login', { body: { login, secret } });
      return { res, token: res.statusCode === 200 ? tokenOf(res) : undefined };
    },
    async loginAdmin() {
      const { res, token } = await h.login(ADMIN_LOGIN, ADMIN_PASSWORD);
      if (res.statusCode !== 200 || token === undefined) throw new Error(`harness : login admin refusé (${res.statusCode})`);
      return token;
    },
    async createClient(login, pin, balance = 0) {
      const r = await services.admin.createClient(admin.value.id, login, pin);
      if (!r.ok) throw new Error(`harness : création client refusée (${r.error.kind})`);
      if (balance > 0) await deposit(pool, r.value.id, balance);
      return r.value.id;
    },
    product: (price, stock) => mkProduct(pool, admin.value.id, price, stock),
    async close() {
      await app.close();
      await appPool?.end();
      await db.drop();
    },
  };
  return h;
}
