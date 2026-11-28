import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useReducer, useState } from 'react';
import type { Dispatch } from 'react';
import { ApiError } from './api/client';
import type { Api } from './api/client';
import { MESSAGES, UNCERTAIN_ORDER_NOTICE } from './i18n/fr';
import { AdminScreen } from './screens/AdminScreen';
import { ClientScreen } from './screens/ClientScreen';
import { LoginScreen } from './screens/LoginScreen';
import { ResultScreen } from './screens/ResultScreen';
import type { FinalResult } from './screens/result-types';
import { ApiProvider, useApi } from './state/api-context';

export interface AppProps {
  /** Fabrique de l'API ; reçoit le rappel à appeler sur toute réponse 401. */
  makeApi: (onUnauthorized: (code: string) => void) => Api;
  queryClient?: QueryClient;
}

/** Message affiché sur l'écran de connexion + drapeau « la réponse d'une validation a été perdue ». */
interface SessionUi {
  readonly notice: string | null;
  readonly uncertain: boolean;
}
type SessionAction = { type: 'uncertain' } | { type: 'unauthorized'; code: string } | { type: 'reset' };

/** Réducteur pur : session fermée juste après une validation sans réponse => message honnête plutôt que « expirée ». */
export function sessionUiReducer(s: SessionUi, a: SessionAction): SessionUi {
  switch (a.type) {
    case 'uncertain':
      return { ...s, uncertain: true };
    case 'unauthorized':
      if (s.uncertain) return { notice: UNCERTAIN_ORDER_NOTICE, uncertain: false };
      return { notice: a.code === 'SESSION_EXPIRED' ? MESSAGES.SESSION_EXPIRED : s.notice, uncertain: false };
    case 'reset':
      return { notice: null, uncertain: false };
  }
}

export function App({ makeApi, queryClient }: AppProps) {
  const qc = useMemo(
    () => queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }),
    [queryClient],
  );
  const [ui, dispatch] = useReducer(sessionUiReducer, { notice: null, uncertain: false });
  const api = useMemo(
    () =>
      makeApi((code) => {
        dispatch({ type: 'unauthorized', code });
        qc.setQueryData(['me'], null);
      }),
    [makeApi, qc],
  );
  return (
    <QueryClientProvider client={qc}>
      <ApiProvider value={api}>
        <Shell notice={ui.notice} dispatch={dispatch} />
      </ApiProvider>
    </QueryClientProvider>
  );
}

/** Vide tout ce qui appartient à la session précédente (jamais de données d'un client visibles par le suivant). */
const clearSessionCaches = (qc: ReturnType<typeof useQueryClient>) =>
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' && q.queryKey[0] !== 'machine-status' });

function Shell({ notice, dispatch }: { notice: string | null; dispatch: Dispatch<SessionAction> }) {
  const api = useApi();
  const qc = useQueryClient();
  const [final, setFinal] = useState<FinalResult | null>(null);

  const me = useQuery({
    queryKey: ['me'],
    enabled: final === null,
    retry: false,
    refetchInterval: (q) => (q.state.data ? 10_000 : false), // resynchronise le compte à rebours et détecte l'expiration
    queryFn: async () => {
      try {
        return await api.me();
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });

  // Les données de la session précédente sont vidées QUAND l'écran du client est démonté : vidées plus tôt,
  // ses requêtes encore actives se recréeraient aussitôt (appels inutiles, sans session valide).
  useEffect(() => {
    if (!me.isPending && me.data == null) clearSessionCaches(qc);
  }, [me.isPending, me.data, qc]);

  const loggedOut = () => {
    dispatch({ type: 'reset' });
    qc.setQueryData(['me'], null);
  };

  let body;
  if (final !== null) {
    body = (
      <ResultScreen
        result={final}
        onDone={() => {
          setFinal(null);
          loggedOut();
        }}
      />
    );
  } else if (me.isPending) {
    body = <p role="status">Chargement…</p>;
  } else if (me.data == null) {
    body = (
      <LoginScreen
        notice={notice}
        onLoggedIn={() => {
          dispatch({ type: 'reset' });
          void qc.invalidateQueries({ queryKey: ['me'] });
        }}
      />
    );
  } else if (me.data.role === 'ADMIN') {
    body = <AdminScreen me={me.data} onLoggedOut={loggedOut} />;
  } else {
    body = (
      <ClientScreen
        me={me.data}
        syncedAt={me.dataUpdatedAt}
        onFinished={(r) => {
          dispatch({ type: 'reset' });
          qc.setQueryData(['me'], null);
          setFinal(r);
        }}
        onLoggedOut={loggedOut}
        onOrderUncertain={() => dispatch({ type: 'uncertain' })}
      />
    );
  }

  return (
    <div className="mx-auto max-w-6xl p-4">
      <a href="#contenu" className="sr-only focus:not-sr-only">
        Aller au contenu
      </a>
      <header className="mb-4">
        <h1 className="text-2xl font-bold">Distributeur de boissons</h1>
      </header>
      <main id="contenu">{body}</main>
    </div>
  );
}
