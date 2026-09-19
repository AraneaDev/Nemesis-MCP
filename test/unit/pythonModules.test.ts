import { describe, expect, it } from 'vitest';
import { emptyGraph } from '../../src/core/symbolGraph.js';
import { indexPythonFile } from '../../src/extractors/python/index.js';
import type { TypeSymbol } from '../../src/core/types.js';

async function moduleOf(source: string, file = 'app/mod.py'): Promise<TypeSymbol> {
  const g = emptyGraph();
  await indexPythonFile(file, source, g);
  const found = g.modules.get(file);
  if (!found) throw new Error('no module symbol emitted');
  return found;
}

describe('the module symbol for a Python file', () => {
  it('holds top-level functions with their signatures', async () => {
    const m = await moduleOf('def run(value: str) -> bool:\n    return True\n');
    const run = m.methods.get('run');
    expect(run?.returnType).toBe('bool');
    expect(run?.params.map((p) => p.name)).toEqual(['value']);
  });

  it('does not take a method for a top-level function', async () => {
    const m = await moduleOf('class Repo:\n    def save(self, x):\n        return x\n');
    expect(m.methods.has('save')).toBe(false);
  });

  it('holds a name imported from elsewhere, with where it came from', async () => {
    // Python patches a name where it is used, not where it is defined.
    const m = await moduleOf('from core.persistence.database import get_db\n');
    expect(m.imports?.get('get_db')).toEqual({
      from: 'core.persistence.database',
      name: 'get_db',
    });
    // Also unknown, so a source this scan cannot follow never becomes a ghost.
    expect(m.unknownMembers.has('get_db')).toBe(true);
  });

  it('binds an aliased import under the alias', async () => {
    const m = await moduleOf('from core.db import get_db as fetch\n');
    expect(m.imports?.get('fetch')).toEqual({ from: 'core.db', name: 'get_db' });
    expect(m.imports?.has('get_db')).toBe(false);
  });

  it('binds a plain import under its first segment', async () => {
    const m = await moduleOf('import os.path\nimport asyncio\n');
    expect(m.imports?.has('os')).toBe(true);
    expect(m.imports?.has('asyncio')).toBe(true);
  });

  it('binds an aliased module import under its alias', async () => {
    const m = await moduleOf('import os.path as osp\n');
    expect(m.imports?.has('osp')).toBe(true);
    expect(m.imports?.has('os')).toBe(false);
  });

  it('resolves a relative import to a dotted path', async () => {
    const m = await moduleOf('from .formatters import format_payload\n', 'core/webhook/manager.py');
    expect(m.imports?.get('format_payload')?.from).toBe('core.webhook.formatters');
  });

  it('binds an import buried in a try or an if', async () => {
    // `try: import x except ImportError:` and `if TYPE_CHECKING:` are ordinary
    // and both put the statement one level down.
    const m = await moduleOf(
      'try:\n    from fast import parse\nexcept ImportError:\n    from slow import parse\n',
    );
    expect(m.imports?.has('parse')).toBe(true);
    expect(m.unknownMembers.has('parse')).toBe(true);
  });

  it('gives up on a star import', async () => {
    const m = await moduleOf('from x import *\ndef run():\n    pass\n');
    expect(m.unknownMembers.has('*')).toBe(true);
  });

  it('gives up on a module that assigns its own attributes', async () => {
    const m = await moduleOf('import sys\nsetattr(sys.modules[__name__], "x", 1)\n');
    expect(m.unknownMembers.has('*')).toBe(true);
  });

  it('gives up on a module with __getattr__', async () => {
    const m = await moduleOf('def __getattr__(name):\n    return 1\n');
    expect(m.unknownMembers.has('*')).toBe(true);
  });
});
