import { vi } from 'vitest';

export const lookup = vi.fn();

// `resolve` was renamed to `lookup` in the real module. Nothing imports this,
// so nothing ever finds out.
export const resolve = vi.fn();
