import { useMutation } from '@tanstack/react-query';
import type { MeResponse } from '@vending/shared';
import { useState } from 'react';
import { Alert, Button } from '../components/ui';
import { describeError } from '../i18n/fr';
import { useApi } from '../state/api-context';
import { AuditPanel } from './admin/AuditPanel';
import { MachinePanel } from './admin/MachinePanel';
import { ProductsPanel } from './admin/ProductsPanel';
import { UsersPanel } from './admin/UsersPanel';

const TABS = [
  ['machine', 'Machine'],
  ['products', 'Produits'],
  ['users', 'Comptes'],
  ['audit', 'Audit'],
] as const;
type Tab = (typeof TABS)[number][0];

export function AdminScreen({ me, onLoggedOut }: { me: MeResponse; onLoggedOut: () => void }) {
  const api = useApi();
  const [tab, setTab] = useState<Tab>('machine');
  const logout = useMutation({ mutationFn: () => api.logout(), onSuccess: onLoggedOut });
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <p className="text-sm">
          Administrateur : <strong>{me.login}</strong>
        </p>
        <Button variant="secondary" onClick={() => logout.mutate()} disabled={logout.isPending}>
          Me déconnecter
        </Button>
      </div>
      {logout.isError && <Alert>{describeError(logout.error)}</Alert>}
      <nav aria-label="Sections d'administration" className="flex gap-2">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => setTab(id)}
            className={`min-h-11 rounded-md px-4 text-sm font-semibold ${tab === id ? 'bg-blue-700 text-white' : 'border border-slate-400 bg-white'}`}
          >
            {label}
          </button>
        ))}
      </nav>
      {tab === 'machine' && <MachinePanel />}
      {tab === 'products' && <ProductsPanel />}
      {tab === 'users' && <UsersPanel />}
      {tab === 'audit' && <AuditPanel />}
    </div>
  );
}
