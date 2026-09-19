import { expect, it, vi } from 'vitest';
import { Profile } from '../src/Profile';

it('experiments with a spy that predates the accessor', () => {
  const profile = new Profile();
  // Without 'get' the framework looks for a function and finds a property.
  vi.spyOn(profile, 'displayName').mockReturnValue('grace');
  expect(profile).not.toBeNull();
});
