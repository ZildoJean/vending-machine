import { vi } from 'vitest';
import type { AdminMachineDto, AdminProductDto, AuditEntryDto, MeResponse, OrderOutcome, ProductDto, UserDto } from '@vending/shared';
import { ApiError } from '../api/client';
import type { Api } from '../api/client';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface FakeState {
  products: ProductDto[];
  balance: number;
  cap: number;
  bills: number[];
  me: MeResponse | null;
  last: OrderOutcome | null;
  adminMachine: AdminMachineDto;
  adminProducts: AdminProductDto[];
  users: UserDto[];
  audit: AuditEntryDto[];
}

export const COLA: ProductDto = { id: 'p-cola', name: 'Cola', priceAr: 1_500, stock: 5 };
export const EAU: ProductDto = { id: 'p-eau', name: 'Eau', priceAr: 500, stock: 2 };
export const CLIENT_ME: MeResponse = { userId: 'u1', login: 'alice', role: 'CLIENT', remainingMs: 120_000 };
export const ADMIN_ME: MeResponse = { userId: 'a1', login: 'boss', role: 'ADMIN', remainingMs: 1_800_000 };

/** API en mémoire : chaque méthode est un vi.fn (espionnable, surchargeable par test). */
export function createFakeApi(initial: Partial<FakeState> = {}) {
  const s: FakeState = {
    products: [COLA, EAU],
    balance: 0,
    cap: 100_000,
    bills: [100, 200, 500, 1_000, 2_000, 5_000, 10_000, 20_000],
    me: CLIENT_ME,
    last: null,
    adminMachine: { status: 'IDLE' },
    adminProducts: [],
    users: [],
    audit: [],
    ...initial,
  };
  const api = {
    machineStatus: vi.fn(async () => ({ status: 'IDLE' as const })),
    login: vi.fn(async (login: string) => ({ role: 'CLIENT' as const, login })),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => {
      if (s.me === null) throw new ApiError(401, 'UNAUTHENTICATED', 'x');
      return s.me;
    }),
    products: vi.fn(async () => ({ products: s.products.map((p) => ({ ...p })) })),
    wallet: vi.fn(async () => ({ balanceAr: s.balance, walletCapAr: s.cap, acceptedBills: s.bills })),
    deposit: vi.fn(async (b: { bill: number; insertionId: string }) => {
      s.balance += b.bill;
      return { balanceAr: s.balance, replayed: false };
    }),
    order: vi.fn(async (items: { productId: string; qty: number }[], _key: string): Promise<OrderOutcome> => {
      const total = items.reduce((t, i) => t + (s.products.find((p) => p.id === i.productId)?.priceAr ?? 0) * i.qty, 0);
      s.balance -= total;
      return {
        orderId: 'o1',
        status: 'DISPENSED',
        totalAr: total,
        refundedAr: 0,
        balanceAr: s.balance,
        replayed: false,
        items: items.map((i) => ({ ...i, deliveredQty: i.qty })),
      };
    }),
    lastOrder: vi.fn(async () => s.last),
    admin: {
      machine: vi.fn(async () => s.adminMachine),
      enterMaintenance: vi.fn(async () => {
        s.adminMachine = { status: 'MAINTENANCE', ownedByMe: true, remainingMs: 900_000 };
      }),
      exitMaintenance: vi.fn(async () => {
        s.adminMachine = { status: 'IDLE' };
      }),
      forceClose: vi.fn(async () => {
        s.adminMachine = { status: 'IDLE' };
      }),
      products: vi.fn(async () => ({ products: s.adminProducts.map((p) => ({ ...p })) })),
      createProduct: vi.fn(async (b: { name: string; priceAr: number; initialStock: number }) => {
        const p = { id: `n${s.adminProducts.length}`, name: b.name, priceAr: b.priceAr, stock: b.initialStock, active: true };
        s.adminProducts.push(p);
        return { product: p };
      }),
      updateProduct: vi.fn(async (id: string, b: { name?: string; priceAr?: number; active?: boolean }) => {
        const p = s.adminProducts.find((x) => x.id === id) as Mutable<AdminProductDto>;
        Object.assign(p, b);
        return { product: p };
      }),
      restock: vi.fn(async (id: string, qty: number) => {
        const p = s.adminProducts.find((x) => x.id === id) as Mutable<AdminProductDto>;
        p.stock += qty;
        return { product: p };
      }),
      adjust: vi.fn(async (id: string, delta: number) => {
        const p = s.adminProducts.find((x) => x.id === id) as Mutable<AdminProductDto>;
        p.stock += delta;
        return { product: p };
      }),
      users: vi.fn(async () => ({ users: s.users })),
      createUser: vi.fn(async (login: string) => {
        s.users.push({ id: `c${s.users.length}`, login, locked: false });
        return { id: 'new', login };
      }),
      resetPin: vi.fn(async () => undefined),
      audit: vi.fn(async () => ({ entries: s.audit })),
    },
  };
  return { api: api as unknown as Api, mocks: api, s };
}
