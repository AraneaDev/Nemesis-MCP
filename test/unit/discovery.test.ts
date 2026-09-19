import { describe, expect, it } from 'vitest';
import { isTestFile, languageForFile } from '../../src/core/discovery.js';
import { isExcluded } from '../../src/core/ignore.js';

describe('isTestFile', () => {
  it('recognizes TS spec/test files', () => {
    expect(isTestFile('tests/Foo.spec.ts')).toBe(true);
    expect(isTestFile('src/foo.test.ts')).toBe(true);
    expect(isTestFile('src/foo.ts')).toBe(false);
  });

  it('recognizes PHP test class names', () => {
    expect(isTestFile('tests/Unit/BillingTest.php')).toBe(true);
    expect(isTestFile('tests/TestCase.php')).toBe(true);
    expect(isTestFile('src/BillingService.php')).toBe(false);
  });

  it('recognizes python test files', () => {
    expect(isTestFile('tests/test_auth.py')).toBe(true);
    expect(isTestFile('src/auth_test.py')).toBe(true);
    expect(isTestFile('src/services.py')).toBe(false);
  });

  it('rust tests live under tests/', () => {
    expect(isTestFile('tests/storage_mock.rs')).toBe(true);
    expect(isTestFile('src/contracts.rs')).toBe(false);
  });
});

describe('languageForFile', () => {
  it('maps extensions', () => {
    expect(languageForFile('a.ts')).toBe('typescript');
    expect(languageForFile('a.tsx')).toBe('typescript');
    expect(languageForFile('a.js')).toBe('javascript');
    expect(languageForFile('a.php')).toBe('php');
    expect(languageForFile('a.py')).toBe('python');
    expect(languageForFile('a.rs')).toBe('rust');
    expect(languageForFile('a.md')).toBeNull();
  });
});

describe('isExcluded', () => {
  it('excludes always-excluded directories', () => {
    expect(isExcluded('node_modules/pkg/index.js')).toBe(true);
    expect(isExcluded('vendor/bin/app.php')).toBe(true);
    expect(isExcluded('src/index.ts')).toBe(false);
  });

  it('honors extra excludes', () => {
    expect(isExcluded('gen/out.ts', ['gen'])).toBe(true);
    expect(isExcluded('src/gen.ts', ['gen'])).toBe(false);
  });
});
