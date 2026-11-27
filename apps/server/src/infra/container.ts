import { AUTH_POLICY, DISPENSE_CONFIG, MONEY_CONFIG, TIMEOUT_CONFIG } from '@vending/shared';
import type { DispenseConfig, MoneyConfig, TimeoutConfig } from '@vending/shared';
import { AdminService } from '../application/admin-service';
import { AuthService } from '../application/auth-service';
import type { AuthPolicy } from '../application/auth-service';
import { CheckoutService } from '../application/checkout-service';
import { ClientQueries } from '../application/client-queries';
import { DepositService } from '../application/deposit-service';
import { MachineService } from '../application/machine-service';
import type { BillAcceptor, Dispenser, Logger, SecretHasher, UnitOfWork } from '../application/ports';
import type { Clock } from '../domain/clock';
import type { AppDeps } from './http/app';

export interface Wiring {
  readonly uow: UnitOfWork;
  readonly clock: Clock;
  readonly dispenser: Dispenser;
  readonly acceptor: BillAcceptor;
  readonly hasher: SecretHasher;
  readonly logger: Logger;
  readonly ping: () => Promise<void>;
  readonly money?: MoneyConfig;
  readonly timeouts?: TimeoutConfig;
  readonly dispense?: DispenseConfig;
  readonly policy?: AuthPolicy;
}

/** Câblage unique : utilisé tel quel par le serveur ET par les tests (qui passent des doubles). */
export function createServices(w: Wiring): AppDeps & { readonly checkout: CheckoutService } {
  const money = w.money ?? MONEY_CONFIG;
  const timeouts = w.timeouts ?? TIMEOUT_CONFIG;
  const dispense = w.dispense ?? DISPENSE_CONFIG;
  const policy = w.policy ?? AUTH_POLICY;
  const machine = new MachineService(w.uow, w.clock, timeouts);
  return {
    machine,
    money,
    ping: w.ping,
    auth: new AuthService({ uow: w.uow, clock: w.clock, hasher: w.hasher, machine, timeouts, policy, logger: w.logger }),
    checkout: new CheckoutService({ uow: w.uow, clock: w.clock, dispenser: w.dispenser, logger: w.logger, money, timeouts, dispense }),
    deposit: new DepositService({ uow: w.uow, clock: w.clock, acceptor: w.acceptor, money, timeouts }),
    admin: new AdminService({ uow: w.uow, clock: w.clock, hasher: w.hasher, money, timeouts }),
    queries: new ClientQueries(w.uow),
  };
}
