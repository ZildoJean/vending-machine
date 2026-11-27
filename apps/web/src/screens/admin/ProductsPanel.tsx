import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { formatAr } from '@vending/shared';
import type { AdminProductDto } from '@vending/shared';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Alert, Button, Card, Field, inputClass } from '../../components/ui';
import { describeError } from '../../i18n/fr';
import { useApi } from '../../state/api-context';
import { useAdminMachine } from './use-admin-machine';

const toInt = (s: string): number => (s.trim() === '' ? NaN : Number(s));

export function ProductsPanel() {
  const api = useApi();
  const qc = useQueryClient();
  const { canEdit } = useAdminMachine();
  const q = useQuery({ queryKey: ['admin-products'], queryFn: api.admin.products });
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: ['admin-products'] });
    void qc.invalidateQueries({ queryKey: ['admin-machine'] }); // chaque action prolonge la maintenance
  };
  const fail = (e: unknown) => setError(describeError(e));

  return (
    <div className="flex flex-col gap-4">
      {!canEdit && <Alert kind="info">Pour modifier le catalogue, entrez d&apos;abord en maintenance (onglet « Machine »).</Alert>}
      {error !== null && <Alert>{error}</Alert>}
      <CreateForm disabled={!canEdit} onDone={refresh} onError={fail} />
      <Card title="Produits">
        {q.isPending && <p>Chargement…</p>}
        <ul className="divide-y divide-slate-200">
          {(q.data?.products ?? []).map((p) => (
            <ProductRow key={p.id} p={p} disabled={!canEdit} onDone={refresh} onError={fail} />
          ))}
        </ul>
      </Card>
    </div>
  );
}

interface Common {
  disabled: boolean;
  onDone: () => void;
  onError: (e: unknown) => void;
}

function CreateForm({ disabled, onDone, onError }: Common) {
  const api = useApi();
  const [name, setName] = useState('');
  const [price, setPrice] = useState('');
  const [stock, setStock] = useState('0');
  const m = useMutation({
    mutationFn: () => api.admin.createProduct({ name: name.trim(), priceAr: toInt(price), initialStock: toInt(stock) }),
    onSuccess: () => {
      setName('');
      setPrice('');
      setStock('0');
      onDone();
    },
    onError,
  });
  const invalid = name.trim() === '' || !Number.isInteger(toInt(price)) || !Number.isInteger(toInt(stock));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    m.mutate();
  };
  return (
    <Card title="Nouveau produit">
      <form onSubmit={submit} className="grid gap-3 sm:grid-cols-4 sm:items-end">
        <Field id="np-name" label="Nom">
          <input
            id="np-name"
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
            maxLength={50}
          />
        </Field>
        <Field id="np-price" label="Prix (Ar)">
          <input
            id="np-price"
            className={inputClass}
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Field id="np-stock" label="Stock initial">
          <input
            id="np-stock"
            className={inputClass}
            inputMode="numeric"
            value={stock}
            onChange={(e) => setStock(e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Button type="submit" disabled={disabled || invalid || m.isPending}>
          Créer
        </Button>
      </form>
    </Card>
  );
}

function ProductRow({ p, disabled, onDone, onError }: Common & { p: AdminProductDto }) {
  const api = useApi();
  const [name, setName] = useState(p.name);
  const [price, setPrice] = useState(String(p.priceAr));
  const [qty, setQty] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api.admin.updateProduct(p.id, {
        ...(name.trim() !== p.name ? { name: name.trim() } : {}),
        ...(toInt(price) !== p.priceAr ? { priceAr: toInt(price) } : {}),
      }),
    onSuccess: onDone,
    onError,
  });
  const toggle = useMutation({ mutationFn: () => api.admin.updateProduct(p.id, { active: !p.active }), onSuccess: onDone, onError });
  const restock = useMutation({
    mutationFn: () => api.admin.restock(p.id, toInt(qty)),
    onSuccess: () => {
      setQty('');
      onDone();
    },
    onError,
  });
  const adjust = useMutation({
    mutationFn: () => api.admin.adjust(p.id, toInt(qty)),
    onSuccess: () => {
      setQty('');
      onDone();
    },
    onError,
  });

  const dirty = name.trim() !== p.name || toInt(price) !== p.priceAr;
  const n = toInt(qty);
  const busy = save.isPending || toggle.isPending || restock.isPending || adjust.isPending;
  return (
    <li className="grid gap-3 py-3 md:grid-cols-[1fr_auto]">
      <div className="flex flex-wrap items-end gap-3">
        <Field id={`n-${p.id}`} label={`Nom (${p.name})`}>
          <input
            id={`n-${p.id}`}
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={disabled}
            maxLength={50}
          />
        </Field>
        <Field id={`p-${p.id}`} label="Prix (Ar)">
          <input
            id={`p-${p.id}`}
            className={`${inputClass} w-28`}
            inputMode="numeric"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            disabled={disabled}
          />
        </Field>
        <Button
          variant="secondary"
          aria-label={`Enregistrer ${p.name}`}
          disabled={disabled || !dirty || !Number.isInteger(toInt(price)) || busy}
          onClick={() => save.mutate()}
        >
          Enregistrer
        </Button>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={p.active} onChange={() => toggle.mutate()} disabled={disabled || busy} className="h-5 w-5" />
          Vendu
        </label>
        <span className="text-sm text-slate-700">
          {formatAr(p.priceAr)} · stock <strong>{p.stock}</strong>
        </span>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={`q-${p.id}`} label="Quantité">
          <input
            id={`q-${p.id}`}
            className={`${inputClass} w-24`}
            inputMode="numeric"
            value={qty}
            onChange={(e) => setQty(e.target.value)}
            disabled={disabled}
            placeholder="ex. 12"
          />
        </Field>
        <Button
          variant="secondary"
          aria-label={`Réapprovisionner ${p.name}`}
          disabled={disabled || !Number.isInteger(n) || n < 1 || busy}
          onClick={() => restock.mutate()}
        >
          Ajouter
        </Button>
        <Button
          variant="secondary"
          aria-label={`Corriger le stock de ${p.name}`}
          title="Valeur signée : -3 retire 3 unités"
          disabled={disabled || !Number.isInteger(n) || n === 0 || busy}
          onClick={() => adjust.mutate()}
        >
          Corriger (±)
        </Button>
      </div>
    </li>
  );
}
