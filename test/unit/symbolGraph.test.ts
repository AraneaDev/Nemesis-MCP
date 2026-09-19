import { describe, expect, it } from 'vitest';
import {
  addFunction,
  addType,
  emptyGraph,
  hasUnresolvedAncestor,
  resolveMember,
  resolveTarget,
  resolveType,
  suggestMember,
  similarity,
} from '../../src/core/symbolGraph.js';
import type { TypeSymbol } from '../../src/core/types.js';

function makeType(name: string, methods: string[] = []): TypeSymbol {
  return {
    name,
    file: 'src/x.ts',
    kind: 'class',
    methods: new Map(
      methods.map((m) => [
        m,
        { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
      ]),
    ),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };
}

describe('symbolGraph', () => {
  it('adds and resolves types case-insensitively', () => {
    const g = emptyGraph();
    const t = makeType('App\\Services\\InvoiceService');
    addType(g, t);
    expect(resolveType(g, 'App\\Services\\InvoiceService')).toBe(t);
    expect(resolveType(g, 'app\\services\\invoiceservice')).toBe(t);
  });

  it('stores functions and resolves short names uniquely', () => {
    const g = emptyGraph();
    const fn = {
      name: 'buildInvoice',
      returnType: null,
      params: [],
      visibility: 'public' as const,
      line: 1,
    };
    addFunction(g, fn);
    expect(g.functions.get('buildinvoice')).toBe(fn);

    const t = makeType('App\\PaymentGateway');
    addType(g, t);
    expect(resolveType(g, 'PaymentGateway')).toBe(t);
  });

  it('resolves local members and missing ancestors', () => {
    const g = emptyGraph();
    const local = makeType('Local', ['run']);
    const child = makeType('Child');
    child.extends.push('Missing');
    addType(g, local);
    addType(g, child);
    expect(resolveMember(g, local, 'run')?.owner).toBe(local);
    expect(resolveMember(g, child, 'run')).toBeNull();
  });

  it('walks implements chains when resolving members', () => {
    const g = emptyGraph();
    const iface = makeType('App\\Contracts\\PaymentGateway', ['chargeToken']);
    const impl = makeType('App\\StripeGateway', []);
    impl.implements.push('App\\Contracts\\PaymentGateway');
    addType(g, iface);
    addType(g, impl);
    const hit = resolveMember(g, impl, 'chargeToken');
    expect(hit).not.toBeNull();
    expect(hit!.owner.name).toBe('App\\Contracts\\PaymentGateway');
    expect(hit!.qualifiedName).toBe('App\\Contracts\\PaymentGateway::chargeToken');
  });

  it('resolves target syntax and missing types', () => {
    const g = emptyGraph();
    const t = makeType('App\\PaymentGateway', ['chargeToken']);
    addType(g, t);
    expect(resolveTarget(g, 'App\\PaymentGateway::chargeToken')?.member?.method.name).toBe(
      'chargeToken',
    );
    expect(resolveTarget(g, 'App.PaymentGateway.chargeToken')?.member).not.toBeNull();
    expect(resolveTarget(g, 'Missing')).toBeNull();
    expect(resolveType(g, '')).toBeNull();

    const ambiguous = emptyGraph();
    addType(ambiguous, makeType('A\\Thing'));
    addType(ambiguous, makeType('B\\Thing'));
    expect(resolveType(ambiguous, 'Thing')).toBeNull();
  });

  it('suggests similar member names', () => {
    const t = makeType('X', ['chargeToken', 'refund']);
    expect(suggestMember(t, 'chargeWithToken')).toBe('chargeToken');
    expect(suggestMember(t, 'refnd')).toBe('refund');
  });

  it('does not suggest for wildly different names', () => {
    const t = makeType('X', ['chargeToken']);
    expect(suggestMember(t, 'zzzzzzzz')).toBeNull();
  });

  it('similarity distance sanity', () => {
    expect(similarity('abc', 'abc')).toBe(0);
    expect(similarity('abc', 'abd')).toBe(1);
    expect(similarity('', 'abc')).toBe(3);
  });
});

describe('same-named types in one repository', () => {
  function typeIn(file: string, name: string, methods: string[]): TypeSymbol {
    return {
      name,
      file,
      kind: 'class',
      methods: new Map(
        methods.map((m) => [
          m,
          { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
        ]),
      ),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: 1,
    };
  }

  it('keeps every variant instead of overwriting', () => {
    // Regression: a multi-language SDK repo declares one `UsageTracker` per
    // language; they all hashed to the same key and the last one added won,
    // so a TypeScript test was checked against the Python class.
    const g = emptyGraph();
    addType(g, typeIn('sdk/python/tracker.py', 'UsageTracker', ['capture_exception']));
    addType(g, typeIn('sdk/php/src/UsageTracker.php', 'UsageTracker', ['captureError']));
    addType(g, typeIn('sdk/node/src/index.ts', 'UsageTracker', ['captureException']));
    expect(g.typeVariants.get('usagetracker')).toHaveLength(3);
  });

  it('resolves to the variant matching the test language', () => {
    const g = emptyGraph();
    addType(g, typeIn('sdk/python/tracker.py', 'UsageTracker', ['capture_exception']));
    addType(g, typeIn('sdk/node/src/index.ts', 'UsageTracker', ['captureException']));

    const ts = resolveType(g, 'UsageTracker', {
      language: 'typescript',
      fromFile: 'sdk/node/tests/handlers.test.ts',
    });
    expect(ts?.file).toBe('sdk/node/src/index.ts');

    const py = resolveType(g, 'UsageTracker', {
      language: 'python',
      fromFile: 'sdk/python/tests/test_tracker.py',
    });
    expect(py?.file).toBe('sdk/python/tracker.py');
  });

  it('treats javascript and typescript as one family', () => {
    const g = emptyGraph();
    addType(g, typeIn('src/Tracker.ts', 'Tracker', ['send']));
    addType(g, typeIn('py/tracker.py', 'Tracker', ['send']));
    const hit = resolveType(g, 'Tracker', {
      language: 'javascript',
      fromFile: 'tests/tracker.test.js',
    });
    expect(hit?.file).toBe('src/Tracker.ts');
  });

  it('never resolves across languages when the family is absent', () => {
    const g = emptyGraph();
    addType(g, typeIn('py/a/tracker.py', 'Tracker', ['send']));
    addType(g, typeIn('py/b/tracker.py', 'Tracker', ['send']));
    expect(
      resolveType(g, 'Tracker', {
        language: 'typescript',
        fromFile: 'src/tracker.test.ts',
      }),
    ).toBeNull();
  });

  it('breaks a same-language tie by directory proximity', () => {
    const g = emptyGraph();
    addType(g, typeIn('fixtures/dogfood-clean/src/catalog.ts', 'CatalogService', ['findBySku']));
    addType(g, typeIn('fixtures/dogfood-repo/src/catalog.ts', 'CatalogService', ['findBySku']));
    const hit = resolveType(g, 'CatalogService', {
      language: 'typescript',
      fromFile: 'fixtures/dogfood-repo/test/catalog.test.ts',
    });
    expect(hit?.file).toBe('fixtures/dogfood-repo/src/catalog.ts');
  });

  it('gives up when proximity cannot break the tie', () => {
    const g = emptyGraph();
    addType(g, typeIn('packages/a/src/Repo.ts', 'Repo', ['find']));
    addType(g, typeIn('packages/b/src/Repo.ts', 'Repo', ['find']));
    expect(
      resolveType(g, 'Repo', { language: 'typescript', fromFile: 'test/x.test.ts' }),
    ).toBeNull();
  });

  it('resolveTarget threads the hint through', () => {
    const g = emptyGraph();
    addType(g, typeIn('sdk/python/tracker.py', 'UsageTracker', ['capture_exception']));
    addType(g, typeIn('sdk/node/src/index.ts', 'UsageTracker', ['captureException']));
    const r = resolveTarget(g, 'UsageTracker.captureException', {
      language: 'typescript',
      fromFile: 'sdk/node/tests/handlers.test.ts',
    });
    expect(r?.member?.method.name).toBe('captureException');
  });
});

describe('python dotted patch targets', () => {
  function pyType(file: string, name: string, methods: string[]): TypeSymbol {
    return {
      name,
      file,
      kind: 'class',
      methods: new Map(
        methods.map((m) => [
          m,
          { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
        ]),
      ),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: 1,
    };
  }

  it('does not resolve a module path to a same-named class', () => {
    // Regression: `patch("usage_tracker.transport.urlopen")` patches a module
    // attribute. The target `usage_tracker.transport` must not land on the
    // class `Transport` and report every import in the module as a ghost.
    const g = emptyGraph();
    addType(g, pyType('usage_tracker/transport.py', 'Transport', ['send']));
    expect(
      resolveType(g, 'usage_tracker.transport', {
        language: 'python',
        fromFile: 'tests/test_transport.py',
      }),
    ).toBeNull();
  });

  it('still resolves a dotted path ending in a class name', () => {
    const g = emptyGraph();
    addType(g, pyType('src/payment.py', 'PaymentClient', ['charge']));
    const hit = resolveType(g, 'src.payment.PaymentClient', {
      language: 'python',
      fromFile: 'tests/test_payment.py',
    });
    expect(hit?.name).toBe('PaymentClient');
  });

  it('leaves a bare class name alone', () => {
    const g = emptyGraph();
    addType(g, pyType('usage_tracker/transport.py', 'Transport', ['send']));
    const hit = resolveType(g, 'Transport', {
      language: 'python',
      fromFile: 'tests/test_transport.py',
    });
    expect(hit?.name).toBe('Transport');
  });

  it('does not apply the rule to PHP namespaces', () => {
    const g = emptyGraph();
    addType(
      g,
      pyType('src/Services/InvoiceService.php', 'App\\Services\\InvoiceService', ['issue']),
    );
    const hit = resolveType(g, 'app\\services\\invoiceservice', {
      language: 'php',
      fromFile: 'tests/InvoiceServiceTest.php',
    });
    expect(hit?.name).toBe('App\\Services\\InvoiceService');
  });
});

describe('language guard for a lone candidate', () => {
  function typed(file: string, name: string): TypeSymbol {
    return {
      name,
      file,
      kind: 'type_alias',
      methods: new Map(),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: 1,
    };
  }

  it('does not resolve across languages even when only one candidate exists', () => {
    // Regression: the filter ran only when two or more candidates shared a
    // name, so a Python test patching `webhooks.is_private_url` resolved
    // against `export type webhooks` in a generated TypeScript API file, and
    // every function in that Python module was reported missing.
    const g = emptyGraph();
    addType(g, typed('frontend/src/types/api.ts', 'webhooks'));
    expect(
      resolveType(g, 'webhooks', {
        language: 'python',
        fromFile: 'backend/tests/test_webhooks.py',
      }),
    ).toBeNull();
  });

  it('still resolves a lone candidate in the right language', () => {
    const g = emptyGraph();
    addType(g, typed('frontend/src/types/api.ts', 'webhooks'));
    expect(
      resolveType(g, 'webhooks', {
        language: 'typescript',
        fromFile: 'frontend/tests/api.test.ts',
      })?.file,
    ).toBe('frontend/src/types/api.ts');
  });

  it('resolves a lone candidate when no language is given', () => {
    const g = emptyGraph();
    addType(g, typed('src/a.ts', 'Thing'));
    expect(resolveType(g, 'Thing')?.name).toBe('Thing');
  });
});

describe('ancestry that runs outside the scanned tree', () => {
  function cls(name: string, methods: string[], ext: string[] = []): TypeSymbol {
    return {
      name,
      file: 'app/Models/' + name.split('\\').pop() + '.php',
      kind: 'class',
      methods: new Map(
        methods.map((m) => [
          m,
          { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
        ]),
      ),
      unknownMembers: new Set(),
      extends: ext,
      implements: [],
      uses: [],
      line: 1,
    };
  }

  it('detects a base class the graph does not contain', () => {
    // A Laravel model extends Illuminate\Database\Eloquent\Model, which lives
    // in vendor/ and is never walked, so `getAttribute` is not missing. It was
    // reported as a definite ghost method.
    const g = emptyGraph();
    const model = cls(
      'App\\Models\\ProviderCredential',
      ['scopeActive'],
      ['Illuminate\\Database\\Eloquent\\Model'],
    );
    addType(g, model);
    expect(hasUnresolvedAncestor(g, model)).toBe(true);
  });

  it('reports a fully known ancestry as complete', () => {
    const g = emptyGraph();
    const base = cls('App\\Base', ['shared']);
    const child = cls('App\\Child', ['own'], ['App\\Base']);
    addType(g, base);
    addType(g, child);
    expect(hasUnresolvedAncestor(g, child)).toBe(false);
  });

  it('reports a type with no ancestry as complete', () => {
    const g = emptyGraph();
    const plain = cls('App\\Plain', ['a']);
    addType(g, plain);
    expect(hasUnresolvedAncestor(g, plain)).toBe(false);
  });

  it('survives a cycle in the ancestry', () => {
    const g = emptyGraph();
    addType(g, cls('App\\A', ['a'], ['App\\B']));
    addType(g, cls('App\\B', ['b'], ['App\\A']));
    const a = resolveType(g, 'App\\A');
    expect(a).not.toBeNull();
    expect(hasUnresolvedAncestor(g, a!)).toBe(false);
  });
});

describe('paths no test reached before', () => {
  function cls(name: string, file: string, methods: string[] = [], ext: string[] = []): TypeSymbol {
    return {
      name,
      file,
      kind: 'class',
      methods: new Map(
        methods.map((m) => [
          m,
          { name: m, returnType: null, params: [], visibility: 'public', line: 1 },
        ]),
      ),
      unknownMembers: new Set(),
      extends: ext,
      implements: [],
      uses: [],
      line: 1,
    };
  }

  it('does not record the same declaration twice', () => {
    // Re-scanning a file must not grow the variant list, or a type would
    // start looking ambiguous against itself.
    const g = emptyGraph();
    addType(g, cls('Svc', 'src/svc.ts', ['a']));
    addType(g, cls('Svc', 'src/svc.ts', ['a']));
    expect(g.typeVariants.get('svc')).toHaveLength(1);
  });

  it('records a genuinely different declaration of the same name', () => {
    const g = emptyGraph();
    addType(g, cls('Svc', 'a/svc.ts'));
    addType(g, cls('Svc', 'b/svc.ts'));
    expect(g.typeVariants.get('svc')).toHaveLength(2);
  });

  it('resolves a bare target name with no method', () => {
    const g = emptyGraph();
    addType(g, cls('Svc', 'src/svc.ts', ['a']));
    const r = resolveTarget(g, 'Svc');
    expect(r?.type.name).toBe('Svc');
    expect(r?.method).toBeNull();
    expect(r?.member).toBeNull();
  });

  it('returns null for a bare target that does not exist', () => {
    expect(resolveTarget(emptyGraph(), 'Nope')).toBeNull();
  });

  describe('did-you-mean suggestions', () => {
    const type = cls('Svc', 'src/svc.ts', ['findBySku', 'removeBySku']);

    it('offers the closest candidate', () => {
      expect(suggestMember(type, 'findBySKU')).toBe('findBySku');
    });

    it('offers nothing when no candidate is close enough', () => {
      expect(suggestMember(type, 'completelyUnrelated')).toBeNull();
    });

    it('offers nothing when the type has no members', () => {
      expect(suggestMember(cls('Empty', 'src/e.ts'), 'anything')).toBeNull();
    });

    it('prefers a later candidate that is closer', () => {
      // Both are within the threshold, so the comparison between them is what
      // decides; without it the first one scanned would always win.
      const t = cls('S', 's.ts', ['loginxy', 'logins']);
      expect(suggestMember(t, 'login')).toBe('logins');
    });

    it('keeps the earlier candidate when a later one is no closer', () => {
      const t = cls('S', 's.ts', ['logins', 'loginxy']);
      expect(suggestMember(t, 'login')).toBe('logins');
    });

    it('allows at least two edits even for a short name', () => {
      // The threshold floor is what makes a short name suggestible at all.
      expect(suggestMember(cls('S', 's.ts', ['run']), 'rn')).toBe('run');
    });
  });

  describe('unresolved ancestry', () => {
    it('follows the chain transitively', () => {
      // A knows B, B extends something the graph has never seen.
      const g = emptyGraph();
      addType(g, cls('A', 'src/a.ts', ['a'], ['B']));
      addType(g, cls('B', 'src/b.ts', ['b'], ['Vendor\\Base']));
      const a = resolveType(g, 'A');
      expect(hasUnresolvedAncestor(g, a!)).toBe(true);
    });

    it('treats a chain deeper than the hop limit as unknowable', () => {
      const g = emptyGraph();
      const depth = 20;
      for (let i = 0; i < depth; i++) {
        addType(g, cls(`T${i}`, `src/t${i}.ts`, ['m'], [`T${i + 1}`]));
      }
      addType(g, cls(`T${depth}`, `src/t${depth}.ts`, ['m']));
      const root = resolveType(g, 'T0');
      expect(hasUnresolvedAncestor(g, root!)).toBe(true);
    });

    it('accepts a chain within the hop limit', () => {
      const g = emptyGraph();
      addType(g, cls('A', 'src/a.ts', ['a'], ['B']));
      addType(g, cls('B', 'src/b.ts', ['b'], ['C']));
      addType(g, cls('C', 'src/c.ts', ['c']));
      expect(hasUnresolvedAncestor(g, resolveType(g, 'A')!)).toBe(false);
    });

    it('does not loop on a type that names itself', () => {
      const g = emptyGraph();
      addType(g, cls('Self', 'src/self.ts', ['m'], ['Self']));
      expect(hasUnresolvedAncestor(g, resolveType(g, 'Self')!)).toBe(false);
    });
  });

  describe('a qualified name behind an unqualified one', () => {
    it('finds the namespaced class when the bare key belongs to another language', () => {
      // `Mailer` as a key holds only the TypeScript class. The PHP one is
      // filed under its namespace, and used to be unreachable: the bare key
      // matched, the language filter emptied it, and the search stopped.
      const g = emptyGraph();
      addType(g, cls('Mailer', 'src/Mailer.ts', ['send']));
      addType(g, cls('App\\Mail\\Mailer', 'src/Mail/Mailer.php', ['send']));
      const found = resolveType(g, 'Mailer', {
        language: 'php',
        fromFile: 'tests/MailerTest.php',
      });
      expect(found?.file).toBe('src/Mail/Mailer.php');
    });

    it('still prefers an exact match in its own language', () => {
      const g = emptyGraph();
      addType(g, cls('Mailer', 'src/Mailer.ts', ['send']));
      addType(g, cls('App.Mail.Mailer', 'src/mail/mailer.ts', ['send']));
      const found = resolveType(g, 'Mailer', {
        language: 'typescript',
        fromFile: 'tests/mailer.test.ts',
      });
      expect(found?.file).toBe('src/Mailer.ts');
    });
  });
});
