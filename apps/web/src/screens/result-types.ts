import type { OrderOutcome } from '@vending/shared';

export interface FinalResult {
  readonly outcome: OrderOutcome;
  readonly lines: readonly { readonly name: string; readonly priceAr: number; readonly qty: number; readonly deliveredQty: number }[];
}
