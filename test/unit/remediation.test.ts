import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { runAudit } from '../../src/core/runtime.js';
import { emptyGraph, resolveType } from '../../src/core/symbolGraph.js';
import { indexRustFile } from '../../src/extractors/rust/index.js';
import { extractPythonDoubles } from '../../src/extractors/python/doubles.js';
import { filterFixtureFindings } from '../../src/fixtures/staleFixtures.js';
import type { Finding } from '../../src/core/types.js';

const root = path.resolve(import.meta.dirname, '..', '..');

describe('remediation regressions', () => {
  it('restricts production indexing to a requested audit path', async () => {
    const result = await runAudit({
      rootDir: root,
      paths: ['fixtures/dogfood-clean'],
      languages: ['typescript', 'javascript', 'php', 'python', 'rust'],
      strictness: 'all',
    });
    expect(result.summary.scanned_test_files).toBe(1);
    expect(result.violations).toEqual([]);
  }, 120_000);

  it('indexes methods from Rust impl blocks', async () => {
    const graph = emptyGraph();
    await indexRustFile('src/service.rs', 'struct Service; impl Service { pub fn run(&self, x: u32) -> bool { true } }', graph);
    const service = resolveType(graph, 'Service');
    expect(service?.methods.get('run')?.params).toHaveLength(1);
    expect(service?.methods.get('run')?.returnType).toBe('bool');
  });

  it('extracts configured methods from Python spec mocks', async () => {
    const doubles = await extractPythonDoubles('tests/test_service.py', `
from unittest.mock import Mock
mock = Mock(spec=Service)
mock.fetch.return_value = None
`);
    expect(doubles.some((double) => double.targetSymbol === 'Service' && double.method === 'fetch')).toBe(true);
  });

  it('filters fixture strictness by explicit evidence', () => {
    const findings: Finding[] = [
      {
        file: 'fixture.json', line: 1, type: 'GHOST_METHOD', confidence: 'warning',
        evidence: 'heuristic', double_type: 'stale_fixture', target: 'User.name', message: 'heuristic',
      },
      {
        file: 'fixture.json', line: 1, type: 'RETURN_DRIFT', confidence: 'warning',
        evidence: 'untyped', double_type: 'stale_fixture', target: 'User.username', message: 'untyped',
      },
    ];
    expect(filterFixtureFindings(findings, 'untyped_only')).toHaveLength(1);
    expect(filterFixtureFindings(findings, 'breaking_only')).toHaveLength(0);
  });
});
