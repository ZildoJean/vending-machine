import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import pino from 'pino';
import type { DestinationStream } from 'pino';
import { ZodError } from 'zod';
import {
  AdjustBody,
  AuditQuery,
  CreateProductBody,
  CreateUserBody,
  DepositBody,
  IdParam,
  LoginBody,
  OrderBody,
  ResetSecretBody,
  RestockBody,
  UpdateProductBody,
} from '@vending/shared';
import type { MoneyConfig } from '@vending/shared';
import type { AdminService } from '../../application/admin-service';
import type { AuthService, Principal } from '../../application/auth-service';
import type { CheckoutService } from '../../application/checkout-service';
import type { ClientQueries } from '../../application/client-queries';
import type { DepositService } from '../../application/deposit-service';
import { OrderNotDispensableError } from '../../application/errors';
import type { MachineService } from '../../application/machine-service';
import type { Role } from '../../application/ports';
import type { RawCartLine } from '../../domain/cart';
import { LockTimeoutError } from '../db/errors';
import { adminFailure, checkoutError, depositFailure, machineError, send } from './http-errors';

export const SESSION_COOKIE = 'vm_session';

export interface AppDeps {
  readonly auth: AuthService;
  readonly machine: MachineService;
  readonly checkout: CheckoutService;
  readonly deposit: DepositService;
  readonly admin: AdminService;
  readonly queries: ClientQueries;
  readonly money: MoneyConfig;
  /** Vérifie la base (route /health). */
  readonly ping: () => Promise<void>;
}

export interface AppOptions {
  readonly logLevel: string;
  readonly logStream?: DestinationStream;
  readonly cookieSecure: boolean;
  readonly allowedOrigins: readonly string[];
  readonly trustProxy: boolean;
  readonly limits: { readonly windowMs: number; readonly globalMax: number; readonly loginMax: number; readonly depositMax: number };
}

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal | null;
  }
}

export function createLogger(level: string, stream?: DestinationStream): pino.Logger {
  return pino(
    {
      level,
      // jamais de cookie, d'en-tête d'autorisation ni de secret dans les journaux
      redact: {
        paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]', '*.secret', '*.pin', '*.password'],
        censor: '[masqué]',
      },
    },
    stream,
  );
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(deps: AppDeps, opts: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: createLogger(opts.logLevel, opts.logStream),
    bodyLimit: 10_000,
    trustProxy: opts.trustProxy,
  });

  await app.register(helmet);
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: opts.limits.globalMax, timeWindow: opts.limits.windowMs });
  app.decorateRequest('principal', null);

  // CSRF : cookie SameSite=Strict + refus de toute origine inconnue sur les requêtes qui modifient l'état.
  app.addHook('onRequest', async (req, reply) => {
    if (SAFE_METHODS.has(req.method)) return;
    const origin = req.headers.origin;
    if (origin !== undefined && !opts.allowedOrigins.includes(origin)) {
      return send(reply, 403, 'FORBIDDEN_ORIGIN', 'Origine non autorisée.');
    }
    return undefined;
  });

  app.setNotFoundHandler((_req, reply) => send(reply, 404, 'NOT_FOUND', 'Route inconnue.'));

  app.setErrorHandler((error: unknown, req, reply) => {
    if (error instanceof ZodError || (error as { name?: string }).name === 'ZodError') {
      const issues = (error as ZodError).issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return send(reply, 400, 'VALIDATION_ERROR', 'Requête invalide.', { issues });
    }
    if (error instanceof LockTimeoutError) {
      void reply.header('Retry-After', '1');
      return send(reply, 503, 'MACHINE_LOCKED', 'La machine est momentanément indisponible, réessayez.');
    }
    if (error instanceof OrderNotDispensableError) return send(reply, 409, 'ORDER_NOT_DISPENSABLE', 'Commande déjà clôturée.');
    const status = (error as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code =
        status === 413 ? 'PAYLOAD_TOO_LARGE' : status === 415 ? 'UNSUPPORTED_MEDIA_TYPE' : status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST';
      return send(reply, status, code, status === 429 ? 'Trop de requêtes, réessayez plus tard.' : 'Requête incorrecte.');
    }
    req.log.error({ err: error }, 'erreur interne');
    return send(reply, 500, 'INTERNAL', 'Erreur interne.', { requestId: req.id });
  });

  const setSession = (reply: FastifyReply, token: string, maxAgeMs: number | null): void => {
    void reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: opts.cookieSecure,
      sameSite: 'strict',
      path: '/',
      ...(maxAgeMs === null ? {} : { maxAge: Math.floor(maxAgeMs / 1000) }),
    });
  };
  const clearSession = (reply: FastifyReply): void => {
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
  };

  /** Authentification + rôle. Le jeton est cherché par son hash ; un client est validé contre machine_state. */
  const guard = (role: Role) => async (req: FastifyRequest, reply: FastifyReply) => {
    const r = await deps.auth.authenticate(req.cookies[SESSION_COOKIE]);
    if (!r.ok) {
      clearSession(reply);
      return send(
        reply,
        401,
        r.error,
        r.error === 'SESSION_EXPIRED' ? 'Votre session a expiré, reconnectez-vous.' : 'Authentification requise.',
      );
    }
    if (r.value.role !== role) return send(reply, 403, 'FORBIDDEN', 'Accès refusé.');
    req.principal = r.value;
    return undefined;
  };
  const authed = (req: FastifyRequest): Principal => {
    if (req.principal === null) throw new Error('Invariant violé : route protégée sans principal');
    return req.principal;
  };
  const rl = (max: number) => ({ config: { rateLimit: { max, timeWindow: opts.limits.windowMs } } });

  // ------------------------------------------------------------------ public
  app.get('/health', async (_req, reply) => {
    try {
      await deps.ping();
      return { status: 'ok' };
    } catch {
      return send(reply, 503, 'DB_UNAVAILABLE', 'Base de données indisponible.');
    }
  });

  app.get('/machine/status', async () => {
    const s = await deps.machine.status();
    return { status: s.kind === 'IDLE' ? 'IDLE' : s.kind === 'MAINTENANCE' ? 'MAINTENANCE' : 'IN_USE' };
  });

  // -------------------------------------------------------------------- auth
  app.post('/auth/login', rl(opts.limits.loginMax), async (req, reply) => {
    const body = LoginBody.parse(req.body);
    const r = await deps.auth.login(body.login, body.secret);
    if (!r.ok) {
      return r.error.kind === 'INVALID_CREDENTIALS'
        ? send(reply, 401, 'INVALID_CREDENTIALS', 'Identifiants invalides, ou compte temporairement verrouillé.')
        : machineError(reply, r.error.error, 'client');
    }
    setSession(reply, r.value.token, r.value.maxAgeMs);
    return { role: r.value.role, login: r.value.login };
  });

  app.post('/auth/logout', async (req, reply) => {
    const g = await deps.auth.authenticate(req.cookies[SESSION_COOKIE]);
    if (!g.ok) {
      clearSession(reply);
      return reply.code(204).send();
    }
    const r = await deps.auth.logout(g.value);
    if (!r.ok) return machineError(reply, r.error.error, 'client');
    clearSession(reply);
    return reply.code(204).send();
  });

  app.get('/me', async (req, reply) => {
    const g = await deps.auth.authenticate(req.cookies[SESSION_COOKIE]);
    if (!g.ok) {
      clearSession(reply);
      return send(reply, 401, g.error, 'Authentification requise.');
    }
    return { userId: g.value.userId, login: g.value.login, role: g.value.role, remainingMs: g.value.remainingMs };
  });

  // ------------------------------------------------------------------ client
  const client = guard('CLIENT');

  app.get('/products', { preHandler: client }, async () => ({
    products: (await deps.queries.products()).map((p) => ({ id: p.id, name: p.name, priceAr: p.priceAr, stock: p.stock })),
  }));

  app.get('/wallet', { preHandler: client }, async (req) => ({
    balanceAr: await deps.queries.balance(authed(req).userId),
    walletCapAr: deps.money.walletCap,
    acceptedBills: deps.money.acceptedBills,
  }));

  app.post('/wallet/deposit', { preHandler: client, ...rl(opts.limits.depositMax) }, async (req, reply) => {
    const body = DepositBody.parse(req.body);
    const r = await deps.deposit.deposit(authed(req).userId, body.bill, body.insertionId);
    if (!r.ok)
      return r.error.kind === 'MACHINE' && r.error.error === 'SESSION_EXPIRED'
        ? (clearSession(reply), depositFailure(reply, r.error))
        : depositFailure(reply, r.error);
    return r.value;
  });

  app.post('/orders', { preHandler: client }, async (req, reply) => {
    const body = OrderBody.parse(req.body);
    const header = req.headers['idempotency-key'];
    const cart: RawCartLine[] = body.items.map((i) => ({ productId: i.productId, qty: i.qty }));
    const r = await deps.checkout.checkout(authed(req).userId, cart, typeof header === 'string' ? header : undefined);
    if (!r.ok) {
      if (r.error.kind === 'MACHINE' && r.error.error === 'SESSION_EXPIRED') clearSession(reply);
      return checkoutError(reply, r.error);
    }
    // la session client se ferme après toute commande terminée : le cookie ne sert plus à rien
    if (r.value.status !== 'PENDING_DISPENSE') clearSession(reply);
    return r.value;
  });

  app.get('/orders/last', { preHandler: client }, async (req, reply) => {
    const last = await deps.queries.lastOrder(authed(req).userId);
    return last === null ? send(reply, 404, 'NOT_FOUND', 'Aucune commande.') : last;
  });

  // ------------------------------------------------------------------- admin
  const admin = guard('ADMIN');

  app.post('/admin/maintenance/enter', { preHandler: admin }, async (req, reply) => {
    const r = await deps.admin.enterMaintenance(authed(req).userId);
    return r.ok ? { status: 'MAINTENANCE' } : adminFailure(reply, r.error, 'machine-admin');
  });
  app.post('/admin/maintenance/exit', { preHandler: admin }, async (req, reply) => {
    const r = await deps.admin.exitMaintenance(authed(req).userId);
    return r.ok ? { status: 'IDLE' } : adminFailure(reply, r.error, 'machine-admin');
  });
  app.post('/admin/session/force-close', { preHandler: admin }, async (req, reply) => {
    const r = await deps.admin.forceClose(authed(req).userId);
    return r.ok ? { status: 'IDLE' } : adminFailure(reply, r.error, 'machine-admin');
  });

  app.get('/admin/machine', { preHandler: admin }, async (req) => deps.admin.machineInfo(authed(req).userId));
  app.get('/admin/users', { preHandler: admin }, async () => ({ users: await deps.admin.listClients() }));
  app.get('/admin/products', { preHandler: admin }, async () => ({ products: await deps.admin.listProducts() }));
  app.post('/admin/products', { preHandler: admin }, async (req, reply) => {
    const b = CreateProductBody.parse(req.body);
    const r = await deps.admin.createProduct(authed(req).userId, b);
    return r.ok ? reply.code(201).send({ product: r.value }) : adminFailure(reply, r.error, 'catalog-admin');
  });
  app.patch('/admin/products/:id', { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = UpdateProductBody.parse(req.body);
    const patch = {
      ...(b.name !== undefined ? { name: b.name } : {}),
      ...(b.priceAr !== undefined ? { priceAr: b.priceAr } : {}),
      ...(b.active !== undefined ? { active: b.active } : {}),
    };
    const r = await deps.admin.updateProduct(authed(req).userId, id, patch);
    return r.ok ? { product: r.value } : adminFailure(reply, r.error, 'catalog-admin');
  });
  app.post('/admin/products/:id/restock', { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = RestockBody.parse(req.body);
    const r = await deps.admin.restock(authed(req).userId, id, b.qty);
    return r.ok ? { product: r.value } : adminFailure(reply, r.error, 'catalog-admin');
  });
  app.post('/admin/products/:id/adjust', { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = AdjustBody.parse(req.body);
    const r = await deps.admin.adjustStock(authed(req).userId, id, b.delta);
    return r.ok ? { product: r.value } : adminFailure(reply, r.error, 'catalog-admin');
  });

  app.post('/admin/users', { preHandler: admin }, async (req, reply) => {
    const b = CreateUserBody.parse(req.body);
    const r = await deps.admin.createClient(authed(req).userId, b.login, b.secret);
    return r.ok ? reply.code(201).send(r.value) : adminFailure(reply, r.error, 'machine-admin');
  });
  app.post('/admin/users/:id/reset-pin', { preHandler: admin }, async (req, reply) => {
    const { id } = IdParam.parse(req.params);
    const b = ResetSecretBody.parse(req.body);
    const r = await deps.admin.resetClientPin(authed(req).userId, id, b.secret);
    return r.ok ? reply.code(204).send() : adminFailure(reply, r.error, 'machine-admin');
  });
  app.get('/admin/audit', { preHandler: admin }, async (req) => {
    const q = AuditQuery.parse(req.query);
    return { entries: await deps.admin.listAudit(q.limit) };
  });

  return app as unknown as FastifyInstance;
}
