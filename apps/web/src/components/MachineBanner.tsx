import { useQuery } from '@tanstack/react-query';
import { useApi } from '../state/api-context';

const TEXT = {
  IDLE: ['Machine libre', 'bg-emerald-100 text-emerald-900'],
  IN_USE: ['Machine utilisée par un autre client', 'bg-amber-100 text-amber-900'],
  MAINTENANCE: ['Machine en maintenance', 'bg-red-100 text-red-900'],
} as const;

/** État PUBLIC de la machine (aucune identité), actualisé toutes les 5 s. */
export function MachineBanner() {
  const api = useApi();
  const q = useQuery({ queryKey: ['machine-status'], queryFn: api.machineStatus, refetchInterval: 5_000 });
  if (!q.data) return null;
  const [label, cls] = TEXT[q.data.status];
  return (
    <p role="status" className={`rounded-md px-3 py-2 text-sm font-medium ${cls}`}>
      {label}
    </p>
  );
}
