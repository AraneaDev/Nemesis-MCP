import { expect, it, vi } from 'vitest';
import { Cart } from '../src/Cart.js';

it('experiments with an obsolete call signature', () => {
  const cart = new Cart();
  const spy = vi.spyOn(cart, 'remove');
  spy.toHaveBeenCalledWith('SKU-1', true);
  expect(spy).toBeDefined();
});
