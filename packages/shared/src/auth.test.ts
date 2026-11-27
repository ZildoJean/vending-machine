import { describe, expect, it } from 'vitest';
import { isWeakPin, validateAdminPassword, validateClientPin } from './auth';
import { DepositBody, LoginBody, OrderBody, UpdateProductBody } from './schemas';

describe('PIN', () => {
  it.each(['000000', '111111', '123456', '234567', '654321', '987654', '12345a', '123', '1234567'])('%s refusé', (p) => {
    expect(validateClientPin(p)).not.toBe('OK');
  });
  it.each(['135792', '482915', '100200', '121212'])('%s accepté', (p) => {
    expect(validateClientPin(p)).toBe('OK');
  });
  it('isWeakPin', () => {
    expect(isWeakPin('123456')).toBe(true);
    expect(isWeakPin('135792')).toBe(false);
  });
  it('mot de passe admin : longueur et diversité', () => {
    expect(validateAdminPassword('court')).toBe('TOO_SHORT');
    expect(validateAdminPassword('aaaaaaaaaaaaaaaa')).toBe('WEAK');
    expect(validateAdminPassword('Un-bon-mot-de-passe-42')).toBe('OK');
  });
});

describe('schémas Zod', () => {
  it('login refuse les champs inconnus et les types faux', () => {
    expect(LoginBody.safeParse({ login: 'alice', secret: '135792' }).success).toBe(true);
    expect(LoginBody.safeParse({ login: 'alice', secret: '135792', admin: true }).success).toBe(false);
    expect(LoginBody.safeParse({ login: 'al', secret: 'x' }).success).toBe(false);
    expect(LoginBody.safeParse({ login: 'alice', secret: 135792 }).success).toBe(false);
    expect(LoginBody.safeParse({ login: 'a b c', secret: 'x' }).success).toBe(false);
  });
  it('dépôt : montant entier positif et insertionId uuid', () => {
    const id = '5f0d7e0e-2b1c-4c43-9d49-0d2b3c4e5f60';
    expect(DepositBody.safeParse({ bill: 1000, insertionId: id }).success).toBe(true);
    for (const bill of ['1000', 1.5, -1000, 0, NaN, Infinity]) expect(DepositBody.safeParse({ bill, insertionId: id }).success).toBe(false);
    expect(DepositBody.safeParse({ bill: 1000, insertionId: 'abc' }).success).toBe(false);
  });
  it('commande : quantité entière (le domaine tranche 0 et négatifs)', () => {
    expect(OrderBody.safeParse({ items: [{ productId: 'p', qty: 0 }] }).success).toBe(true);
    expect(OrderBody.safeParse({ items: [{ productId: 'p', qty: '2' }] }).success).toBe(false);
    expect(OrderBody.safeParse({ items: Array.from({ length: 51 }, () => ({ productId: 'p', qty: 1 })) }).success).toBe(false);
  });
  it('modification de produit : au moins un champ', () => {
    expect(UpdateProductBody.safeParse({}).success).toBe(false);
    expect(UpdateProductBody.safeParse({ active: false }).success).toBe(true);
  });
});
