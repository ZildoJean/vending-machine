import type { MachineState } from '../domain/machine-state';

export interface MachineStateStore {
  /** Lecture SANS verrou (affichage seulement : peut être périmée dès le retour). */
  load(): Promise<MachineState>;
  /** Lecture AVEC verrou jusqu'à la fin de la transaction : obligatoire avant toute décision. */
  loadForUpdate(): Promise<MachineState>;
  save(state: MachineState): Promise<void>;
}

/**
 * Tout ce qu'une transaction peut toucher. Les prochains dépôts (wallet, produits, commandes)
 * s'ajoutent ici. RÈGLE D'ORDRE DES VERROUS : machine_state d'abord, puis le reste ; l'inverse
 * créerait des deadlocks.
 */
export interface TxContext {
  readonly machine: MachineStateStore;
}

export interface UnitOfWork {
  /** Tout ou rien : si `work` lève, rien n'est écrit. */
  run<T>(work: (tx: TxContext) => Promise<T>): Promise<T>;
}
