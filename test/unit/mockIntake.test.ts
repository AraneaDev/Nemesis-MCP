import { describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';
import { extractPythonDoubles } from '../../src/extractors/python/doubles.js';
import { runAudit } from '../../src/core/runtime.js';
import type { UnreadMock } from '../../src/core/types.js';

// A double dropped in the extractor reaches no bucket, so no amount of reading
// `doubles_unresolved` can show it. Three gaps found in one day were exactly
// this: a specifier that had to start with a dot, a spread that discarded the
// factory, and a shorthand key that did the same. Counting what the extractor
// recognised as a mock and then declined to read is what makes them visible.
const unread = async (src: string) =>
  (await extractTsDoubles('tests/a.test.ts', src, 'typescript')).unread;

describe('mock call sites the extractor could not read', () => {
  it('counts nothing when every factory is readable', async () => {
    expect(await unread(`vi.mock('../api', () => ({ getUser: vi.fn(), a }));`)).toEqual([]);
  });

  it('counts nothing for a bare mock with no factory', async () => {
    // `vi.mock('../api')` asks for an automock. There is no configuration to
    // read, so there is nothing unread about it.
    expect(await unread(`vi.mock('../api');`)).toEqual([]);
  });

  it('counts a factory whose body is not an object', async () => {
    const got = await unread(`vi.mock('../api', () => buildFake());`);
    expect(got).toEqual([{ line: 1, reason: 'factory returns a call_expression' }]);
  });

  it('counts a computed key', async () => {
    const got = await unread(`vi.mock('../api', () => ({ [name]: vi.fn() }));`);
    expect(got).toEqual([{ line: 1, reason: 'factory has a computed key' }]);
  });

  it('counts a specifier that is not a literal', async () => {
    const got = await unread(`vi.mock(target, () => ({ getUser: vi.fn() }));`);
    expect(got).toEqual([{ line: 1, reason: 'specifier is not a string literal' }]);
  });

  it('reports the line so the site can be found', async () => {
    const got = await unread(
      ['// a comment', `vi.mock('../api', () => ({ [k]: vi.fn() }));`].join('\n'),
    );
    expect(got[0]?.line).toBe(2);
  });
});

describe('the summary reports what went unread', () => {
  it('carries a count and its reasons, without failing the run', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'nemesis-intake-'));
    try {
      await writeFile(
        path.join(dir, 'a.test.ts'),
        [
          `import { getUser } from './api';`,
          `vi.mock('./api', () => ({ [k]: vi.fn() }));`,
          `vi.mock(target, () => ({ getUser: vi.fn() }));`,
          `vi.mock('./api', () => buildFake());`,
        ].join('\n'),
      );
      const result = await runAudit({
        rootDir: dir,
        strictness: 'all',
        languages: ['typescript'],
      });
      expect(result.summary.mocks_unread).toBe(3);
      expect(result.summary.mocks_unread_reasons).toEqual({
        'factory has a computed key': 1,
        'specifier is not a string literal': 1,
        'factory returns a call_expression': 1,
      });
      // Unread sites say something about this tool, not about the repository,
      // so they must never be mistaken for a partial scan.
      expect(result.summary.partial).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('python patch targets the extractor cannot read', () => {
  const pyUnread = async (src: string) => {
    const unread: UnreadMock[] = [];
    await extractPythonDoubles('tests/test_svc.py', src, undefined, unread);
    return unread;
  };

  it('counts nothing when the target is a literal', async () => {
    expect(await pyUnread(`patch('svc.get_user')`)).toEqual([]);
    expect(await pyUnread(`patch.object(Client, 'send')`)).toEqual([]);
  });

  // `patch(f"{MODULE}.get_user")` is how a test parameterises its own target,
  // and it reads here exactly like a file with no patches in it at all.
  it('counts an interpolated target', async () => {
    const got = await pyUnread(`patch(f"{MODULE}.get_user")`);
    expect(got).toEqual([{ line: 1, reason: 'patch target is an interpolated string' }]);
  });

  // The same string used to reach the target splitter and produce the module
  // name `f"{MODULE}`, which then sat in `unresolved` as if the target had been
  // read and not found.
  it('produces no double for an interpolated target', async () => {
    const ds = await extractPythonDoubles('tests/test_svc.py', `patch(f"{MODULE}.get_user")`);
    expect(ds).toEqual([]);
  });

  it('counts a target held in a variable', async () => {
    const got = await pyUnread(`patch(TARGET)`);
    expect(got).toEqual([{ line: 1, reason: 'patch target is a identifier' }]);
  });

  it('counts a patch.object whose target is subscripted', async () => {
    const got = await pyUnread(`patch.object(registry['client'], 'send')`);
    expect(got).toEqual([{ line: 1, reason: 'patch.object target is a subscript' }]);
  });
});
