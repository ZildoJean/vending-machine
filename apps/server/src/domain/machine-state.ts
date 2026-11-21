import type { MachineError, TimeoutConfig } from '@vending/shared';

export type MachineState =
  | { readonly kind: 'IDLE' }
  | {
      readonly kind: 'CLIENT_ACTIVE';
      readonly userId: string;
      readonly startedAt: number;
      readonly lastActivityAt: number;
      readonly phase: 'SELECTING' | 'DISPENSING';
    }
  | {
      readonly kind: 'MAINTENANCE';
      readonly adminId: string;
      readonly startedAt: number;
      readonly lastActivityAt: number;
    };

export type MachineEvent =
  | { readonly type: 'LOGIN_CLIENT'; readonly userId: string }
  | { readonly type: 'LOGOUT_CLIENT'; readonly userId: string }
  | { readonly type: 'CLIENT_ACTIVITY'; readonly userId: string }
  | { readonly type: 'START_DISPENSE'; readonly userId: string }
  | { readonly type: 'END_DISPENSE' }
  | { readonly type: 'FORCE_CLOSE' }
  | { readonly type: 'ENTER_MAINTENANCE'; readonly adminId: string }
  | { readonly type: 'EXIT_MAINTENANCE'; readonly adminId: string }
  | { readonly type: 'ADMIN_ACTIVITY'; readonly adminId: string };

/**
 * `state` est TOUJOURS l'état à persister, même en cas de refus : une session expirée est
 * ramenée à IDLE même si l'événement est refusé (ex. SESSION_EXPIRED). L'appelant doit
 * donc écrire `result.state` dans tous les cas.
 */
export type TransitionResult =
  | { readonly ok: true; readonly state: MachineState }
  | { readonly ok: false; readonly error: MachineError; readonly state: MachineState };

export const IDLE: MachineState = { kind: 'IDLE' };

const accept = (state: MachineState): TransitionResult => ({ ok: true, state });
const refuse = (error: MachineError, state: MachineState): TransitionResult => ({ ok: false, error, state });

function assertNow(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new RangeError(`Horloge invalide : ${String(now)}`);
  }
}

export function assertValidTimeoutConfig(cfg: TimeoutConfig): void {
  for (const [k, v] of Object.entries(cfg)) {
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`TimeoutConfig invalide : ${k} = ${String(v)}`);
  }
}

/**
 * Expiration évaluée à la demande (pas de minuteur). Seuil INCLUSIF : à exactement
 * `timeout` ms d'inactivité, la session est expirée. Jamais en DISPENSING.
 * Une horloge qui recule (now < lastActivityAt) ne fait pas expirer.
 */
export function isExpired(s: MachineState, now: number, cfg: TimeoutConfig): boolean {
  assertNow(now);
  switch (s.kind) {
    case 'IDLE':
      return false;
    case 'CLIENT_ACTIVE':
      return s.phase === 'SELECTING' && now - s.lastActivityAt >= cfg.clientInactivityMs;
    case 'MAINTENANCE':
      return now - s.lastActivityAt >= cfg.maintenanceInactivityMs;
  }
}

/**
 * Applique un événement. Si l'état courant est expiré, il est d'abord traité comme IDLE
 * (une session fantôme ne bloque personne : un client peut se connecter, l'admin entrer en
 * maintenance, sans "fermeture forcée"). Cas du propriétaire de la session expirée :
 *  - LOGOUT / EXIT_MAINTENANCE : succès (l'intention est déjà satisfaite) ;
 *  - ACTIVITY / START_DISPENSE : SESSION_EXPIRED, état ramené à IDLE.
 */
export function transition(
  s: MachineState,
  e: MachineEvent,
  now: number,
  cfg: TimeoutConfig,
): TransitionResult {
  assertNow(now);
  if (!isExpired(s, now, cfg)) return apply(s, e, now);

  if (s.kind === 'CLIENT_ACTIVE' && 'userId' in e && e.userId === s.userId) {
    if (e.type === 'LOGOUT_CLIENT') return accept(IDLE);
    if (e.type === 'CLIENT_ACTIVITY' || e.type === 'START_DISPENSE') return refuse('SESSION_EXPIRED', IDLE);
  }
  if (s.kind === 'MAINTENANCE' && 'adminId' in e && e.adminId === s.adminId) {
    if (e.type === 'EXIT_MAINTENANCE') return accept(IDLE);
    if (e.type === 'ADMIN_ACTIVITY') return refuse('SESSION_EXPIRED', IDLE);
  }
  return apply(IDLE, e, now);
}

function apply(s: MachineState, e: MachineEvent, now: number): TransitionResult {
  switch (s.kind) {
    case 'IDLE':
      return fromIdle(s, e, now);
    case 'CLIENT_ACTIVE':
      return s.phase === 'SELECTING' ? fromSelecting(s, e, now) : fromDispensing(s, e);
    case 'MAINTENANCE':
      return fromMaintenance(s, e, now);
  }
}

function fromIdle(s: MachineState, e: MachineEvent, now: number): TransitionResult {
  switch (e.type) {
    case 'LOGIN_CLIENT':
      return accept({ kind: 'CLIENT_ACTIVE', userId: e.userId, startedAt: now, lastActivityAt: now, phase: 'SELECTING' });
    case 'ENTER_MAINTENANCE':
      return accept({ kind: 'MAINTENANCE', adminId: e.adminId, startedAt: now, lastActivityAt: now });
    case 'FORCE_CLOSE': // idempotent : "s'assurer qu'aucune session client n'est ouverte"
      return accept(s);
    case 'END_DISPENSE':
      return refuse('TRANSITION_FORBIDDEN', s);
    case 'LOGOUT_CLIENT':
    case 'CLIENT_ACTIVITY':
    case 'START_DISPENSE':
    case 'EXIT_MAINTENANCE':
    case 'ADMIN_ACTIVITY':
      return refuse('NO_SESSION', s);
  }
}

type Selecting = Extract<MachineState, { kind: 'CLIENT_ACTIVE' }>;

function fromSelecting(s: Selecting, e: MachineEvent, now: number): TransitionResult {
  const touch = Math.max(s.lastActivityAt, now); // monotone, même si l'horloge recule
  switch (e.type) {
    case 'LOGIN_CLIENT': // reconnexion du même client (onglet rechargé, cookie perdu) : autorisée
      return e.userId === s.userId ? accept({ ...s, lastActivityAt: touch }) : refuse('MACHINE_BUSY', s);
    case 'LOGOUT_CLIENT':
      return e.userId === s.userId ? accept(IDLE) : refuse('NOT_OWNER', s);
    case 'CLIENT_ACTIVITY':
      return e.userId === s.userId ? accept({ ...s, lastActivityAt: touch }) : refuse('NOT_OWNER', s);
    case 'START_DISPENSE':
      return e.userId === s.userId
        ? accept({ ...s, phase: 'DISPENSING', lastActivityAt: touch })
        : refuse('NOT_OWNER', s);
    case 'FORCE_CLOSE':
      return accept(IDLE);
    case 'ENTER_MAINTENANCE':
      return refuse('MACHINE_BUSY', s);
    case 'END_DISPENSE':
    case 'EXIT_MAINTENANCE':
    case 'ADMIN_ACTIVITY':
      return refuse('TRANSITION_FORBIDDEN', s);
  }
}

function fromDispensing(s: Selecting, e: MachineEvent): TransitionResult {
  switch (e.type) {
    case 'END_DISPENSE': // la session se ferme après toute commande (règle métier retenue)
      return accept(IDLE);
    case 'LOGIN_CLIENT':
      return e.userId === s.userId ? refuse('DISPENSING_IN_PROGRESS', s) : refuse('MACHINE_BUSY', s);
    case 'LOGOUT_CLIENT':
    case 'CLIENT_ACTIVITY':
      return e.userId === s.userId ? refuse('DISPENSING_IN_PROGRESS', s) : refuse('NOT_OWNER', s);
    case 'START_DISPENSE': // double validation
      return e.userId === s.userId ? refuse('TRANSITION_FORBIDDEN', s) : refuse('NOT_OWNER', s);
    case 'FORCE_CLOSE':
      return refuse('DISPENSING_IN_PROGRESS', s);
    case 'ENTER_MAINTENANCE':
      return refuse('MACHINE_BUSY', s);
    case 'EXIT_MAINTENANCE':
    case 'ADMIN_ACTIVITY':
      return refuse('TRANSITION_FORBIDDEN', s);
  }
}

type Maintenance = Extract<MachineState, { kind: 'MAINTENANCE' }>;

function fromMaintenance(s: Maintenance, e: MachineEvent, now: number): TransitionResult {
  switch (e.type) {
    case 'LOGIN_CLIENT':
      return refuse('OUT_OF_SERVICE', s);
    case 'ENTER_MAINTENANCE':
      return refuse('MACHINE_BUSY', s);
    case 'EXIT_MAINTENANCE':
      return e.adminId === s.adminId ? accept(IDLE) : refuse('NOT_OWNER', s);
    case 'ADMIN_ACTIVITY':
      return e.adminId === s.adminId
        ? accept({ ...s, lastActivityAt: Math.max(s.lastActivityAt, now) })
        : refuse('NOT_OWNER', s);
    case 'LOGOUT_CLIENT':
    case 'CLIENT_ACTIVITY':
    case 'START_DISPENSE':
      return refuse('NO_SESSION', s);
    case 'FORCE_CLOSE':
    case 'END_DISPENSE':
      return refuse('TRANSITION_FORBIDDEN', s);
  }
}

export function statesEqual(a: MachineState, b: MachineState): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'IDLE':
      return true;
    case 'CLIENT_ACTIVE': {
      const o = b as Extract<MachineState, { kind: 'CLIENT_ACTIVE' }>;
      return (
        a.userId === o.userId &&
        a.startedAt === o.startedAt &&
        a.lastActivityAt === o.lastActivityAt &&
        a.phase === o.phase
      );
    }
    case 'MAINTENANCE': {
      const o = b as Extract<MachineState, { kind: 'MAINTENANCE' }>;
      return a.adminId === o.adminId && a.startedAt === o.startedAt && a.lastActivityAt === o.lastActivityAt;
    }
  }
}

/** Ramène une session expirée à IDLE (utilisé par la lecture de l'état, sans événement). */
export function settle(s: MachineState, now: number, cfg: TimeoutConfig): MachineState {
  return isExpired(s, now, cfg) ? IDLE : s;
}
