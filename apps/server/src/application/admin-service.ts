import { err, ok, STOCK_LIMITS, validateAdminPassword, validateClientPin } from '@vending/shared';
import type { AdminMachineDto, MachineError, MoneyConfig, PriceError, Result, TimeoutConfig, UserDto } from '@vending/shared';
import type { Clock } from '../domain/clock';
import { settle } from '../domain/machine-state';
import type { MachineEvent } from '../domain/machine-state';
import { validatePrice } from '../domain/money';
import { ConflictError } from './errors';
import { applyMachineEvent } from './machine-service';
import type { AuditEntry, ProductRecord, SecretHasher, TxContext, UnitOfWork } from './ports';

export type AdminFailure =
  | { readonly kind: 'MACHINE'; readonly error: MachineError }
  | { readonly kind: 'NOT_FOUND' }
  | { readonly kind: 'INVALID_PRICE'; readonly error: PriceError }
  | { readonly kind: 'STOCK_OUT_OF_RANGE'; readonly resultingStock: number }
  | { readonly kind: 'INVALID_SECRET'; readonly reason: 'BAD_FORMAT' | 'WEAK' | 'TOO_SHORT' }
  | { readonly kind: 'CONFLICT'; readonly code: 'LOGIN_TAKEN' | 'PRODUCT_NAME_TAKEN' };

export interface AdminDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly hasher: SecretHasher;
  readonly money: MoneyConfig;
  readonly timeouts: TimeoutConfig;
}

type R<T> = Result<T, AdminFailure>;

export class AdminService {
  constructor(private readonly d: AdminDeps) {}

  /** Exécute `work` en transaction ; un conflit d'unicité (levé après annulation) devient un échec typé. */
  private async tx<T>(work: (tx: TxContext) => Promise<R<T>>): Promise<R<T>> {
    try {
      return await this.d.uow.run(work);
    } catch (e) {
      if (e instanceof ConflictError) return err({ kind: 'CONFLICT', code: e.code });
      throw e;
    }
  }

  /** Les actions sur le catalogue exigent la MAINTENANCE de CET administrateur ; elles comptent comme activité. */
  private async inMaintenance<T>(adminId: string, tx: TxContext, work: () => Promise<R<T>>): Promise<R<T>> {
    const r = await applyMachineEvent(tx, this.d.clock, this.d.timeouts, { type: 'ADMIN_ACTIVITY', adminId });
    if (!r.ok) return err({ kind: 'MACHINE', error: r.error });
    return work();
  }

  private machineAction(adminId: string, event: MachineEvent, action: string): Promise<R<void>> {
    return this.tx(async (tx) => {
      const before = await tx.machine.loadForUpdate();
      const r = await applyMachineEvent(tx, this.d.clock, this.d.timeouts, event);
      if (!r.ok) return err({ kind: 'MACHINE', error: r.error });
      await tx.audit.append({
        actorId: adminId,
        action,
        entity: 'machine',
        entityId: null,
        oldValue: { kind: before.kind, ...(before.kind === 'CLIENT_ACTIVE' ? { userId: before.userId, phase: before.phase } : {}) },
        newValue: { kind: r.state.kind },
        createdAt: this.d.clock.now(),
      });
      return ok(undefined);
    });
  }

  enterMaintenance(adminId: string): Promise<R<void>> {
    return this.machineAction(adminId, { type: 'ENTER_MAINTENANCE', adminId }, 'MAINTENANCE_ENTER');
  }
  exitMaintenance(adminId: string): Promise<R<void>> {
    return this.machineAction(adminId, { type: 'EXIT_MAINTENANCE', adminId }, 'MAINTENANCE_EXIT');
  }
  /** Ferme une session client (refusé pendant la distribution). */
  forceClose(adminId: string): Promise<R<void>> {
    return this.machineAction(adminId, { type: 'FORCE_CLOSE' }, 'SESSION_FORCE_CLOSE');
  }

  /** État de la machine vu par un administrateur (lecture sans verrou, expiration évaluée). */
  async machineInfo(adminId: string): Promise<AdminMachineDto> {
    const raw = await this.d.uow.run((tx) => tx.machine.load());
    const now = this.d.clock.now();
    const s = settle(raw, now, this.d.timeouts);
    switch (s.kind) {
      case 'IDLE':
        return { status: 'IDLE' };
      case 'CLIENT_ACTIVE':
        return { status: 'IN_USE', phase: s.phase };
      case 'MAINTENANCE':
        return {
          status: 'MAINTENANCE',
          ownedByMe: s.adminId === adminId,
          remainingMs: Math.max(0, s.lastActivityAt + this.d.timeouts.maintenanceInactivityMs - now),
        };
    }
  }

  async listClients(): Promise<UserDto[]> {
    const rows = await this.d.uow.run((tx) => tx.users.listClients());
    const now = this.d.clock.now();
    return rows.map((r) => ({ id: r.id, login: r.login, locked: r.lockedUntil !== null && r.lockedUntil > now }));
  }

  listProducts(): Promise<ProductRecord[]> {
    return this.d.uow.run((tx) => tx.products.list());
  }

  createProduct(adminId: string, input: { name: string; priceAr: number; initialStock: number }): Promise<R<ProductRecord>> {
    const price = validatePrice(input.priceAr, this.d.money);
    if (!price.ok) return Promise.resolve(err({ kind: 'INVALID_PRICE', error: price.error }));
    return this.tx((tx) =>
      this.inMaintenance(adminId, tx, async () => {
        const now = this.d.clock.now();
        const id = await tx.products.create(input.name, price.value);
        if (input.initialStock > 0)
          await tx.products.addMovement({ productId: id, delta: input.initialStock, reason: 'RESTOCK', actorId: adminId, createdAt: now });
        const created = await tx.products.findForUpdate(id);
        if (created === null) throw new Error('Invariant violé : produit introuvable après création');
        await tx.audit.append({
          actorId: adminId,
          action: 'PRODUCT_CREATE',
          entity: 'product',
          entityId: id,
          newValue: created,
          createdAt: now,
        });
        return ok(created);
      }),
    );
  }

  updateProduct(adminId: string, id: string, patch: { name?: string; priceAr?: number; active?: boolean }): Promise<R<ProductRecord>> {
    if (patch.priceAr !== undefined) {
      const price = validatePrice(patch.priceAr, this.d.money);
      if (!price.ok) return Promise.resolve(err({ kind: 'INVALID_PRICE', error: price.error }));
    }
    return this.tx((tx) =>
      this.inMaintenance(adminId, tx, async () => {
        const before = await tx.products.findForUpdate(id);
        if (before === null) return err({ kind: 'NOT_FOUND' });
        await tx.products.update(id, patch);
        const after = await tx.products.findForUpdate(id);
        if (after === null) throw new Error('Invariant violé : produit introuvable après mise à jour');
        await tx.audit.append({
          actorId: adminId,
          action: 'PRODUCT_UPDATE',
          entity: 'product',
          entityId: id,
          oldValue: before,
          newValue: after,
          createdAt: this.d.clock.now(),
        });
        return ok(after);
      }),
    );
  }

  private changeStock(
    adminId: string,
    id: string,
    delta: number,
    reason: 'RESTOCK' | 'ADMIN_ADJUST',
    action: string,
  ): Promise<R<ProductRecord>> {
    return this.tx((tx) =>
      this.inMaintenance(adminId, tx, async () => {
        const before = await tx.products.findForUpdate(id);
        if (before === null) return err({ kind: 'NOT_FOUND' });
        const resulting = before.stock + delta;
        if (resulting < 0 || resulting > STOCK_LIMITS.maxStock) return err({ kind: 'STOCK_OUT_OF_RANGE', resultingStock: resulting });
        const now = this.d.clock.now();
        await tx.products.addMovement({ productId: id, delta, reason, actorId: adminId, createdAt: now });
        const after = await tx.products.findForUpdate(id);
        if (after === null) throw new Error('Invariant violé : produit introuvable après mouvement');
        await tx.audit.append({
          actorId: adminId,
          action,
          entity: 'product',
          entityId: id,
          oldValue: { stock: before.stock },
          newValue: { stock: after.stock },
          createdAt: now,
        });
        return ok(after);
      }),
    );
  }
  restock(adminId: string, id: string, qty: number): Promise<R<ProductRecord>> {
    return this.changeStock(adminId, id, qty, 'RESTOCK', 'STOCK_RESTOCK');
  }
  adjustStock(adminId: string, id: string, delta: number): Promise<R<ProductRecord>> {
    return this.changeStock(adminId, id, delta, 'ADMIN_ADJUST', 'STOCK_ADJUST');
  }

  /** Création d'un compte CLIENT (les administrateurs ne se créent que par le script de démarrage). */
  async createClient(adminId: string, login: string, pin: string): Promise<R<{ id: string; login: string }>> {
    const check = validateClientPin(pin);
    if (check !== 'OK') return err({ kind: 'INVALID_SECRET', reason: check });
    const secretHash = await this.d.hasher.hash(pin); // hors transaction : coûteux
    return this.tx(async (tx) => {
      const now = this.d.clock.now();
      const id = await tx.users.create({ login, role: 'CLIENT', secretHash, createdAt: now });
      await tx.audit.append({
        actorId: adminId,
        action: 'USER_CREATE',
        entity: 'user',
        entityId: id,
        newValue: { login, role: 'CLIENT' },
        createdAt: now,
      });
      return ok({ id, login });
    });
  }

  async resetClientPin(adminId: string, userId: string, pin: string): Promise<R<void>> {
    const check = validateClientPin(pin);
    if (check !== 'OK') return err({ kind: 'INVALID_SECRET', reason: check });
    const secretHash = await this.d.hasher.hash(pin);
    return this.tx(async (tx) => {
      const user = await tx.users.findById(userId);
      if (user === null || user.role !== 'CLIENT') return err({ kind: 'NOT_FOUND' });
      await tx.users.setSecret(userId, secretHash); // lève aussi le verrouillage
      await tx.sessions.deleteByUser(userId);
      await tx.audit.append({
        actorId: adminId,
        action: 'USER_PIN_RESET',
        entity: 'user',
        entityId: userId,
        createdAt: this.d.clock.now(),
      });
      return ok(undefined);
    });
  }

  listAudit(limit: number): Promise<AuditEntry[]> {
    return this.d.uow.run((tx) => tx.audit.list(limit));
  }

  /** Création du premier administrateur (script de démarrage). Mot de passe : 12 caractères minimum. */
  async createAdmin(login: string, password: string): Promise<R<{ id: string }>> {
    const check = validateAdminPassword(password);
    if (check !== 'OK') return err({ kind: 'INVALID_SECRET', reason: check });
    const secretHash = await this.d.hasher.hash(password);
    return this.tx(async (tx) => {
      const now = this.d.clock.now();
      const id = await tx.users.create({ login, role: 'ADMIN', secretHash, createdAt: now });
      await tx.audit.append({ actorId: null, action: 'ADMIN_CREATE', entity: 'user', entityId: id, newValue: { login }, createdAt: now });
      return ok({ id });
    });
  }
}
