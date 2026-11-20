export interface TimeoutConfig {
  /** Inactivité maximale d'une session client (ms). */
  readonly clientInactivityMs: number;
  /** Inactivité maximale du mode maintenance (ms). */
  readonly maintenanceInactivityMs: number;
}

export const TIMEOUT_CONFIG: TimeoutConfig = {
  clientInactivityMs: 2 * 60_000,
  maintenanceInactivityMs: 15 * 60_000,
};

/** Raisons de refus d'une transition, partagées avec le front pour les messages. */
export type MachineError =
  | 'MACHINE_BUSY' //            un autre acteur occupe la machine
  | 'OUT_OF_SERVICE' //          connexion client pendant la maintenance
  | 'DISPENSING_IN_PROGRESS' //  action impossible pendant la distribution
  | 'NOT_OWNER' //               l'acteur n'est pas le propriétaire de la session
  | 'SESSION_EXPIRED' //         la session de l'acteur a expiré (état déjà ramené à IDLE)
  | 'NO_SESSION' //              aucune session correspondante
  | 'TRANSITION_FORBIDDEN'; //   événement sans sens dans l'état courant
