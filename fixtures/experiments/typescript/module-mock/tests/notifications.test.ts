import { expect, it, vi } from 'vitest';
import { sendEmail } from '../src/notifications';

vi.mock('../src/notifications', () => ({
  sendEmail: vi.fn(),
  // `sendSms` left this module. The fake is still here, and nothing imports
  // it, so no test ever finds out.
  sendSms: vi.fn(),
}));

it('experiments with a module mock that outlived an export', () => {
  expect(sendEmail).toBeDefined();
});
