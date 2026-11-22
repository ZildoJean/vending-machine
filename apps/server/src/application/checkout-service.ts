import { err, ok } from '@vending/shared';
import type {
  CheckoutFailure,
  CheckoutRequestError,
  DispenseConfig,
  MachineError,
  MoneyConfig,
  Result,
  TimeoutConfig,
} from '@vending/shared';
import { validateCheckout } from '../domain/cart';
import type { RawCartLine } from '../domain/cart';
import type { Clock } from '../domain/clock';
import { IDLE, statesEqual, transition } from '../domain/machine-state';
import { planRefund } from '../domain/refund';
import { dispenseWithTimeout } from './dispense';
import type { Dispenser, Logger, OrderRecord, OrderStatus, UnitOfWork } from './ports';

export type CheckoutError =
  | { readonly kind: 'MACHINE'; readonly error: MachineError }
  | { readonly kind: 'CART'; readonly failure: CheckoutFailure }
  | { readonly kind: 'REQUEST'; readonly error: CheckoutRequestError };

export interface CheckoutOutcome {
  readonly orderId: string;
  /** PENDING_DISPENSE : la commande existe mais sa distribution n'est pas terminée (rejeu pendant l'exécution). */
  readonly status: OrderStatus;
  readonly totalAr: number;
  readonly refundedAr: number;
  readonly balanceAr: number;
  readonly items: readonly { readonly productId: string; readonly qty: number; readonly deliveredQty: number }[];
  /** true : résultat d'une requête déjà traitée (clé d'idempotence rejouée), rien n'a été refait. */
  readonly replayed: boolean;
}

export interface RecoveryReport {
  readonly recovered: CheckoutOutcome | null;
  /** La machine était en DISPENSING sans commande en cours : remise à IDLE. */
  readonly machineReset: boolean;
}

export interface CheckoutDeps {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly dispenser: Dispenser;
  readonly logger: Logger;
  readonly money: MoneyConfig;
  readonly timeouts: TimeoutConfig;
  readonly dispense: DispenseConfig;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type PlaceResult =
  | { readonly kind: 'PLACED'; readonly order: OrderRecord }
  | { readonly kind: 'REPLAY'; readonly outcome: CheckoutOutcome };

function toOutcome(order: OrderRecord, balanceAr: number, replayed: boolean): CheckoutOutcome {
  return {
    orderId: order.id,
    status: order.status,
    totalAr: order.totalAr,
    refundedAr: order.refundedAr,
    balanceAr,
    items: order.items.map((i) => ({ productId: i.productId, qty: i.qty, deliveredQty: i.deliveredQty })),
    replayed,
  };
}

/** Le panier rejoué est-il identique à la commande existante ? (même produits, mêmes quantités) */
function sameCart(order: OrderRecord, cart: readonly RawCartLine[]): boolean {
  const wanted = new Map<string, number>();
  for (const l of cart) {
    if (typeof l.productId !== 'string' || typeof l.qty !== 'number' || !Number.isSafeInteger(l.qty) || l.qty <= 0) return false;
    if (wanted.has(l.productId)) return false;
    wanted.set(l.productId, l.qty);
  }
  return wanted.size === order.items.length && order.items.every((i) => wanted.get(i.productId) === i.qty);
}

export class CheckoutService {
  constructor(private readonly d: CheckoutDeps) {}

  /**
   * 1) PLACEMENT (une transaction) : session, panier, débit, stock, commande, état DISPENSING.
   * 2) DISTRIBUTION (hors transaction, aucun verrou tenu pendant l'appel matériel) : unité par unité,
   *    chaque unité confirmée est enregistrée immédiatement.
   * 3) CLÔTURE (une transaction) : remboursement des unités non délivrées + retour à IDLE.
   */
  async checkout(
    userId: string,
    cart: readonly RawCartLine[],
    idempotencyKey: unknown,
  ): Promise<Result<CheckoutOutcome, CheckoutError>> {
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8 || idempotencyKey.length > 100) {
      return err({ kind: 'REQUEST', error: 'INVALID_IDEMPOTENCY_KEY' });
    }
    const placed = await this.place(userId, cart, idempotencyKey);
    if (!placed.ok) return placed;
    if (placed.value.kind === 'REPLAY') return ok(placed.value.outcome);

    await this.dispenseAll(placed.value.order);
    return ok(await this.finalize(placed.value.order.id));
  }

  /**
   * À appeler UNE FOIS au démarrage, avant d'accepter des requêtes : clôture la commande restée
   * en cours (crash pendant la distribution) avec les unités réellement enregistrées comme livrées.
   */
  async recoverPending(): Promise<RecoveryReport> {
    const { uow, logger } = this.d;
    const pendingId = await uow.run((tx) => tx.orders.findPendingId());
    if (pendingId !== null) {
      const outcome = await this.finalize(pendingId);
      logger.warn('Commande reprise après interruption', { orderId: pendingId, status: outcome.status });
      return { recovered: outcome, machineReset: false };
    }
    return uow.run(async (tx) => {
      const state = await tx.machine.loadForUpdate();
      if (state.kind === 'CLIENT_ACTIVE' && state.phase === 'DISPENSING' && (await tx.orders.findPendingId()) === null) {
        await tx.machine.save(IDLE);
        logger.error('Machine en DISPENSING sans commande en cours : remise à IDLE', { userId: state.userId });
        return { recovered: null, machineReset: true };
      }
      return { recovered: null, machineReset: false };
    });
  }

  private place(userId: string, cart: readonly RawCartLine[], key: string): Promise<Result<PlaceResult, CheckoutError>> {
    const { uow, clock, money, timeouts } = this.d;
    return uow.run(async (tx): Promise<Result<PlaceResult, CheckoutError>> => {
      const state = await tx.machine.loadForUpdate();
      const now = clock.now(); // APRÈS le verrou

      // 1. Rejeu : même clé => même résultat, rien n'est refait (même si la session est déjà fermée).
      const existing = await tx.orders.findByKey(userId, key);
      if (existing !== null) {
        if (!sameCart(existing, cart)) return err({ kind: 'REQUEST', error: 'IDEMPOTENCY_KEY_REUSED' });
        return ok({ kind: 'REPLAY', outcome: toOutcome(existing, await tx.wallet.balance(userId), true) });
      }

      // 2. Session : propriétaire, non expirée, en sélection. Une tentative compte comme activité.
      const touched = transition(state, { type: 'CLIENT_ACTIVITY', userId }, now, timeouts);
      if (!touched.ok) {
        if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state); // ex. expiration -> IDLE
        return err({ kind: 'MACHINE', error: touched.error });
      }

      // 3. Panier : recalculé depuis la base ; seuls des uuid bien formés sont interrogés.
      const ids = [...new Set(cart.flatMap((l) => (typeof l.productId === 'string' && UUID_RE.test(l.productId) ? [l.productId] : [])))];
      const products = await tx.catalog.loadForUpdate(ids);
      const balance = await tx.wallet.balanceForUpdate(userId);
      const checked = validateCheckout(cart, products, balance, money);
      if (!checked.ok) {
        if (!statesEqual(state, touched.state)) await tx.machine.save(touched.state); // activité enregistrée
        return err({ kind: 'CART', failure: checked.error });
      }

      // 4. Validation : DISPENSING + commande + débit + stock, atomiquement.
      const dispensing = transition(touched.state, { type: 'START_DISPENSE', userId }, now, timeouts);
      if (!dispensing.ok) throw new Error(`Invariant violé : START_DISPENSE refusé (${dispensing.error})`);
      await tx.machine.save(dispensing.state);
      const orderId = await tx.orders.place({ userId, idempotencyKey: key, createdAt: now, quote: checked.value });
      const order = await tx.orders.findById(orderId, { lock: false });
      if (order === null) throw new Error('Invariant violé : commande introuvable après création');
      return ok({ kind: 'PLACED', order });
    });
  }

  private async dispenseAll(order: OrderRecord): Promise<void> {
    const { uow, dispenser, logger, dispense } = this.d;
    for (const item of order.items) {
      for (let n = 1; n <= item.qty; n++) {
        const req = { unitId: `${order.id}:${item.productId}:${n}`, productId: item.productId };
        const outcome = await dispenseWithTimeout(dispenser, req, dispense.unitTimeoutMs, logger);
        if (!outcome.delivered) {
          // Politique : on s'arrête à la première unité défaillante (un blocage touche la machine).
          logger.warn('Unité non délivrée : arrêt de la distribution', { ...req, reason: outcome.reason });
          return;
        }
        // Enregistrée APRÈS la confirmation : un crash entre les deux rembourse une unité livrée
        // (erreur en faveur du client) plutôt que de facturer une unité non livrée.
        await uow.run((tx) => tx.orders.markUnitDelivered(order.id, item.productId));
      }
    }
  }

  private finalize(orderId: string): Promise<CheckoutOutcome> {
    const { uow, clock, timeouts, logger } = this.d;
    return uow.run(async (tx) => {
      const state = await tx.machine.loadForUpdate();
      const now = clock.now();
      const order = await tx.orders.findById(orderId, { lock: true });
      if (order === null) throw new Error(`Invariant violé : commande ${orderId} introuvable`);
      if (order.status !== 'PENDING_DISPENSE') {
        return toOutcome(order, await tx.wallet.balance(order.userId), true); // déjà clôturée
      }

      const plan = planRefund(
        order.items.map((i) => ({ productId: i.productId, qty: i.qty, unitPriceAr: i.unitPriceAr, lineTotalAr: i.qty * i.unitPriceAr })),
        order.items.map((i) => ({ productId: i.productId, count: i.deliveredQty })),
      );
      await tx.orders.finish(order.id, { status: plan.status, refundedAr: plan.refundAr, finishedAt: now, restock: plan.restock });

      const closed = transition(state, { type: 'END_DISPENSE' }, now, timeouts);
      if (closed.ok) await tx.machine.save(closed.state);
      else logger.error('Machine incohérente à la clôture de la commande', { orderId, machine: state.kind, error: closed.error });

      const done = await tx.orders.findById(orderId, { lock: false });
      if (done === null) throw new Error('Invariant violé : commande introuvable après clôture');
      return toOutcome(done, await tx.wallet.balance(order.userId), false);
    });
  }
}
