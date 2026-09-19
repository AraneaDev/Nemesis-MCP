// ---------------------------------------------------------------------------
// Report rendering (text + JSON) and exit-code mapping.
// ---------------------------------------------------------------------------

import type { AuditResult } from './types.js';

export function renderText(result: AuditResult): string {
  const lines: string[] = [];
  const s = result.summary;
  lines.push(
    `Scanned ${s.scanned_test_files} test file(s), inspected ${s.doubles_inspected} double(s).`,
  );
  if (s.skipped_languages?.length) {
    lines.push(`Skipped languages (grammar load failed): ${s.skipped_languages.join(', ')}`);
  }
  if (s.diagnostics?.length) {
    lines.push(`Diagnostics: ${s.diagnostics.length} (partial scan)`);
  }
  if (result.violations.length === 0) {
    lines.push('No contract drift detected. ✓');
    return lines.join('\n');
  }
  lines.push(`Violations: ${result.violations.length}`);
  lines.push('');
  for (const v of result.violations) {
    lines.push(`${v.file}:${v.line}  [${v.type}]  ${v.confidence}`);
    lines.push(`  double: ${v.double_type} → ${v.target}`);
    lines.push(`  ${v.message}`);
    if (v.suggestion) lines.push(`  suggestion: ${v.suggestion}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

export function renderJson(result: AuditResult): string {
  return JSON.stringify(result, null, 2);
}

/** CLI exit code per spec §8. */
export function exitCodeFor(result: AuditResult, _strictness: string): number {
  if (result.summary.diagnostics?.some((diagnostic) => diagnostic.fatal)) return 2;
  if (result.summary.diagnostics?.length) return 2;
  return result.violations.length > 0 ? 1 : 0;
}
