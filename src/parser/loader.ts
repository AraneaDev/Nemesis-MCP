// ---------------------------------------------------------------------------
// Tree-sitter loader: web-tree-sitter + per-grammar WASM, lazily cached.
// Grammar files come from @vscode/tree-sitter-wasm (compatible dylink ABI).
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { LanguageId, ScanDiagnostic } from '../core/types.js';

export type { Language as TSLanguage } from 'web-tree-sitter';

export type GrammarName = 'typescript' | 'tsx' | 'javascript' | 'php' | 'python' | 'rust';

const GRAMMAR_FILE: Record<GrammarName, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  php: 'tree-sitter-php.wasm',
  python: 'tree-sitter-python.wasm',
  rust: 'tree-sitter-rust.wasm',
};

/** Language id → the grammar used to parse it. */
export const LANGUAGE_GRAMMAR: Record<LanguageId, GrammarName> = {
  typescript: 'typescript',
  javascript: 'javascript',
  php: 'php',
  python: 'python',
  rust: 'rust',
};

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;

async function ensureInit(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const runtimeWasm = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
      const bytes = await readFile(runtimeWasm);
      await Parser.init({ wasmBinary: bytes });
    })();
  }
  return initPromise;
}

const languageCache = new Map<GrammarName, Language>();

/** Load (and cache) a grammar. Throws on failure; callers decide skip policy. */
export async function loadLanguage(grammar: GrammarName): Promise<Language> {
  const cached = languageCache.get(grammar);
  if (cached) return cached;
  await ensureInit();
  const file = require.resolve(`@vscode/tree-sitter-wasm/wasm/${GRAMMAR_FILE[grammar]}`);
  const bytes = await readFile(file);
  const lang = await Language.load(bytes);
  languageCache.set(grammar, lang);
  return lang;
}

/** Create a parser bound to a cached immutable grammar.
 *
 * Parser instances are deliberately not shared: MCP requests may parse files
 * concurrently and Tree-sitter Parser is mutable/native-backed.
 */
export async function getParser(grammar: GrammarName): Promise<Parser> {
  const lang = await loadLanguage(grammar);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}

export interface ParsedFile {
  source: string;
  root: import('web-tree-sitter').Node;
  lines: string[];
}

/**
 * Where to record that a file did not parse cleanly.
 *
 * A grammar recovers from what it cannot read by standing an error node in its
 * place, so a parse never fails outright: it quietly stops understanding the
 * rest of the file. Without somewhere to say so, a file the scan could not read
 * looks exactly like a file with nothing wrong in it.
 */
export interface ParseReport {
  file: string;
  language?: LanguageId;
  diagnostics: ScanDiagnostic[];
}

/** Line of the first node the grammar could not read, 1-based. */
function firstErrorLine(root: import('web-tree-sitter').Node): number | null {
  let earliest: number | null = null;
  const visit = (node: import('web-tree-sitter').Node): void => {
    if (node.type === 'ERROR' || node.isMissing) {
      const line = node.startPosition.row + 1;
      if (earliest === null || line < earliest) earliest = line;
      // An error node's children are recovered fragments, not further
      // failures, so there is nothing earlier to find inside it.
      return;
    }
    if (!node.hasError) return;
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) visit(child);
    }
  };
  visit(root);
  return earliest;
}

// Two things TypeScript compiles that the bundled grammars, and the upstream
// ones, cannot read:
//
// - `import('./x')` used as a type inside type arguments or an annotation:
//   `importOriginal<typeof import('./x')>()`, the form the Vitest
//   documentation uses, or `Promise<{ items: import('./t').Item[] }>`.
// - A bare `&` in JSX text: `<h2>Orders & Pipeline</h2>`.
//
// On one repository they made 21 of 22 degraded files. Neither costs anything
// that is read (recovery covers both), so all they did was bury the one file
// that really could not be read. To judge a file, the scan reparses a copy
// with these masked out. The copy keeps every line where it was, so a real
// error is reported on its own line. Only the judgement uses the copy: what is
// extracted comes from the source as written.

/** `import('<literal>')`, kept to one line so blanking it leaves one identifier. */
const IMPORT_CALL = /\bimport[ \t]*\([ \t]*(['"`])[^'"`\n]*\1[ \t]*\)/g;

/**
 * Where the grammar rejected a bare `&` in JSX text. It stands an error node
 * that starts at the `&` directly inside the element.
 */
function strayAmpersands(root: import('web-tree-sitter').Node): number[] {
  const at: number[] = [];
  const visit = (node: import('web-tree-sitter').Node): void => {
    if (
      node.type === 'ERROR' &&
      node.parent?.type === 'jsx_element' &&
      node.firstChild?.type === '&'
    ) {
      at.push(node.startIndex);
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child?.hasError) visit(child);
    }
  };
  visit(root);
  return at;
}

/**
 * Line of the first error left once the grammar's known gaps are masked out:
 * `{ line }` when one is left (`line` is null if it has no position), or `null`
 * when the source reads cleanly.
 */
async function firstRealError(
  source: string,
  grammars: GrammarName[],
): Promise<{ line: number | null } | null> {
  const masked = source.replace(IMPORT_CALL, (call) => '_'.repeat(call.length));
  let first: { line: number | null } | undefined;
  for (const grammar of grammars) {
    const parser = await getParser(grammar);
    let text = masked;
    let tree = parser.parse(text);
    // Each pass blanks the `&`s the last one rejected. Recovery can swallow a
    // later `&` into an earlier error, so it may take more than one.
    for (let pass = 0; pass < 8 && tree?.rootNode.hasError; pass++) {
      const at = strayAmpersands(tree.rootNode);
      if (at.length === 0) break;
      const chars = text.split('');
      for (const i of at) chars[i] = ' ';
      text = chars.join('');
      tree.delete();
      tree = parser.parse(text);
    }
    const clean = tree !== null && !tree.rootNode.hasError;
    // The line comes from the first grammar, the one the file is meant for.
    if (!clean && first === undefined)
      first = { line: tree ? firstErrorLine(tree.rootNode) : null };
    tree?.delete();
    parser.delete();
    if (clean) return null;
  }
  return first ?? null;
}

/** Parse source text with the grammar for the given language. */
export async function parseSource(
  language: LanguageId,
  source: string,
  grammar: GrammarName = LANGUAGE_GRAMMAR[language],
  report?: ParseReport,
  fallback?: GrammarName,
): Promise<ParsedFile> {
  const parser = await getParser(grammar);
  let tree = parser.parse(source);
  if (!tree) throw new Error(`Parsing failed for a ${language} file`);
  // A second grammar that reads a superset of the first. The bundled
  // JavaScript grammar rejects a JSX attribute named with a reserved word
  // (`class=`, `for=`, `default=`), which React code in `.js` and `.jsx` has
  // used since long before TypeScript; the TSX grammar reads all three. The
  // retry costs a parse only for a file that already failed.
  if (fallback && tree.rootNode.hasError) {
    const second = (await getParser(fallback)).parse(source);
    if (second && !second.rootNode.hasError) tree = second;
  }
  const error =
    report && tree.rootNode.hasError
      ? await firstRealError(source, fallback ? [grammar, fallback] : [grammar])
      : null;
  if (report && error) {
    report.diagnostics.push({
      file: report.file,
      ...(report.language ? { language: report.language } : {}),
      stage: 'parse',
      ...(error.line !== null ? { line: error.line } : {}),
      // A grammar recovers by standing an error node in place of what it could
      // not read, so the walk still covers everything around it. Saying the
      // rest of the file was lost overstated the damage: across one sweep of
      // 54 repositories it cost 29 doubles out of 102 affected files.
      message: 'Parsed with errors; everything outside the error was still read.',
      degraded: true,
      fatal: false,
    });
  }
  return { source, root: tree.rootNode, lines: source.split('\n') };
}

export interface QueryMatchCaptures {
  [captureName: string]: import('web-tree-sitter').Node;
}

/** Run a compiled query and iterate matches as flat capture maps. */
export function* runQuery(
  language: LanguageId,
  node: import('web-tree-sitter').Node,
  queryString: string,
): Generator<QueryMatchCaptures> {
  const lang = languageCache.get(LANGUAGE_GRAMMAR[language]);
  if (!lang) throw new Error(`Grammar for ${language} not loaded`);
  const query = new Query(lang, queryString);
  const matches = query.matches(node);
  for (const m of matches) {
    const caps: QueryMatchCaptures = {};
    for (const c of m.captures) {
      // keep the first occurrence of each named capture
      if (!(c.name in caps)) caps[c.name] = c.node;
    }
    yield caps;
  }
}

/** A `ParseReport` when there is somewhere to record to, and nothing otherwise. */
export function report(
  file: string,
  language: LanguageId,
  diagnostics: ScanDiagnostic[] | undefined,
): ParseReport | undefined {
  return diagnostics ? { file, language, diagnostics } : undefined;
}
