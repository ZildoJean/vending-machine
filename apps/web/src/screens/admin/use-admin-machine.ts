import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../state/api-context';

export function useAdminMachine() {
  const api = useApi();
  const q = useQuery({ queryKey: ['admin-machine'], queryFn: api.admin.machine, refetchInterval: 3_000 });
  const canEdit = q.data?.status === 'MAINTENANCE' && q.data.ownedByMe;
  return { query: q, canEdit };
}
