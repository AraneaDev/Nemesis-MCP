import { expect, it, vi } from 'vitest';
import { Mailer } from '../src/Mailer';

it('experiments with a fake that kept a dropped parameter', () => {
  const mailer = new Mailer();
  // `subject` was a parameter once. It is handed undefined on every call now,
  // and the suite stays green because nothing reads it.
  vi.spyOn(mailer, 'send').mockImplementation((to, subject) => to.length > 0 && !subject);

  // And this one still believes attempts are counted as strings.
  vi.spyOn(mailer, 'retry').mockImplementation((attempt: string) => attempt === '1');
  expect(mailer).not.toBeNull();
});
