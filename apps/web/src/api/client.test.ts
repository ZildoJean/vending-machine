import { describe, expect, it, vi } from 'vitest';
import { ApiError, NetworkError, createApi } from './client';

const res = (status: number, body?: unknown): Response =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(handler: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const onUnauthorized = vi.fn();
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
  return { api: createApi({ baseUrl: '/api', fetchImpl, onUnauthorized }), calls, onUnauthorized };
}

describe('createApi', () => {
  it('GET : préfixe, cookies de même origine, pas de content-type', async () => {
    const { api, calls } = setup(() => res(200, { status: 'IDLE' }));
    expect(await api.machineStatus()).toEqual({ status: 'IDLE' });
    expect(calls[0]?.url).toBe('/api/machine/status');
    expect(calls[0]?.init.credentials).toBe('same-origin');
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
  });
  it('POST JSON : corps sérialisé et content-type', async () => {
    const { api, calls } = setup(() => res(200, { role: 'CLIENT', login: 'a' }));
    await api.login('alice', '135792');
    expect(calls[0]?.init.method).toBe('POST');
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ login: 'alice', secret: '135792' });
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });
  it('POST sans corps : pas de content-type JSON (le serveur refuserait un corps vide)', async () => {
    const { api, calls } = setup(() => res(204));
    await api.logout();
    expect((calls[0]?.init.headers as Record<string, string>)['content-type']).toBeUndefined();
    expect(calls[0]?.init.body).toBeUndefined();
  });
  it('commande : en-tête Idempotency-Key', async () => {
    const { api, calls } = setup(() => res(200, { status: 'DISPENSED' }));
    await api.order([{ productId: 'p', qty: 1 }], 'order-abc-12345');
    expect((calls[0]?.init.headers as Record<string, string>)['idempotency-key']).toBe('order-abc-12345');
  });
  it('204 : undefined', async () => {
    const { api } = setup(() => res(204));
    expect(await api.logout()).toBeUndefined();
  });
  it('erreur serveur : ApiError avec code, message et détails', async () => {
    const { api } = setup(() =>
      res(422, { error: { code: 'INSUFFICIENT_FUNDS', message: 'Solde insuffisant.', details: { missingAr: 500 } } }),
    );
    const e = await api.order([], 'order-abc-12345').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ApiError);
    expect(e).toMatchObject({ status: 422, code: 'INSUFFICIENT_FUNDS', details: { missingAr: 500 } });
  });
  it("corps d'erreur non JSON : code UNKNOWN", async () => {
    const { api } = setup(() => new Response('<html>bad gateway</html>', { status: 502 }));
    expect(await api.me().catch((x: unknown) => x)).toMatchObject({ status: 502, code: 'UNKNOWN' });
  });
  it('réseau coupé : NetworkError (effet incertain)', async () => {
    const { api } = setup(() => {
      throw new TypeError('Failed to fetch');
    });
    expect(await api.deposit({ bill: 1_000, insertionId: 'x' }).catch((x: unknown) => x)).toBeInstanceOf(NetworkError);
  });
  it("401 : onUnauthorized appelé avec le code, SAUF pour l'échec d'une connexion", async () => {
    const { api, onUnauthorized } = setup((url) =>
      res(401, { error: { code: url.endsWith('/auth/login') ? 'INVALID_CREDENTIALS' : 'SESSION_EXPIRED', message: 'x' } }),
    );
    await api.login('a', 'b').catch(() => undefined);
    expect(onUnauthorized).not.toHaveBeenCalled();
    await api.wallet().catch(() => undefined);
    expect(onUnauthorized).toHaveBeenCalledWith('SESSION_EXPIRED');
  });
  it('lastOrder : 404 devient null', async () => {
    const { api } = setup(() => res(404, { error: { code: 'NOT_FOUND', message: 'x' } }));
    expect(await api.lastOrder()).toBeNull();
  });
  it('chemins admin', async () => {
    const { api, calls } = setup(() => res(200, {}));
    await api.admin.updateProduct('id1', { priceAr: 2_000 });
    await api.admin.restock('id1', 5);
    await api.admin.adjust('id1', -2);
    await api.admin.resetPin('u1', '864209');
    await api.admin.audit(30);
    expect(calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      'PATCH /api/admin/products/id1',
      'POST /api/admin/products/id1/restock',
      'POST /api/admin/products/id1/adjust',
      'POST /api/admin/users/u1/reset-pin',
      'GET /api/admin/audit?limit=30',
    ]);
  });
});
