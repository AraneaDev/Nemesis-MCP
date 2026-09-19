import { expect, it, vi } from 'vitest';
import { Invoicer, LegacyInvoicer } from '../src/billing';

it('experiments with a double that outlived its class', () => {
  const legacy = new LegacyInvoicer();
  vi.spyOn(legacy, 'issue').mockReturnValue(true);

  const current = new Invoicer();
  vi.spyOn(current, 'issue').mockReturnValue(true);
  expect(current).not.toBeNull();
});
