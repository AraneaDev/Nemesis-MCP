// ---------------------------------------------------------------------------
// Tree-sitter loader: web-tree-sitter + per-grammar WASM, lazily cached.
// Grammar files come from @vscode/tree-sitter-wasm (compatible dylink ABI).
// ---------------------------------------------------------------------------

import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, Query } from 'web-tree-sitter';
import type { LanguageId } from '../core/types.js';

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

const parserCache = new Map<GrammarName, Parser>();

/** A parser bound to a grammar. Reused across files. */
export async function getParser(grammar: GrammarName): Promise<Parser> {
  let p = parserCache.get(grammar);
  if (!p) {
    const lang = await loadLanguage(grammar); // ensures Parser.init() completed
    p = new Parser();
    p.setLanguage(lang);
    parserCache.set(grammar, p);
  }
  return p;
}

export interface ParsedFile {
  source: string;
  root: import('web-tree-sitter').Node;
  lines: string[];
}

/** Parse source text with the grammar for the given language. */
export async function parseSource(
  language: LanguageId,
  source: string,
): Promise<ParsedFile> {
  const parser = await getParser(LANGUAGE_GRAMMAR[language]);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`Parsing failed for a ${language} file`);
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
