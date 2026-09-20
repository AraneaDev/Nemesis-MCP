import { expect, it, vi } from 'vitest';
import * as repo from '../src/repo';

it('experiments with a module mock that outlived its exports', () => {
  // `countRowz` was renamed. Nothing imports the fake, so nothing finds out.
  vi.spyOn(repo, 'countRowz');

  // `query` is imported into repo.ts rather than defined there, and returns a
  // number.
  vi.spyOn(repo, 'query').mockReturnValue('many');

  expect(repo).not.toBeNull();
});
