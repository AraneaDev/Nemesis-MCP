import { expect, it, vi } from 'vitest';
import { ProfileService } from '../src/Profile.js';

it('experiments with an obsolete async return shape', () => {
  const service = new ProfileService();
  vi.spyOn(service, 'load').mockResolvedValue({ id: '1' } as any);
  expect(service).toBeDefined();
});
