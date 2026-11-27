import { createHash, randomBytes } from 'node:crypto';
import { err, ok } from '@vending/shared';
import type { AUTH_POLICY, MachineError, Result, TimeoutConfig } from '@vending/shared';
import type { Clock } from '../domain/clock';
import { applyMachineEvent, MachineService } from './machine-service';
import type { Logger, Role, SecretHasher, UnitOfWork } from './ports';

export type AuthPolicy = typeof AUTH_POLICY;

export interface Principal {
  readonly userId: string;
  readonly login: string;
  readonly role: Role;
  readonly sessionId: string;
  /** Temps restant avant expiration (ms) ; null si la session n'expire pas (distribution en cours). */
  readonly remainingMs: number | null;
}
export interface LoginOutcome {
  readonly token: string;
  readonly role: Role;
  readonly login: string;
  /** Durée de vie du cookie (ms) ; null = cookie de session (clients : la machine fait foi). */
  readonly maxAgeMs: number | null;
}
export type LoginError = { readonly kind: 'INVALID_CREDENTIALS' } | { readonly kind: 'MACHINE'; readonly error: MachineError };
export type AuthError = 'UNAUTHENTICATED' | 'SESSION_EXPIRED';

export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOUCH_EVERY_MS = 60_000;

export interface AuthDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly hasher: SecretHasher;
  readonly machine: MachineService;
  readonly timeouts: TimeoutConfig;
  readonly policy: AuthPolicy;
  readonly logger: Logger;
}

export class AuthService {
  private dummy: Promise<string> | undefined;
  constructor(private readonly d: AuthDeps) {}

  /** Hachage factice pour qu'un login inconnu ou verrouillé coûte le même temps qu'un vrai. */
  private dummyHash(): Promise<string> {
    this.dummy ??= this.d.hasher.hash(randomBytes(16).toString('hex'));
    return this.dummy;
  }

  /**
   * 1. réserve atomiquement une tentative (commit immédiat : le compteur survit à tout échec) ;
   * 2. vérifie le secret (même coût si le login est inconnu ou verrouillé : réponse identique) ;
   * 3. seulement alors, prend la machine (client) et crée la session, dans UNE transaction.
   */
  async login(login: string, secret: string): Promise<Result<LoginOutcome, LoginError>> {
    const { uow, clock, hasher, policy } = this.d;
    const reserved = await uow.run((tx) => tx.users.reserveAttempt(login, clock.now(), policy));
    const valid = await hasher.verify(reserved?.secretHash ?? (await this.dummyHash()), secret);
    if (reserved === null || !valid) return err({ kind: 'INVALID_CREDENTIALS' });

    const token = randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);

    return uow.run(async (tx): Promise<Result<LoginOutcome, LoginError>> => {
      await tx.users.recordSuccess(reserved.id);
      const now = clock.now();
      if (reserved.role === 'ADMIN') {
        await tx.sessions.replace({ userId: reserved.id, tokenHash, machineStartedAt: null, now, expiresAt: now + policy.adminAbsoluteMs });
        await tx.audit.append({ actorId: reserved.id, action: 'ADMIN_LOGIN', entity: 'user', entityId: reserved.id, createdAt: now });
        return ok({ token, role: 'ADMIN', login, maxAgeMs: policy.adminAbsoluteMs });
      }
      const r = await applyMachineEvent(tx, clock, this.d.timeouts, { type: 'LOGIN_CLIENT', userId: reserved.id });
      if (!r.ok) return err({ kind: 'MACHINE', error: r.error });
      if (r.state.kind !== 'CLIENT_ACTIVE') throw new Error('Invariant violé : LOGIN_CLIENT sans session client');
      await tx.sessions.replace({ userId: reserved.id, tokenHash, machineStartedAt: r.state.startedAt, now, expiresAt: null });
      return ok({ token, role: 'CLIENT', login, maxAgeMs: null });
    });
  }

  /** Session valide ? Pour un client, c'est machine_state qui décide (propriétaire + même début de session). */
  async authenticate(token: string | undefined): Promise<Result<Principal, AuthError>> {
    if (token === undefined || token.length < 20 || token.length > 200) return err('UNAUTHENTICATED');
    const { uow, clock, policy } = this.d;
    const session = await uow.run((tx) => tx.sessions.findByHash(hashToken(token)));
    if (session === null) return err('UNAUTHENTICATED');
    const now = clock.now();
    const base = { userId: session.userId, login: session.login, role: session.role, sessionId: session.id };

    if (session.role === 'ADMIN') {
      const expired = (session.expiresAt !== null && now >= session.expiresAt) || now - session.lastSeenAt >= policy.adminIdleMs;
      if (expired) {
        await uow.run((tx) => tx.sessions.deleteById(session.id));
        return err('SESSION_EXPIRED');
      }
      if (now - session.lastSeenAt > TOUCH_EVERY_MS) await uow.run((tx) => tx.sessions.touch(session.id, now));
      const lastSeen = now - session.lastSeenAt > TOUCH_EVERY_MS ? now : session.lastSeenAt; // vient d'être renouvelé
      const idleLeft = policy.adminIdleMs - (now - lastSeen);
      const absoluteLeft = session.expiresAt === null ? Number.POSITIVE_INFINITY : session.expiresAt - now;
      return ok({ ...base, remainingMs: Math.max(0, Math.min(idleLeft, absoluteLeft)) });
    }

    const state = await this.d.machine.status(); // lecture sans verrou ; règle l'expiration
    const live = state.kind === 'CLIENT_ACTIVE' && state.userId === session.userId && state.startedAt === session.machineStartedAt;
    if (!live) {
      await uow.run((tx) => tx.sessions.deleteById(session.id));
      return err('SESSION_EXPIRED');
    }
    const remainingMs = state.phase === 'DISPENSING' ? null : Math.max(0, state.lastActivityAt + this.d.timeouts.clientInactivityMs - now);
    return ok({ ...base, remainingMs });
  }

  /** Purge les sessions mortes (démarrage, puis toutes les heures). Renvoie le nombre supprimé. */
  purgeStaleSessions(): Promise<number> {
    const { uow, clock, policy } = this.d;
    return uow.run((tx) => tx.sessions.deleteStale(clock.now(), { adminIdleMs: policy.adminIdleMs, clientMaxAgeMs: 24 * 3_600_000 }));
  }

  /** Déconnexion. Un client ne peut pas partir pendant la distribution. */
  async logout(principal: Principal): Promise<Result<void, { readonly kind: 'MACHINE'; readonly error: MachineError }>> {
    const { uow, clock, timeouts } = this.d;
    return uow.run(async (tx) => {
      if (principal.role === 'CLIENT') {
        const r = await applyMachineEvent(tx, clock, timeouts, { type: 'LOGOUT_CLIENT', userId: principal.userId });
        if (!r.ok && r.error === 'DISPENSING_IN_PROGRESS') return err({ kind: 'MACHINE', error: r.error });
      } else {
        // un administrateur qui se déconnecte ne laisse pas la machine en maintenance
        await applyMachineEvent(tx, clock, timeouts, { type: 'EXIT_MAINTENANCE', adminId: principal.userId });
      }
      await tx.sessions.deleteById(principal.sessionId);
      return ok(undefined);
    });
  }
}
