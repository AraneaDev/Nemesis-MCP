import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { escapesRoot } from '../../src/core/runtime.js';

// `path.relative` across Windows volumes returns the absolute target rather
// than a `..` path, so a check that only looked for `..` let `D:\x` through a
// scan rooted on `C:\`.
describe('a requested path against the scan root', () => {
  it('rejects a path on another Windows volume', () => {
    expect(escapesRoot(path.win32.relative('C:\\repo', 'D:\\other'), path.win32)).toBe(true);
  });

  it('rejects a path above the root', () => {
    expect(escapesRoot(path.posix.relative('/repo', '/etc'), path.posix)).toBe(true);
  });

  it('accepts a path inside the root', () => {
    expect(escapesRoot(path.posix.relative('/repo', '/repo/src'), path.posix)).toBe(false);
    expect(escapesRoot(path.win32.relative('C:\\repo', 'C:\\repo\\src'), path.win32)).toBe(false);
  });

  it('accepts a name that merely starts with two dots', () => {
    expect(escapesRoot('..hidden/file', path.posix)).toBe(false);
  });
});
