import type {
  AdminMachineDto,
  AdminProductDto,
  ApiErrorCode,
  AuditEntryDto,
  DepositResult,
  MeResponse,
  OrderOutcome,
  ProductDto,
  PublicMachineStatus,
  UserDto,
  WalletDto,
} from '@vending/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode | 'UNKNOWN',
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
/** Le serveur n'a pas répondu (réseau coupé) : l'effet de la requête est INCERTAIN. */
export class NetworkError extends Error {
  constructor() {
    super('Réseau indisponible');
    this.name = 'NetworkError';
  }
}

export interface ApiConfig {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
  /** Appelé pour toute réponse 401 (sauf l'échec d'une connexion). */
  readonly onUnauthorized?: (code: string) => void;
}

export interface Api {
  machineStatus(): Promise<{ status: PublicMachineStatus }>;
  login(login: string, secret: string): Promise<{ role: 'CLIENT' | 'ADMIN'; login: string }>;
  logout(): Promise<void>;
  me(): Promise<MeResponse>;
  products(): Promise<{ products: ProductDto[] }>;
  wallet(): Promise<WalletDto>;
  deposit(body: { bill: number; insertionId: string }): Promise<DepositResult>;
  order(items: { productId: string; qty: number }[], idempotencyKey: string): Promise<OrderOutcome>;
  lastOrder(): Promise<OrderOutcome | null>;
  admin: {
    machine(): Promise<AdminMachineDto>;
    enterMaintenance(): Promise<void>;
    exitMaintenance(): Promise<void>;
    forceClose(): Promise<void>;
    products(): Promise<{ products: AdminProductDto[] }>;
    createProduct(b: { name: string; priceAr: number; initialStock: number }): Promise<{ product: AdminProductDto }>;
    updateProduct(id: string, b: { name?: string; priceAr?: number; active?: boolean }): Promise<{ product: AdminProductDto }>;
    restock(id: string, qty: number): Promise<{ product: AdminProductDto }>;
    adjust(id: string, delta: number): Promise<{ product: AdminProductDto }>;
    users(): Promise<{ users: UserDto[] }>;
    createUser(login: string, secret: string): Promise<{ id: string; login: string }>;
    resetPin(id: string, secret: string): Promise<void>;
    audit(limit: number): Promise<{ entries: AuditEntryDto[] }>;
  };
}

export function createApi(cfg: ApiConfig): Api {
  const doFetch = cfg.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function request<T>(
    method: string,
    path: string,
    opts: { body?: unknown; headers?: Record<string, string>; quiet401?: boolean } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(`${cfg.baseUrl}${path}`, {
        method,
        credentials: 'same-origin',
        headers: { ...(opts.body === undefined ? {} : { 'content-type': 'application/json' }), ...(opts.headers ?? {}) },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch {
      throw new NetworkError();
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let json: unknown;
    try {
      json = text === '' ? undefined : JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (res.ok) return json as T;
    const err = (json as { error?: { code?: string; message?: string; details?: Record<string, unknown> } } | undefined)?.error;
    const code = (err?.code ?? 'UNKNOWN') as ApiErrorCode | 'UNKNOWN';
    if (res.status === 401 && !opts.quiet401) cfg.onUnauthorized?.(code);
    throw new ApiError(res.status, code, err?.message ?? `Erreur ${res.status}`, err?.details);
  }

  const get = <T>(p: string) => request<T>('GET', p);
  const post = <T>(p: string, body?: unknown, headers?: Record<string, string>) =>
    request<T>('POST', p, { ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });

  return {
    machineStatus: () => get('/machine/status'),
    login: (login, secret) => request('POST', '/auth/login', { body: { login, secret }, quiet401: true }),
    logout: () => post('/auth/logout'),
    me: () => get('/me'),
    products: () => get('/products'),
    wallet: () => get('/wallet'),
    deposit: (b) => post('/wallet/deposit', b),
    order: (items, key) => post('/orders', { items }, { 'idempotency-key': key }),
    lastOrder: async () => {
      try {
        return await get<OrderOutcome>('/orders/last');
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    admin: {
      machine: () => get('/admin/machine'),
      enterMaintenance: () => post('/admin/maintenance/enter'),
      exitMaintenance: () => post('/admin/maintenance/exit'),
      forceClose: () => post('/admin/session/force-close'),
      products: () => get('/admin/products'),
      createProduct: (b) => post('/admin/products', b),
      updateProduct: (id, b) => request('PATCH', `/admin/products/${id}`, { body: b }),
      restock: (id, qty) => post(`/admin/products/${id}/restock`, { qty }),
      adjust: (id, delta) => post(`/admin/products/${id}/adjust`, { delta }),
      users: () => get('/admin/users'),
      createUser: (login, secret) => post('/admin/users', { login, secret }),
      resetPin: (id, secret) => post(`/admin/users/${id}/reset-pin`, { secret }),
      audit: (limit) => get(`/admin/audit?limit=${limit}`),
    },
  };
}
