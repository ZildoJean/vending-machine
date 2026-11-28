import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Card } from '../../components/ui';
import { ACTION_LABELS, describeError } from '../../i18n/fr';
import { useApi } from '../../state/api-context';

export function AuditPanel() {
  const api = useApi();
  const q = useQuery({ queryKey: ['admin-audit'], queryFn: () => api.admin.audit(50) });
  return (
    <Card title="Journal d'audit (50 dernières actions)">
      <div className="mb-3">
        <Button variant="secondary" onClick={() => void q.refetch()} disabled={q.isFetching}>
          Actualiser
        </Button>
      </div>
      {q.isError && <Alert>{describeError(q.error)}</Alert>}
      <ul className="divide-y divide-slate-200 text-sm">
        {(q.data?.entries ?? []).map((e) => (
          <li key={e.id} className="py-2">
            <p>
              <span className="text-slate-600">{new Date(e.createdAt).toLocaleString('fr-FR')}</span> —{' '}
              <strong>{ACTION_LABELS[e.action] ?? e.action}</strong>
            </p>
            {(e.oldValue !== null || e.newValue !== null) && (
              <details>
                <summary className="cursor-pointer text-xs text-slate-600">Détails</summary>
                <pre className="overflow-x-auto rounded bg-slate-50 p-2 text-xs">
                  {JSON.stringify({ avant: e.oldValue, après: e.newValue }, null, 2)}
                </pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
