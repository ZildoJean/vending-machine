import type { DispenseOutcome, DispenseRequest, Dispenser } from '../../application/ports';

export interface SimulatedDispenserOptions {
  /** Durée simulée d'une distribution (ms). */
  readonly delayMs?: number;
  /** Retourne une raison de panne (ex. "JAM") pour faire échouer une unité, ou null. */
  readonly failure?: (req: DispenseRequest, callIndex: number) => string | null;
}

/** Simulateur du matériel : derrière l'interface Dispenser, remplaçable par un vrai pilote. */
export class SimulatedDispenser implements Dispenser {
  private calls = 0;
  constructor(private readonly opts: SimulatedDispenserOptions = {}) {}

  async dispense(req: DispenseRequest): Promise<DispenseOutcome> {
    const index = this.calls++;
    const delay = this.opts.delayMs ?? 0;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    const reason = this.opts.failure?.(req, index) ?? null;
    return reason === null ? { delivered: true } : { delivered: false, reason };
  }
}
