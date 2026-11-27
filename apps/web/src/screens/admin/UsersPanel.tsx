import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { validateClientPin } from '@vending/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Card, Field, inputClass } from '../../components/ui';
import { describeError } from '../../i18n/fr';
import { useApi } from '../../state/api-context';

const PIN_HINT = {
  OK: '.',
  BAD_FORMAT: 'Le PIN doit comporter exactement 6 chiffres.',
  WEAK: 'PIN trop simple (suite ou répétition).',
} as const;

export function UsersPanel() {
  const api = useApi();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['admin-users'], queryFn: api.admin.users });
  const [login, setLogin] = useState('');
  const [pin, setPin] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['admin-users'] });

  const create = useMutation({
    mutationFn: () => api.admin.createUser(login.trim(), pin),
    onSuccess: (u) => {
      setMsg({ kind: 'success', text: `Compte « ${u.login} » créé.` });
      setLogin('');
      setPin('');
      refresh();
    },
    onError: (e) => setMsg({ kind: 'error', text: describeError(e) }),
  });
  const pinState = pin === '' ? 'OK' : validateClientPin(pin);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setMsg(null);
    create.mutate();
  };

  return (
    <div className="flex flex-col gap-4">
      {msg !== null && <Alert kind={msg.kind}>{msg.text}</Alert>}
      <Card title="Nouveau compte client">
        <form onSubmit={submit} className="grid gap-3 sm:grid-cols-3 sm:items-end">
          <Field id="nu-login" label="Identifiant" hint="3 à 32 caractères : lettres, chiffres, _ . -">
            <input id="nu-login" className={inputClass} value={login} onChange={(e) => setLogin(e.target.value)} autoCapitalize="none" />
          </Field>
          <Field id="nu-pin" label="PIN (6 chiffres)" hint={PIN_HINT[pinState]}>
            <input
              id="nu-pin"
              className={inputClass}
              inputMode="numeric"
              autoComplete="new-password"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              aria-describedby="nu-pin-hint"
              maxLength={6}
            />
          </Field>
          <Button type="submit" disabled={create.isPending || login.trim().length < 3 || validateClientPin(pin) !== 'OK'}>
            Créer le compte
          </Button>
        </form>
      </Card>
      <Card title="Comptes clients">
        {q.isPending && <p>Chargement…</p>}
        {q.data?.users.length === 0 && <p className="text-sm text-slate-600">Aucun compte client.</p>}
        <ul className="divide-y divide-slate-200">
          {(q.data?.users ?? []).map((u) => (
            <UserRow
              key={u.id}
              id={u.id}
              login={u.login}
              locked={u.locked}
              onDone={(t) => {
                setMsg({ kind: 'success', text: t });
                refresh();
              }}
              onError={(e) => setMsg({ kind: 'error', text: describeError(e) })}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function UserRow({
  id,
  login,
  locked,
  onDone,
  onError,
}: {
  id: string;
  login: string;
  locked: boolean;
  onDone: (t: string) => void;
  onError: (e: unknown) => void;
}) {
  const api = useApi();
  const [pin, setPin] = useState('');
  const m = useMutation({
    mutationFn: () => api.admin.resetPin(id, pin),
    onSuccess: () => {
      setPin('');
      onDone(`PIN de « ${login} » réinitialisé (compte déverrouillé, session fermée).`);
    },
    onError,
  });
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 py-3">
      <span className="font-medium">
        {login} {locked && <span className="ml-2 rounded bg-red-100 px-2 py-0.5 text-xs text-red-900">verrouillé</span>}
      </span>
      <span className="flex items-end gap-2">
        <Field id={`rp-${id}`} label={`Nouveau PIN pour ${login}`}>
          <input
            id={`rp-${id}`}
            className={`${inputClass} w-32`}
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </Field>
        <Button
          variant="secondary"
          aria-label={`Réinitialiser le PIN de ${login}`}
          disabled={validateClientPin(pin) !== 'OK' || m.isPending}
          onClick={() => m.mutate()}
        >
          Réinitialiser
        </Button>
      </span>
    </li>
  );
}
