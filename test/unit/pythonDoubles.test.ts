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

// `patch.object(overrides, "_stored_value")` names something the TEST file
// imported. Without reading the test's own imports the target is a bare word
// that matches nothing, and the double is counted as never compared.
describe('a patch target the test file imported', () => {
  async function run(
    files: Record<string, string>,
    testSrc: string,
    stats?: { checked: number; unresolved: number; unknowable: number; noTarget: number },
  ) {
    const g = emptyGraph();
    for (const [f, src] of Object.entries(files)) await indexPythonFile(f, src, g);
    const ds = await extractPythonDoubles('tests/test_x.py', testSrc);
    return analyzeDoubles({
      doubles: ds,
      graph: g,
      fileLines: new Map([['tests/test_x.py', testSrc.split('\n')]]),
      options: { strictness: 'all' },
      ...(stats ? { stats } : {}),
    });
  }

  // The class name must not be the object name in another case: symbol lookup
  // is case-insensitive, so `overrides` would match a class `Overrides` by
  // accident and the test would pass without the import ever being read.
  const CONFIG =
    'class AppSettings:\n    def stored_value(self, key):\n        return None\n\noverrides = AppSettings()\n';

  it('follows a from-import to the object it names', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const found = await run(
      { 'core/system/app_config.py': CONFIG },
      'from core.system.app_config import overrides\nfrom unittest.mock import patch\n\ndef t():\n    with patch.object(overrides, "stored_value"): pass\n',
      stats,
    );
    expect(stats.checked).toBe(1);
    expect(stats.unresolved).toBe(0);
    expect(found).toEqual([]);
  });

  it('reports a member the imported object does not have', async () => {
    const found = await run(
      { 'core/system/app_config.py': CONFIG },
      'from core.system.app_config import overrides\nfrom unittest.mock import patch\n\ndef t():\n    with patch.object(overrides, "gone"): pass\n',
    );
    expect(found.map((f) => f.message)).toEqual(["Method 'gone' does not exist on 'AppSettings'."]);
  });

  it('follows an aliased import', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    await run(
      { 'core/system/app_config.py': CONFIG },
      'from core.system.app_config import overrides as ov\nfrom unittest.mock import patch\n\ndef t():\n    with patch.object(ov, "stored_value"): pass\n',
      stats,
    );
    expect(stats.checked).toBe(1);
  });

  it('counts a target imported from outside the scan as having no contract', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    const found = await run(
      {},
      'import smtplib\nfrom unittest.mock import patch\n\ndef t():\n    with patch.object(smtplib, "SMTP"): pass\n',
      stats,
    );
    expect(stats.unknowable).toBe(1);
    expect(stats.unresolved).toBe(0);
    expect(found).toEqual([]);
  });

  it('leaves a bare name the test never imported unresolved', async () => {
    const stats = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    await run(
      {},
      'from unittest.mock import patch\n\ndef t():\n    mgr = Manager()\n    with patch.object(mgr, "run"): pass\n',
      stats,
    );
    expect(stats.unresolved).toBe(1);
    expect(stats.unknowable).toBe(0);
  });
});

// `patch("routers.files.os.path.exists")` reaches `os.path` through the `os`
// that `routers/files.py` imports. The module is two segments back from the
// end, not one, and splitting only the last segment found no module at all.
describe('a patch target reaching through a module attribute', () => {
  async function stats(files: Record<string, string>, target: string) {
    const g = emptyGraph();
    for (const [f, src] of Object.entries(files)) await indexPythonFile(f, src, g);
    const src = `from unittest.mock import patch\ndef t():\n    with patch('${target}'): pass\n`;
    const s = { checked: 0, unresolved: 0, unknowable: 0, noTarget: 0 };
    analyzeDoubles({
      doubles: await extractPythonDoubles('tests/test_x.py', src),
      graph: g,
      fileLines: new Map([['tests/test_x.py', src.split('\n')]]),
      options: { strictness: 'all' },
      stats: s,
    });
    return s;
  }

  it('counts a stdlib attribute reached through a module as having no contract', async () => {
    const s = await stats(
      { 'routers/files.py': 'import os\n\ndef listing():\n    return os.path.exists("/")\n' },
      'routers.files.os.path.exists',
    );
    expect(s.unknowable).toBe(1);
    expect(s.unresolved).toBe(0);
  });

  it('still finds the nearer module when both prefixes exist', async () => {
    const s = await stats(
      {
        'core/jobs.py': 'import asyncio\n\ndef run():\n    pass\n',
        'core/jobs/inner.py': 'def other():\n    pass\n',
      },
      'core.jobs.asyncio.sleep',
    );
    expect(s.unknowable).toBe(1);
  });

  it('leaves a target whose every prefix is unknown unresolved', async () => {
    const s = await stats({ 'core/jobs.py': 'def run():\n    pass\n' }, 'nowhere.at.all.x');
    expect(s.unresolved).toBe(1);
    expect(s.unknowable).toBe(0);
  });
});

describe('return_value set through a patcher handle', () => {
  // Only `patch(..., return_value=x)` and a `spec=` mock's attribute were ever
  // connected to a target. The three handle forms below are the common way to
  // write this, and each produced a counted double that was never checked.
  it('binds a with-statement alias', async () => {
    // The patcher call is a double in its own right, so the one under test is
    // the double carrying the return pinned through the alias.
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch.object(Feed, 'count') as m:\n        m.return_value = 'wrong'`,
    );
    const pinned = found.find((x) => x.returnExpr === "'wrong'");
    expect(pinned?.targetSymbol).toBe('Feed');
    expect(pinned?.method).toBe('count');
  });

  it('binds a dotted patch through a with-statement alias', async () => {
    const [d] = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('src.svc.Client.login') as m:\n        m.return_value = 1`,
    );
    // The patch call already yields a double, so the return pinned through the
    // alias is what this is actually about.
    expect(d?.targetSymbol).toBe('src.svc.Client');
    const pinned = (
      await configured(
        `from unittest.mock import patch\ndef t():\n    with patch('src.svc.Client.login') as m:\n        m.return_value = 1`,
      )
    ).find((x) => x.returnExpr === '1');
    expect(pinned?.method).toBe('login');
  });

  it('binds a plain assignment of patch.object', async () => {
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    m = patch.object(Feed, 'count')\n    m.return_value = 'wrong'`,
    );
    const pinned = found.find((x) => x.returnExpr === "'wrong'");
    expect(pinned?.targetSymbol).toBe('Feed');
    expect(pinned?.method).toBe('count');
  });

  it('binds a decorator to the parameter it injects', async () => {
    const found = await configured(
      `from unittest.mock import patch\n@patch.object(Feed, 'count')\ndef test_it(mock_count):\n    mock_count.return_value = 'wrong'`,
    );
    const pinned = found.find((x) => x.returnExpr === "'wrong'");
    expect(pinned?.targetSymbol).toBe('Feed');
    expect(pinned?.method).toBe('count');
  });

  it('binds stacked decorators bottom-up, the way unittest.mock injects them', async () => {
    // The decorator nearest the function supplies the first parameter.
    const found = await configured(
      `from unittest.mock import patch\n@patch.object(Feed, 'top')\n@patch.object(Feed, 'bottom')\ndef test_it(mock_bottom, mock_top):\n    mock_bottom.return_value = 1\n    mock_top.return_value = 2`,
    );
    const byMethod = new Map(found.map((d) => [d.method, d.returnExpr]));
    expect(byMethod.get('bottom')).toBe('1');
    expect(byMethod.get('top')).toBe('2');
  });
});

describe('a patcher and its handle are one double', () => {
  // The patch call and the `return_value` set through its handle describe the
  // same stub. Emitting both reported every finding about it twice, once per
  // line, which reads as two separate problems.
  it('enriches the patcher rather than adding a second double', async () => {
    const found = (
      await configured(
        `from unittest.mock import patch\ndef t():\n    with patch.object(Feed, 'count') as m:\n        m.return_value = 'wrong'`,
      )
    ).filter((d) => d.targetSymbol === 'Feed' && d.method === 'count');
    expect(found).toHaveLength(1);
    expect(found[0]?.returnExpr).toBe("'wrong'");
  });

  it('still records a member configured on a spec mock separately', async () => {
    // `MagicMock(spec=Feed)` names no member, so the attribute really is the
    // only thing naming one and has to stay its own double.
    const found = await configured(
      `from unittest.mock import MagicMock\ndef t():\n    f = MagicMock(spec=Feed)\n    f.count.return_value = 'wrong'`,
    );
    expect(found.filter((d) => d.method === 'count')).toHaveLength(1);
  });
});

describe('attributes of a patched module-level object', () => {
  // `patch("svc.user_repo")` replaces an object that lives in the module, so
  // `handle.get_by_username` configures a member of THAT object, whose type
  // nothing here knows. Reading it as a member of the module claimed the
  // module had the method, which produced 397 false GHOST_METHODs across one
  // repository's test suite.
  it('says nothing about a member reached through a patched attribute', async () => {
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('svc.auth.user_repo') as repo:\n        repo.get_by_username.return_value = None`,
    );
    expect(found.map((d) => d.method)).not.toContain('get_by_username');
  });

  it('says nothing for a dotted patch either, class or object alike', async () => {
    // `patch('svc.auth.Client')` and `patch('svc.auth.user_repo')` are the same
    // syntax. Nothing here can tell a class from an instance, so reading the
    // attribute as a member of one or the other is a guess.
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('svc.auth.Client') as c:\n        c.login.return_value = None`,
    );
    expect(found.map((d) => d.method)).not.toContain('login');
  });

  it('still reads a member of a class named as an identifier', async () => {
    // `patch.object(Client)` names the class outright, so the attribute really
    // is its member and the comparison is sound.
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch.object(Client) as c:\n        c.login.return_value = None`,
    );
    const pinned = found.find((d) => d.method === 'login');
    expect(pinned?.targetSymbol).toBe('Client');
  });

  it('still pins the return of the patched member itself', async () => {
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('svc.auth.get_user') as g:\n        g.return_value = None`,
    );
    const pinned = found.find((d) => d.returnExpr === 'None');
    expect(pinned?.method).toBe('get_user');
  });
});

describe('annotated star parameters', () => {
  // `**kw: Any` parses as a typed parameter rather than a dictionary splat,
  // and that branch recorded it as an ordinary parameter. Every keyword the
  // function absorbs then looked like an argument matching no parameter, and
  // the arity ceiling counted the splat as one slot.
  async function run(signature: string, assertion: string) {
    const graph = emptyGraph();
    await indexPythonFile(
      'src/runner.py',
      `from typing import Any\n\n${signature}\n    return ""\n`,
      graph,
    );
    const src = `from unittest.mock import patch\ndef t():\n    with patch('src.runner.run_decoded') as m:\n        pass\n    ${assertion}`;
    const ds = await extractPythonDoubles('tests/test_runner.py', src);
    return analyzeDoubles({
      doubles: ds,
      graph,
      fileLines: new Map([['tests/test_runner.py', src.split('\n')]]),
      options: { strictness: 'all' },
    });
  }

  it('lets an annotated **kwargs absorb any keyword', async () => {
    const found = await run(
      'def run_decoded(cmd: list[str], **kw: Any) -> str:',
      "m.assert_called_once_with(['git'], as_user=None, timeout=5)",
    );
    expect(found.map((f) => f.message)).toEqual([]);
  });

  it('lets an annotated *args absorb extra positionals', async () => {
    const found = await run(
      'def run_decoded(cmd: list[str], *rest: Any) -> str:',
      "m.assert_called_once_with(['git'], 'a', 'b', 'c')",
    );
    expect(found.map((f) => f.message)).toEqual([]);
  });

  it('still reports a keyword no parameter absorbs', async () => {
    const found = await run(
      'def run_decoded(cmd: list[str], timeout: int = 5) -> str:',
      "m.assert_called_once_with(['git'], timeuot=5)",
    );
    expect(found.map((f) => f.type)).toContain('ARITY_MISMATCH');
  });
});

describe('a name rebound later in the file', () => {
  // The variable map is one flat, scope-blind pass, so `m` in one test
  // function is the same key as `m` in the next. Binding with-aliases made
  // that collide: a `with patch.object(...) as m` in an earlier test kept
  // winning over a later `m = Mock(spec=...)`, and the member configured on
  // the spec mock stopped being checked.
  it('lets a later spec mock replace an earlier patcher binding', async () => {
    const found = await configured(
      `from unittest.mock import patch, Mock\nfrom repo import Repo\n\ndef test_save():\n    with patch.object(Repo, 'save2') as m:\n        pass\n\ndef test_price():\n    m = Mock(spec=Repo)\n    m.price.return_value = 'nope'`,
    );
    const pinned = found.find((d) => d.returnExpr === "'nope'");
    expect(pinned?.targetSymbol).toBe('Repo');
    expect(pinned?.method).toBe('price');
  });

  it('lets a later patcher replace an earlier spec mock binding', async () => {
    const found = await configured(
      `from unittest.mock import patch, Mock\n\ndef test_a():\n    m = Mock(spec=Repo)\n    m.price.return_value = 1\n\ndef test_b():\n    with patch.object(Repo, 'count') as m:\n        m.return_value = 2`,
    );
    const pinned = found.find((d) => d.returnExpr === '2');
    expect(pinned?.method).toBe('count');
  });
});

describe('assertions reached through a patched attribute', () => {
  // The same rule as for `return_value`: `patch("mod.singleton")` replaces an
  // object living in the module, so `handle.method.assert_called_with(...)`
  // asserts on a member of THAT object. Reading it as a member of the module
  // is a guess, and it was the shape of ten of the twelve false positives a
  // sweep of one repository produced.
  it('says nothing when the assertion reaches past the patched name', async () => {
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('core.apache.apache_manager.apache_manager') as m:\n        pass\n    m.disable_site.assert_called_once_with('x')`,
    );
    expect(found.map((d) => d.method)).not.toContain('disable_site');
  });

  it('still asserts on the patched member itself', async () => {
    const found = await configured(
      `from unittest.mock import patch\ndef t():\n    with patch('svc.auth.get_user') as m:\n        pass\n    m.assert_called_once_with('x')`,
    );
    const asserted = found.find((d) => d.assertedArity === 1);
    expect(asserted?.method).toBe('get_user');
  });

  it('still asserts on a member of a spec mock', async () => {
    const found = await configured(
      `from unittest.mock import MagicMock\ndef t():\n    m = MagicMock(spec=Client)\n    m.login.assert_called_once_with('x')`,
    );
    const asserted = found.find((d) => d.assertedArity === 1);
    expect(asserted?.method).toBe('login');
    expect(asserted?.targetSymbol).toBe('Client');
  });
});

describe('decorator-injected parameters', () => {
  // unittest.mock injects after `self`, and a parameter only exists inside its
  // own function. Counting from slot 0 bound the patcher to `self`, and a flat
  // map let `mock_verify` in one test method carry the patcher from another,
  // which named a real method of a real module with total confidence.
  it('skips self when mapping decorators onto parameters', async () => {
    const found = await configured(
      `from unittest.mock import patch\nclass TestIt:\n    @patch.object(Feed, 'count')\n    def test_a(self, mock_count):\n        mock_count.return_value = 'wrong'`,
    );
    const pinned = found.find((d) => d.returnExpr === "'wrong'");
    expect(pinned?.targetSymbol).toBe('Feed');
    expect(pinned?.method).toBe('count');
  });

  it('skips cls on a classmethod test', async () => {
    const found = await configured(
      `from unittest.mock import patch\nclass TestIt:\n    @classmethod\n    @patch.object(Feed, 'count')\n    def test_a(cls, mock_count):\n        mock_count.return_value = 'wrong'`,
    );
    expect(found.find((d) => d.returnExpr === "'wrong'")?.method).toBe('count');
  });

  it('does not let a parameter binding escape its own function', async () => {
    const found = await configured(
      `from unittest.mock import patch\nclass TestIt:\n    @patch.object(Feed, 'count')\n    def test_a(self, mock_it):\n        pass\n\n    def test_b(self, mock_it):\n        mock_it.return_value = 'elsewhere'`,
    );
    expect(found.find((d) => d.returnExpr === "'elsewhere'")).toBeUndefined();
  });
});

describe('python brace literals', () => {
  // `{"a", "b"}` is a set; only `{"a": 1}` is a dict. Reading every brace
  // literal as a dict reported a correct `set[str]` argument as drift.
  async function argCheck(signature: string, call: string) {
    const graph = emptyGraph();
    await indexPythonFile('src/m.py', `${signature}\n    return 0\n`, graph);
    const src = `from unittest.mock import patch\ndef t():\n    with patch('src.m.f') as m:\n        pass\n    m.assert_called_once_with(${call})`;
    const ds = await extractPythonDoubles('tests/test_m.py', src);
    return analyzeDoubles({
      doubles: ds,
      graph,
      fileLines: new Map([['tests/test_m.py', src.split('\n')]]),
      options: { strictness: 'all' },
    });
  }

  it('accepts a set literal for a set parameter', async () => {
    expect(await argCheck('def f(known: set[str]) -> int:', `{"a", "b"}`)).toEqual([]);
  });

  it('accepts a dict literal for a dict parameter', async () => {
    expect(await argCheck('def f(known: dict[str, int]) -> int:', `{"a": 1}`)).toEqual([]);
  });
});
