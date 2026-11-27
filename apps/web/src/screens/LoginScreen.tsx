import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { MachineBanner } from '../components/MachineBanner';
import { Alert, Button, Card, Field, inputClass } from '../components/ui';
import { describeError } from '../i18n/fr';
import { useApi } from '../state/api-context';

export function LoginScreen({ notice, onLoggedIn }: { notice: string | null; onLoggedIn: () => void }) {
  const api = useApi();
  const [login, setLogin] = useState('');
  const [secret, setSecret] = useState('');
  const m = useMutation({
    mutationFn: () => api.login(login.trim(), secret),
    onSuccess: () => {
      setSecret(''); // le secret ne reste jamais en mémoire de l'interface
      onLoggedIn();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!m.isPending) m.mutate();
  };

  return (
    <div className="mx-auto flex max-w-md flex-col gap-4">
      <MachineBanner />
      {notice !== null && <Alert kind="info">{notice}</Alert>}
      <Card title="Connexion">
        <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
          <Field id="login" label="Identifiant">
            <input
              id="login"
              className={inputClass}
              autoComplete="username"
              autoCapitalize="none"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              required
            />
          </Field>
          <Field id="secret" label="PIN (6 chiffres) ou mot de passe">
            <input
              id="secret"
              className={inputClass}
              type="password"
              autoComplete="current-password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              required
            />
          </Field>
          {m.isError && <Alert>{describeError(m.error)}</Alert>}
          <Button type="submit" disabled={m.isPending || login.trim() === '' || secret === ''}>
            {m.isPending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </Card>
    </div>
  );
}
