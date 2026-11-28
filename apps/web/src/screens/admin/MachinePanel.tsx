import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card } from '../../components/ui';
import { useNow } from '../../hooks/use-now';
import { describeError } from '../../i18n/fr';
import { formatMmSs, remainingAt } from '../../lib/countdown';
import { useApi } from '../../state/api-context';
import { useAdminMachine } from './use-admin-machine';

export function MachinePanel() {
  const api = useApi();
  const qc = useQueryClient();
  const { query } = useAdminMachine();
  const now = useNow();
  const [confirm, setConfirm] = useState(false);
  const done = () => {
    setConfirm(false);
    void qc.invalidateQueries({ queryKey: ['admin-machine'] });
  };
  const enter = useMutation({ mutationFn: () => api.admin.enterMaintenance(), onSuccess: done });
  const exit = useMutation({ mutationFn: () => api.admin.exitMaintenance(), onSuccess: done });
  const force = useMutation({ mutationFn: () => api.admin.forceClose(), onSuccess: done });
  const err = enter.error ?? exit.error ?? force.error;
  const s = query.data;

  return (
    <Card title="État de la machine">
      {query.isPending && <p>Chargement…</p>}
      {s?.status === 'IDLE' && <p className="mb-4 font-medium text-emerald-800">Machine libre.</p>}
      {s?.status === 'IN_USE' && (
        <p className="mb-4 font-medium text-amber-900">
          Un client utilise la machine{s.phase === 'DISPENSING' ? ' (distribution en cours : action impossible)' : ''}.
        </p>
      )}
      {s?.status === 'MAINTENANCE' && (
        <p className="mb-4 font-medium text-red-900">
          {s.ownedByMe ? 'Vous êtes en maintenance' : 'Maintenance tenue par un autre administrateur'}
          {s.ownedByMe && (
            <>
              {' '}
              — expire dans <span role="timer">{formatMmSs(remainingAt(s.remainingMs, query.dataUpdatedAt, now))}</span> d&apos;inactivité
            </>
          )}
          .
        </p>
      )}
      {err && (
        <div className="mb-3">
          <Alert>{describeError(err)}</Alert>
        </div>
      )}
      <div className="flex flex-wrap gap-3">
        <Button onClick={() => enter.mutate()} disabled={s?.status !== 'IDLE' || enter.isPending}>
          Entrer en maintenance
        </Button>
        <Button
          variant="secondary"
          onClick={() => exit.mutate()}
          disabled={!(s?.status === 'MAINTENANCE' && s.ownedByMe) || exit.isPending}
        >
          Sortir de la maintenance
        </Button>
        {!confirm ? (
          <Button variant="danger" onClick={() => setConfirm(true)} disabled={!(s?.status === 'IN_USE' && s.phase === 'SELECTING')}>
            Fermer la session client
          </Button>
        ) : (
          <span className="flex items-center gap-2">
            <span className="text-sm">Le client perdra sa sélection (son argent reste dans son wallet).</span>
            <Button variant="danger" onClick={() => force.mutate()} disabled={force.isPending}>
              Confirmer
            </Button>
            <Button variant="secondary" onClick={() => setConfirm(false)}>
              Annuler
            </Button>
          </span>
        )}
      </div>
    </Card>
  );
}
