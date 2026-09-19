import type { Finding, Strictness } from './types.js';

export function passesStrictness(strictness: Strictness, finding: Finding): boolean {
  if (strictness === 'all') return true;
  if (strictness === 'breaking_only') return finding.confidence === 'definite';
  return finding.evidence === 'untyped';
}

