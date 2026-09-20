import { describe, expect, it } from 'vitest';
import { extractPythonDoubles } from '../../src/extractors/python/doubles.js';
import { indexPythonFile } from '../../src/extractors/python/index.js';
import { emptyGraph, resolveType } from '../../src/core/symbolGraph.js';
import { analyzeDoubles } from '../../src/core/analyzer.js';

const doubles = (src: string) => extractPythonDoubles('tests/test_svc.py', src);
const configured = async (src: string) =>
  (await doubles(src)).filter((d) => d.method !== null || d.methods.length > 0);

describe('unittest.mock and pytest-mock patching', () => {
  it('reads a dotted patch target', async () => {
    const [d] = await doubles(
      `from unittest.mock import patch\ndef t():\n    with patch('src.svc.Client.login', return_value='x'): pass`,
    );
    expect(d?.targetSymbol).toBe('src.svc.Client');
    expect(d?.method).toBe('login');
    expect(d?.returnExpr).toBe("'x'");
  });

  it('reads patch.object', async () => {
    const [d] = await doubles(
      `def t():\n    with patch.object(Client, 'login', return_value='x'): pass`,
    );
    expect(d?.targetSymbol).toBe('Client');
    expect(d?.method).toBe('login');
  });

  it('reads the mocker fixture forms', async () => {
    const [a] = await doubles(`def t(mocker):\n    mocker.patch('src.svc.Client.login')`);
    expect(a?.framework).toBe('pytest-mock');
    const [b] = await doubles(`def t(mocker):\n    mocker.patch.object(Client, 'login')`);
    expect(b?.targetSymbol).toBe('Client');
  });

  it('reads patch used as a decorator', async () => {
    const [a] = await doubles(`@patch('src.svc.Client.login')\ndef t(m): pass`);
    expect(a?.method).toBe('login');
    const [b] = await doubles(`@patch.object(Client, 'login')\ndef t(m): pass`);
    expect(b?.targetSymbol).toBe('Client');
  });

  it('reads a patcher bound with as', async () => {
    const [d] = await doubles(
      `def t():\n    with patch.object(Client, 'login') as m:\n        m.return_value = 'x'`,
    );
    expect(d?.method).toBe('login');
  });
});

describe('spec-based mocks', () => {
  it('reads Mock(spec=), MagicMock(spec_set=) and create_autospec', async () => {
    for (const ctor of [
      'Mock(spec=Client)',
      'MagicMock(spec_set=Client)',
      'AsyncMock(spec=Client)',
      'create_autospec(Client)',
    ]) {
      const found = await configured(`def t():\n    m = ${ctor}\n    m.login.return_value = 'x'`);
      expect(found[0]?.targetSymbol, ctor).toBe('Client');
      expect(found[0]?.method, ctor).toBe('login');
    }
  });

  it('records a spec mock once', async () => {
    // Regression: the assignment branch and the call branch both fired, so
    // every `m = Mock(spec=X)` produced two identical doubles.
    const found = await doubles(
      `def t():\n    m = Mock(spec=Client)\n    m.login.return_value = 'x'`,
    );
    expect(found.filter((d) => d.method === null)).toHaveLength(1);
  });

  it('reads the asserted argument count', async () => {
    // Regression: `m.login.assert_called_with(...)` looked `login` up as if it
    // were the mock variable, found nothing, and dropped the arity entirely,
    // so no assertion ever produced an arity check.
    const found = await configured(
      `def t():\n    m = Mock(spec=Client)\n    m.login.assert_called_with('u', 'p')`,
    );
    expect(found[0]?.method).toBe('login');
    expect(found[0]?.assertedArity).toBe(2);
  });

  it('reads assert_called_once_with and assert_any_call', async () => {
    for (const assertion of ['assert_called_once_with', 'assert_any_call']) {
      const found = await configured(
        `def t():\n    m = Mock(spec=Client)\n    m.login.${assertion}('u')`,
      );
      expect(found[0]?.assertedArity, assertion).toBe(1);
    }
  });
});

describe('bound method parameters', () => {
  async function paramsFor(source: string, method: string) {
    const graph = emptyGraph();
    await indexPythonFile('src/svc.py', source, graph);
    const type = resolveType(graph, 'Client', { language: 'python' });
    return type?.methods.get(method)?.params.map((p) => p.name) ?? [];
  }

  it('drops self, because the caller does not pass it', async () => {
    // Counting the receiver inverted every Python arity check: a correct
    // two-argument call was reported as needing three, and a genuinely wrong
    // three-argument one fitted inside the inflated maximum.
    expect(await paramsFor('class Client:\n    def login(self, u, p): pass\n', 'login')).toEqual([
      'u',
      'p',
    ]);
  });

  it('drops cls from a classmethod', async () => {
    expect(
      await paramsFor('class Client:\n    @classmethod\n    def build(cls, n): pass\n', 'build'),
    ).toEqual(['n']);
  });

  it('keeps every parameter of a staticmethod', async () => {
    expect(
      await paramsFor('class Client:\n    @staticmethod\n    def helper(a, b): pass\n', 'helper'),
    ).toEqual(['a', 'b']);
  });

  it('strips annotations from parameter names', async () => {
    expect(
      await paramsFor('class Client:\n    def login(self, u: str, p: int = 3): pass\n', 'login'),
    ).toEqual(['u', 'p']);
  });

  it('marks defaults and variadics', async () => {
    const graph = emptyGraph();
    await indexPythonFile(
      'src/svc.py',
      'class Client:\n    def login(self, u, p=1, *args, **kw): pass\n',
      graph,
    );
    const params =
      resolveType(graph, 'Client', { language: 'python' })?.methods.get('login')?.params ?? [];
    expect(params.map((p) => [p.name, p.hasDefault, p.variadic])).toEqual([
      ['u', false, false],
      ['p', true, false],
      ['*args', false, true],
      ['**kw', false, true],
    ]);
  });
});

describe('patch.multiple', () => {
  it('reads every keyword as a member that has to exist', async () => {
    const [d] = await extractPythonDoubles(
      't.py',
      'def test_x(mocker):\n    mocker.patch.multiple(Vault, seal=mocker.DEFAULT, unseal=mocker.DEFAULT)\n',
    );
    expect(d?.targetSymbol).toBe('Vault');
    expect(d?.methods.map((m) => m.name)).toEqual(['seal', 'unseal']);
  });

  it("leaves patch's own keywords out of the member list", async () => {
    const [d] = await extractPythonDoubles(
      't.py',
      'def test_x(mocker):\n    mocker.patch.multiple(Vault, autospec=True, create=False, seal=mocker.DEFAULT)\n',
    );
    expect(d?.methods.map((m) => m.name)).toEqual(['seal']);
  });

  it('records nothing when there is no member to name', async () => {
    const doubles = await extractPythonDoubles(
      't.py',
      'def test_x(mocker):\n    mocker.patch.multiple(Vault, autospec=True)\n',
    );
    expect(doubles).toEqual([]);
  });
});

// `patch("pkg.mod.obj.method")` names an attribute of a module far more often
// than it names a submodule. Resolving only submodules left this whole idiom
// unchecked: in one repository it was most of the corpus.
describe('a patch target naming an object a module holds', () => {
  async function run(
    files: Record<string, string>,
    patchTarget: string,
    stats?: { checked: number; unresolved: number; unknowable: number; noTarget: number },
  ) {
    const g = emptyGraph();
    for (const [f, src] of Object.entries(files)) await indexPythonFile(f, src, g);
    const src = `from unittest.mock import patch\ndef t():\n    with patch('${patchTarget}'): pass`;
    const ds = await extractPythonDoubles('tests/test_x.py', src);
    return analyzeDoubles({
      doubles: ds,
      graph: g,
      fileLines: new Map([['tests/test_x.py', src.split('\n')]]),
      options: { strictness: 'all' },
      ...(stats ? { stats } : {}),
    });
  }

  const BUS = 'class EventBus:\n    def publish(self, topic):\n        return True\n';

  it('follows the module attribute to the class it was built from', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const found = await run(
      {
        'core/tasks/event_bus.py': `${BUS}\nevent_bus = EventBus()\n`,
        'core/jobs.py': 'from core.tasks.event_bus import event_bus\n',
      },
      'core.jobs.event_bus.publish',
      stats,
    );
    expect(stats.checked).toBe(1);
    expect(stats.unresolved).toBe(0);
    expect(found).toEqual([]);
  });

  it('reports a member the object it found does not have', async () => {
    const found = await run(
      {
        'core/tasks/event_bus.py': `${BUS}\nevent_bus = EventBus()\n`,
        'core/jobs.py': 'from core.tasks.event_bus import event_bus\n',
      },
      'core.jobs.event_bus.emit',
    );
    expect(found.map((f) => f.message)).toEqual(["Method 'emit' does not exist on 'EventBus'."]);
  });

  it('counts an attribute bound from outside the scan as having no contract', async () => {
    // `patch("core.jobs.asyncio.sleep")` reaches the stdlib asyncio bound in
    // that module. It is not a target this scan failed to find.
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const found = await run(
      { 'core/jobs.py': 'import asyncio\n\ndef run():\n    pass\n' },
      'core.jobs.asyncio.sleep',
      stats,
    );
    expect(stats.unknowable).toBe(1);
    expect(stats.unresolved).toBe(0);
    expect(found).toEqual([]);
  });

  it('still counts a name the module does not bind as unresolved', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    await run({ 'core/jobs.py': 'def run():\n    pass\n' }, 'core.jobs.nothing_here.x', stats);
    expect(stats.unresolved).toBe(1);
    expect(stats.unknowable).toBe(0);
  });
});
