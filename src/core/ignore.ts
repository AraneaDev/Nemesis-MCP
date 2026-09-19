// ---------------------------------------------------------------------------
// gitignore-lite exclusion rules for repository walks.
// ---------------------------------------------------------------------------

/** Directories always skipped during walks. */
export const ALWAYS_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  '.venv',
  'venv',
  '__pycache__',
  '.idea',
  '.vscode',
  'coverage',
  '.cache',
]);

/** Extra excludes supplied by the user (substring match on path segments). */
export function isExcluded(
  relPath: string,
  extraExcludes: string[] = [],
): boolean {
  const segments = relPath.split('/');
  for (const seg of segments.slice(0, -1)) {
    if (ALWAYS_EXCLUDED_DIRS.has(seg)) return true;
    if (extraExcludes.some((e) => e === seg)) return true;
  }
  const base = segments[segments.length - 1] ?? '';
  if (extraExcludes.some((e) => e === base)) return true;
  return false;
}
