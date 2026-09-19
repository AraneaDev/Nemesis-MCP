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
