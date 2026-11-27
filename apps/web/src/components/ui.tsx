import type { ButtonHTMLAttributes, ReactNode } from 'react';

export function Alert({ kind = 'error', children }: { kind?: 'error' | 'info' | 'success'; children: ReactNode }) {
  const styles = {
    error: 'border-red-700 bg-red-50 text-red-900',
    info: 'border-blue-700 bg-blue-50 text-blue-900',
    success: 'border-emerald-700 bg-emerald-50 text-emerald-900',
  }[kind];
  // les erreurs sont annoncées immédiatement, le reste poliment
  return (
    <div role={kind === 'error' ? 'alert' : 'status'} className={`rounded-md border-l-4 px-4 py-3 text-sm ${styles}`}>
      {children}
    </div>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
export function Button({ variant = 'primary', className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = 'min-h-11 rounded-md px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50';
  const v = {
    primary: 'bg-blue-700 text-white hover:bg-blue-800 disabled:hover:bg-blue-700',
    secondary: 'border border-slate-400 bg-white text-slate-900 hover:bg-slate-50',
    danger: 'bg-red-700 text-white hover:bg-red-800',
  }[variant];
  return <button type="button" className={`${base} ${v} ${className}`} {...rest} />;
}

export function Card({ title, children, className = '' }: { title?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-lg bg-white p-4 shadow ${className}`}>
      {title !== undefined && <h2 className="mb-3 text-lg font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

export function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-slate-600">
          {hint}
        </p>
      )}
    </div>
  );
}

export const inputClass = 'min-h-11 rounded-md border border-slate-400 bg-white px-3 py-2 text-base disabled:bg-slate-100';
