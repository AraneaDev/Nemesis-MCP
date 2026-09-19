// ---------------------------------------------------------------------------
// Finding the module a double names, by import specifier or by dotted path.
// ---------------------------------------------------------------------------

import path from 'node:path';
import type { SymbolGraph, TypeSymbol } from './types.js';

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

/** Repository-relative paths a relative specifier could mean. */
function specifierCandidates(fromFile: string, specifier: string): string[] {
  const base = path.posix.normalize(
    path.posix.join(path.posix.dirname(fromFile.split(path.sep).join('/')), specifier),
  );
  const stripped = base.replace(/\.(m|c)?js$/, ''); // ESM TypeScript writes .js
  const out: string[] = [];
  for (const stem of new Set([base, stripped])) {
    out.push(stem);
    for (const extension of EXTENSIONS) out.push(stem + extension);
    for (const extension of EXTENSIONS) out.push(`${stem}/index${extension}`);
  }
  return out;
}

/**
 * The module a target names, or null.
 *
 * A relative specifier is resolved against the importing file. A dotted path
 * becomes a path fragment and is matched against the tail of every scanned
 * file's path: exactly one match is the answer, and zero or more than one is
 * silence. There is no ranking, because a rule that picks a winner among
 * several is a rule that guesses.
 */
export function resolveModule(
  graph: SymbolGraph,
  target: string,
  fromFile: string,
): TypeSymbol | null {
  if (!target) return null;

  if (target.startsWith('.')) {
    for (const candidate of specifierCandidates(fromFile, target)) {
      const hit = graph.modules.get(candidate);
      if (hit) return hit;
    }
    return null;
  }

  if (!target.includes('.') || /[/\\]/.test(target)) return null;

  // `core.system.subprocess_runner` -> `core/system/subprocess_runner`
  const fragment = target.split('.').filter(Boolean).join('/');
  if (!fragment) return null;

  let found: TypeSymbol | null = null;
  for (const [file, module] of graph.modules) {
    const withoutExtension = file.replace(/\.[^./]+$/, '');
    if (withoutExtension !== fragment && !withoutExtension.endsWith(`/${fragment}`)) continue;
    if (found) return null; // ambiguous
    found = module;
  }
  return found;
}
