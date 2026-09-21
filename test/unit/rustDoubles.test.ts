import { describe, expect, it } from 'vitest';
import { extractRustDoubles } from '../../src/extractors/rust/doubles.js';

async function doubles(source: string) {
  return extractRustDoubles('tests/mock.rs', source);
}

describe('mockall usage extraction', () => {
  it('traces a mock variable back to its trait', async () => {
    // Regression: only `#[automock]` declared inside the test file was
    // matched, which checks a trait against itself. Real mockall puts the
    // trait in production code and the test only touches MockFoo.
    const found = await doubles(`
      #[test]
      fn t() {
        let mut m = MockStorage::new();
        m.expect_read().returning(|_| "x".to_string());
      }
    `);
    expect(found).toHaveLength(1);
    expect(found[0]?.targetSymbol).toBe('Storage');
    expect(found[0]?.method).toBe('read');
    expect(found[0]?.language).toBe('rust');
  });

  it('accepts default() as a constructor', async () => {
    const found = await doubles(`
      fn t() {
        let m = MockClock::default();
        m.expect_now().return_const(5u64);
      }
    `);
    expect(found[0]?.targetSymbol).toBe('Clock');
    expect(found[0]?.method).toBe('now');
  });

  it('handles a constructor used inline', async () => {
    const found = await doubles(`
      fn t() {
        MockStorage::new().expect_write().returning(|_, _| true);
      }
    `);
    expect(found[0]?.targetSymbol).toBe('Storage');
    expect(found[0]?.method).toBe('write');
  });

  it('reads arity from with(), one predicate per parameter', async () => {
    const found = await doubles(`
      fn t() {
        let mut m = MockStorage::new();
        m.expect_write().with(eq("a"), eq("b")).times(1).returning(|_, _| true);
      }
    `);
    expect(found[0]?.withArity).toBe(2);
  });

  it('leaves arity unknown without with()', async () => {
    const found = await doubles(`
      fn t() {
        let mut m = MockStorage::new();
        m.expect_write().returning(|_, _| true);
      }
    `);
    expect(found[0]?.withArity).toBeNull();
  });

  it('ignores expectations on something that is not a known mock', async () => {
    const found = await doubles(`
      fn t() {
        let helper = build_helper();
        helper.expect_read().returning(|_| 1);
      }
    `);
    expect(found).toEqual([]);
  });

  it('still records an automock trait declared in the test file', async () => {
    const found = await doubles(`
      #[automock]
      trait Storage {
        fn put(&self, key: &str) -> u32;
      }
    `);
    expect(found.map((d) => d.framework)).toContain('mockall #[automock]');
  });
});

describe('rust test discovery', () => {
  it('treats Cargo test targets as tests', async () => {
    const { isTestFile } = await import('../../src/core/discovery.js');
    expect(isTestFile('tests/storage_mock.rs')).toBe(true);
    expect(isTestFile('benches/bench.rs')).toBe(true);
  });

  it('treats _test.rs and test_ names as tests', async () => {
    const { isTestFile } = await import('../../src/core/discovery.js');
    expect(isTestFile('packages/p/test/fixtures/drift_test.rs')).toBe(true);
    expect(isTestFile('src/test_parser.rs')).toBe(true);
  });

  it('does not treat a singular test/ directory as a Cargo test target', async () => {
    // `test/fixtures/repo.rs` is the trait a fixture is written against.
    // Classifying it as a test kept it out of the symbol graph, and the drift
    // in the file beside it went unreported.
    const { isTestFile } = await import('../../src/core/discovery.js');
    expect(isTestFile('packages/p/test/fixtures/repo.rs')).toBe(false);
    expect(isTestFile('src/lib.rs')).toBe(false);
  });
});

describe('supertraits', () => {
  it('inherits members from a supertrait', async () => {
    const { indexRustFile } = await import('../../src/extractors/rust/index.js');
    const { emptyGraph, resolveType, resolveMember } =
      await import('../../src/core/symbolGraph.js');
    const graph = emptyGraph();
    await indexRustFile(
      'src/traits.rs',
      `pub trait Base { fn add(&self, x: i32) -> usize; }
       pub trait Derived : Base { fn sub(&self, x: i32) -> usize; }`,
      graph,
    );
    const derived = resolveType(graph, 'Derived', { language: 'rust' });
    expect(derived).not.toBeNull();
    expect(derived?.extends).toContain('Base');
    // `add` is inherited, not missing.
    expect(resolveMember(graph, derived!, 'add')).not.toBeNull();
    expect(resolveMember(graph, derived!, 'nope')).toBeNull();
  });

  it('ignores marker traits in the bound list', async () => {
    const { indexRustFile } = await import('../../src/extractors/rust/index.js');
    const { emptyGraph, resolveType } = await import('../../src/core/symbolGraph.js');
    const graph = emptyGraph();
    await indexRustFile(
      'src/traits.rs',
      `pub trait Base { fn add(&self); }
       pub trait Multi: Base + Send + Sync + Clone { fn z(&self); }`,
      graph,
    );
    expect(resolveType(graph, 'Multi', { language: 'rust' })?.extends).toEqual(['Base']);
  });
});

describe('mockall return values', () => {
  it('reads return_const', async () => {
    const found = await doubles(`
      fn t() {
        let mut m = MockRepo::new();
        m.expect_find().return_const(42u32);
      }
    `);
    expect(found[0]?.returnExpr).toBe('42');
  });

  it('reads the body of a returning closure', async () => {
    const found = await doubles(`
      fn t() {
        let mut m = MockRepo::new();
        m.expect_name().returning(|| "x".to_string());
      }
    `);
    expect(found[0]?.returnExpr).toContain('"x"');
  });

  it('strips a numeric type suffix so the literal reads as a number', async () => {
    // `42u64` and `42` are the same value; the suffix made it look nominal.
    const found = await doubles(`
      fn t() {
        let mut m = MockClock::new();
        m.expect_now().return_const(5i64);
      }
    `);
    expect(found[0]?.returnExpr).toBe('5');
  });

  it('leaves the return unknown when nothing configures one', async () => {
    const found = await doubles(`
      fn t() {
        let mut m = MockRepo::new();
        m.expect_find().times(1);
      }
    `);
    expect(found[0]?.returnExpr).toBeNull();
  });
});

describe('mock! blocks', () => {
  it('reads the methods a mock! block declares', async () => {
    // The escape in the regex was doubled, so this matched a literal `\b`
    // and every mock! block came back with no methods at all.
    const found = await doubles(`
      mock! {
        pub Store {
          fn read(&self, key: &str) -> String;
          fn purge(&self) -> bool;
        }
      }
    `);
    const block = found.find((d) => d.framework === 'mockall mock!');
    expect(block?.targetSymbol).toBe('Store');
    expect(block?.methods.map((m) => m.name)).toEqual(['read', 'purge']);
  });

  it('records the block even when the target cannot be read', async () => {
    const found = await doubles('mock! { }');
    expect(found.every((d) => d.methods.length === 0)).toBe(true);
  });
});

describe('a trait redeclared inside the test file', () => {
  // The copy is what mockall generates from, so it can drift from the trait in
  // production while the test still compiles. The members were never listed,
  // because the filter looked for signatures among the trait's direct children
  // rather than inside its declaration list, so every such double carried an
  // empty method set and nothing about it could be checked.
  it('lists the members the redeclared trait declares', async () => {
    const [d] = (
      await doubles(`
      use mockall::automock;
      #[automock]
      trait Clock {
          fn now(&self) -> u64;
          fn gone(&self) -> u32;
      }
    `)
    ).filter((x) => x.framework === 'mockall #[automock]');
    expect(d?.targetSymbol).toBe('Clock');
    expect(d?.methods.map((m) => m.name)).toEqual(['now', 'gone']);
    expect(d?.method).toBe('now');
  });

  it('lists members of a trait that provides a default body', async () => {
    const [d] = (
      await doubles(`
      #[automock]
      trait Clock {
          fn now(&self) -> u64;
          fn zone(&self) -> String { String::new() }
      }
    `)
    ).filter((x) => x.framework === 'mockall #[automock]');
    expect(d?.methods.map((m) => m.name)).toEqual(['now', 'zone']);
  });
});
