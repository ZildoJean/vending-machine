import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { ReactElement } from 'react';
import type { Api } from '../api/client';
import { ApiProvider } from '../state/api-context';

export function renderWithApi(ui: ReactElement, api: Api) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ApiProvider value={api}>{ui}</ApiProvider>
    </QueryClientProvider>,
  );
  return { ...utils, qc };
}
