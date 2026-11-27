import type { DispenseOutcome, DispenseRequest, Dispenser, Logger } from '../application/ports';

type Script = (req: DispenseRequest, callIndex: number) => Promise<DispenseOutcome> | DispenseOutcome;

/** Distributeur scénarisé : journalise les appels et exécute un script (succès, panne, blocage...). */
export class ScriptedDispenser implements Dispenser {
  readonly calls: DispenseRequest[] = [];
  constructor(private readonly script: Script = () => ({ delivered: true })) {}
  dispense(req: DispenseRequest): Promise<DispenseOutcome> {
    const index = this.calls.length;
    this.calls.push(req);
    return Promise.resolve(this.script(req, index));
  }
}

export const failAt =
  (k: number, reason = 'JAM'): Script =>
  (_req, i) =>
    i === k ? { delivered: false, reason } : { delivered: true };

export class CapturingLogger implements Logger {
  readonly warns: string[] = [];
  readonly errors: string[] = [];
  warn(message: string): void {
    this.warns.push(message);
  }
  error(message: string): void {
    this.errors.push(message);
  }
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor : délai dépassé');
    await sleep(10);
  }
}
