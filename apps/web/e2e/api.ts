/** Client HTTP minimal pour préparer les données de test (cookies gérés à la main, comme un navigateur). */
export const API_URL = process.env.E2E_API_URL ?? 'http://127.0.0.1:3000';
export const WEB_ORIGIN = process.env.E2E_WEB_ORIGIN ?? 'http://localhost:4173';

export class ApiSession {
  private cookie = '';

  async call(method: string, path: string, body?: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: {
        origin: WEB_ORIGIN,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(this.cookie ? { cookie: this.cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    for (const sc of res.headers.getSetCookie()) {
      const [pair = ''] = sc.split(';');
      this.cookie = pair.endsWith('=') ? '' : pair;
    }
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  }
}
