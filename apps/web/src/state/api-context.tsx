import { createContext, useContext } from 'react';
import type { Api } from '../api/client';

const Ctx = createContext<Api | null>(null);
export const ApiProvider = Ctx.Provider;
export function useApi(): Api {
  const api = useContext(Ctx);
  if (api === null) throw new Error('ApiProvider manquant');
  return api;
}
