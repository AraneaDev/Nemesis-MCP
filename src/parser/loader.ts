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

/** Parse source text with the grammar for the given language. */
export async function parseSource(
  language: LanguageId,
  source: string,
  grammar: GrammarName = LANGUAGE_GRAMMAR[language],
  report?: ParseReport,
): Promise<ParsedFile> {
  const parser = await getParser(grammar);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Parsing failed for a ${language} file`);
  if (report && tree.rootNode.hasError) {
    report.diagnostics.push({
      file: report.file,
      ...(report.language ? { language: report.language } : {}),
      stage: 'parse',
      message: 'Parsed with errors; the rest of the file was not read.',
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
