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

  it('takes a decorated top-level function as a member, but not its signature', async () => {
    const m = await moduleOf('@contextmanager\ndef get_db(x):\n    yield x\n');
    expect(m.unknownMembers.has('get_db')).toBe(true);
    // A decorator can change what calling the name does, so the signature
    // of the undecorated function is not trustworthy as the member's shape.
    expect(m.methods.has('get_db')).toBe(false);
  });

  it('takes a top-level class as a member', async () => {
    const m = await moduleOf(
      'class BackupRepository(BaseRepository):\n    def save(self):\n        pass\n',
    );
    expect(m.unknownMembers.has('BackupRepository')).toBe(true);
    expect(m.methods.has('BackupRepository')).toBe(false);
  });

  it('does not take a class method as a module member', async () => {
    const m = await moduleOf(
      'class BackupRepository(BaseRepository):\n    def save(self):\n        pass\n',
    );
    expect(m.unknownMembers.has('save')).toBe(false);
  });

  it('binds a plain top-level assignment', async () => {
    const m = await moduleOf('event_bus = EventBus()\n');
    expect(m.unknownMembers.has('event_bus')).toBe(true);
  });

  it('binds an annotated top-level assignment', async () => {
    const m = await moduleOf('x: int = 1\n');
    expect(m.unknownMembers.has('x')).toBe(true);
  });

  it('binds every name in a tuple-unpacking assignment', async () => {
    const m = await moduleOf('x, y = f()\n');
    expect(m.unknownMembers.has('x')).toBe(true);
    expect(m.unknownMembers.has('y')).toBe(true);
  });

  it('binds nothing for a subscript assignment target', async () => {
    const m = await moduleOf('_check_services = {}\n_check_services[0] = systemd_service.check\n');
    // The plain name from the first line binds; the subscript on the second
    // names no new module member.
    expect(m.unknownMembers.has('_check_services')).toBe(true);
    expect([...m.unknownMembers]).not.toContain('check');
  });

  it('binds nothing for an attribute assignment target', async () => {
    const m = await moduleOf('obj.attr = 1\n');
    expect(m.unknownMembers.has('obj')).toBe(false);
    expect(m.unknownMembers.has('attr')).toBe(false);
  });

  it('does not seed unknownMembers with the Python builtins any more', async () => {
    // `open`, `print` and `len` are still reachable on any module (see
    // `PYTHON_BUILTINS` in core/pythonBuiltins.ts and how the analyzer
    // consults it), but that exemption is no longer folded into this set:
    // doing so made `unknownMembers.size > 0` true for every Python module,
    // which is a different check (the ghost confidence downgrade) than the
    // one this exemption is for.
    const m = await moduleOf('def run():\n    pass\n');
    expect(m.unknownMembers.has('open')).toBe(false);
    expect(m.unknownMembers.has('print')).toBe(false);
    expect(m.unknownMembers.has('len')).toBe(false);
  });

  it('still reports a name that is neither a builtin nor bound as missing', async () => {
    const m = await moduleOf('def run():\n    pass\n');
    expect(m.unknownMembers.has('totally_unbound_name')).toBe(false);
    expect(m.methods.has('totally_unbound_name')).toBe(false);
  });

  // A definition at module scope but inside an `if`, `try`, `with` or loop is
  // still a module attribute. Reading only the top level left such a name
  // bound by nothing, which made it a definite ghost.
  describe('a definition inside a top-level block', () => {
    it('binds a function guarded by a version check', async () => {
      const m = await moduleOf(
        'import sys\n\nif sys.version_info >= (3, 11):\n    def parse(s: str) -> int:\n        return 1\n',
      );
      expect(m.unknownMembers.has('parse')).toBe(true);
    });

    it('does not trust the signature of a conditional definition', async () => {
      // Two branches can declare the same name with different parameters, and
      // which one survives import is not knowable from the source. The name
      // exists; its signature does not. Same treatment as a decorated
      // definition.
      const m = await moduleOf(
        'if FAST:\n    def parse(s, encoding):\n        return 1\nelse:\n    def parse(s):\n        return 2\n',
      );
      expect(m.unknownMembers.has('parse')).toBe(true);
      expect(m.methods.has('parse')).toBe(false);
    });

    it('binds a class defined under a condition', async () => {
      const m = await moduleOf('if True:\n    class Late:\n        pass\n');
      expect(m.unknownMembers.has('Late')).toBe(true);
    });

    it('binds a fallback defined in an except handler', async () => {
      const m = await moduleOf(
        'try:\n    from fast import loads\nexcept ImportError:\n    def loads(x):\n        return x\n',
      );
      expect(m.unknownMembers.has('loads')).toBe(true);
    });

    it('binds a decorated definition under a condition', async () => {
      const m = await moduleOf(
        'if True:\n    @contextmanager\n    def session():\n        yield\n',
      );
      expect(m.unknownMembers.has('session')).toBe(true);
    });

    it('binds an assignment made under a condition', async () => {
      const m = await moduleOf('if DEBUG:\n    LEVEL = 10\n');
      expect(m.unknownMembers.has('LEVEL')).toBe(true);
    });

    it('binds through with, for, while and match blocks', async () => {
      const m = await moduleOf(
        'with ctx():\n    def a():\n        pass\nfor i in r:\n    def b():\n        pass\nwhile x:\n    def c():\n        pass\nmatch v:\n    case 1:\n        def d():\n            pass\n',
      );
      for (const name of ['a', 'b', 'c', 'd']) {
        expect(m.unknownMembers.has(name)).toBe(true);
      }
    });

    it('answers to any name when a conditional __getattr__ is defined', async () => {
      const m = await moduleOf('if True:\n    def __getattr__(name):\n        return 1\n');
      expect(m.unknownMembers.has('*')).toBe(true);
    });

    // The pass descends through statements, never into a new scope, so it must
    // not reach for what a function or a class holds.
    it('does not bind a function nested inside another function', async () => {
      const m = await moduleOf(
        'if True:\n    def outer():\n        def inner():\n            pass\n',
      );
      expect(m.unknownMembers.has('outer')).toBe(true);
      expect(m.unknownMembers.has('inner')).toBe(false);
    });

    it('does not bind a method of a conditionally defined class', async () => {
      const m = await moduleOf(
        'if True:\n    class Repo:\n        def save(self, x):\n            return x\n',
      );
      expect(m.unknownMembers.has('Repo')).toBe(true);
      expect(m.unknownMembers.has('save')).toBe(false);
      expect(m.methods.has('save')).toBe(false);
    });

    it('leaves a plain top-level function in methods with its signature', async () => {
      const m = await moduleOf('def run(value: str) -> bool:\n    return True\n');
      expect(m.methods.get('run')?.returnType).toBe('bool');
      expect(m.unknownMembers.has('run')).toBe(false);
    });
  });
});
