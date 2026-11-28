import { z } from 'zod';
import { SECRET_MAX, STOCK_LIMITS } from './auth';

const login = z
  .string()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9_.-]+$/, 'caractères autorisés : lettres, chiffres, _ . -');

export const LoginBody = z.strictObject({ login, secret: z.string().min(1).max(SECRET_MAX) });
export const DepositBody = z.strictObject({ bill: z.number().int().positive(), insertionId: z.uuid() });
export const OrderBody = z.strictObject({
  items: z.array(z.strictObject({ productId: z.string().min(1).max(64), qty: z.number().int() })).max(50),
});
export const IdParam = z.strictObject({ id: z.uuid() });

const productName = z.string().trim().min(1).max(50);
export const CreateProductBody = z.strictObject({
  name: productName,
  priceAr: z.number().int(),
  initialStock: z.number().int().min(0).max(STOCK_LIMITS.maxRestockQty).default(0),
});
export const UpdateProductBody = z
  .strictObject({ name: productName.optional(), priceAr: z.number().int().optional(), active: z.boolean().optional() })
  .refine((v) => Object.keys(v).length > 0, 'au moins un champ à modifier');
export const RestockBody = z.strictObject({ qty: z.number().int().min(1).max(STOCK_LIMITS.maxRestockQty) });
export const AdjustBody = z.strictObject({
  delta: z
    .number()
    .int()
    .min(-STOCK_LIMITS.maxStock)
    .max(STOCK_LIMITS.maxStock)
    .refine((n) => n !== 0, 'delta non nul'),
});
export const CreateUserBody = z.strictObject({ login, secret: z.string().min(1).max(SECRET_MAX) });
export const ResetSecretBody = z.strictObject({ secret: z.string().min(1).max(SECRET_MAX) });
export const AuditQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });

export type LoginBodyT = z.infer<typeof LoginBody>;
export type DepositBodyT = z.infer<typeof DepositBody>;
export type OrderBodyT = z.infer<typeof OrderBody>;
