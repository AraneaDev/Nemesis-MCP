import { describe, expect, it } from 'vitest';
import { exitCodeFor, renderJson, renderText } from '../../src/core/report.js';
import type { AuditResult } from '../../src/core/types.js';

const clean: AuditResult = {
  summary: { scanned_test_files: 1, doubles_inspected: 2, violations_count: 0 },
  violations: [],
};

const broken: AuditResult = {
  summary: {
    scanned_test_files: 1,
    doubles_inspected: 2,
    violations_count: 1,
    skipped_languages: ['rust'],
  },
  violations: [
    {
      file: 'tests/catalog.test.ts',
      line: 4,
      type: 'GHOST_METHOD',
      confidence: 'definite',
      double_type: 'vi.spyOn',
      target: 'CatalogService::findBySKU',
      message: "Method 'findBySKU' does not exist.",
      suggestion: 'findBySku',
    },
  ],
};

describe('report rendering', () => {
  it('renders a clean text report', () => {
    expect(renderText(clean)).toContain('No contract drift detected');
    expect(exitCodeFor(clean, 'breaking_only')).toBe(0);
  });

  it('renders findings, suggestions, and skipped languages', () => {
    const text = renderText(broken);
    expect(text).toContain('Skipped languages (grammar load failed): rust');
    expect(text).toContain('GHOST_METHOD');
    expect(text).toContain('suggestion: findBySku');
    expect(exitCodeFor(broken, 'all')).toBe(1);
    expect(
      renderText({
        ...broken,
        violations: [{ ...broken.violations[0], suggestion: undefined }],
      }),
    ).not.toContain('suggestion:');
  });

  it('renders diagnostics and returns operational status for partial scans', () => {
    const partial: AuditResult = {
      ...clean,
      summary: {
        ...clean.summary,
        diagnostics: [
          {
            stage: 'parse',
            file: 'src/broken.ts',
            message: 'syntax error',
            fatal: false,
          },
        ],
        partial: true,
      },
    };
    expect(renderText(partial)).toContain('Diagnostics: 1 (partial scan)');
    expect(exitCodeFor(partial, 'all')).toBe(2);
    expect(
      exitCodeFor(
        {
          ...partial,
          summary: {
            ...partial.summary,
            diagnostics: [{ ...partial.summary.diagnostics![0], fatal: true }],
          },
        },
        'all',
      ),
    ).toBe(2);
  });

  it('renders stable pretty JSON', () => {
    const parsed = JSON.parse(renderJson(broken)) as AuditResult;
    expect(parsed).toEqual(broken);
  });
});
