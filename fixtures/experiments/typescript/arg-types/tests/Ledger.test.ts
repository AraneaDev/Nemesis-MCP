import { expect, it, vi } from 'vitest';
import { Ledger } from '../src/Ledger';

it('asserts the call with the arguments the wrong way round', () => {
  const ledger = new Ledger();
  const spy = vi.spyOn(ledger, 'post');
  // The parameters were reordered in production; the assertion was not.
  expect(spy).toHaveBeenCalledWith('eur', 10);
});
