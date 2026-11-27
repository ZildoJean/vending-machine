import { describe, expect, it } from 'vitest';
import { sessionUiReducer } from './App';
import { MESSAGES, UNCERTAIN_ORDER_NOTICE } from './i18n/fr';

const init = { notice: null, uncertain: false } as const;

describe('sessionUiReducer', () => {
  it("401 SESSION_EXPIRED : message d'expiration", () => {
    expect(sessionUiReducer(init, { type: 'unauthorized', code: 'SESSION_EXPIRED' })).toEqual({
      notice: MESSAGES.SESSION_EXPIRED,
      uncertain: false,
    });
  });
  it('401 UNAUTHENTICATED (simple absence de session) : aucun message', () => {
    expect(sessionUiReducer(init, { type: 'unauthorized', code: 'UNAUTHENTICATED' }).notice).toBeNull();
  });
  it('après une validation sans réponse, le 401 donne le message HONNÊTE, une seule fois', () => {
    const u = sessionUiReducer(init, { type: 'uncertain' });
    const s = sessionUiReducer(u, { type: 'unauthorized', code: 'SESSION_EXPIRED' });
    expect(s).toEqual({ notice: UNCERTAIN_ORDER_NOTICE, uncertain: false });
    expect(sessionUiReducer({ notice: null, uncertain: false }, { type: 'unauthorized', code: 'SESSION_EXPIRED' }).notice).toBe(
      MESSAGES.SESSION_EXPIRED,
    );
  });
  it('reset efface le message et le drapeau', () => {
    expect(sessionUiReducer({ notice: 'x', uncertain: true }, { type: 'reset' })).toEqual(init);
  });
  it('un 401 sans expiration conserve le message déjà affiché', () => {
    expect(sessionUiReducer({ notice: 'garde', uncertain: false }, { type: 'unauthorized', code: 'UNAUTHENTICATED' }).notice).toBe('garde');
  });
});
