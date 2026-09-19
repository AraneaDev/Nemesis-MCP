// ---------------------------------------------------------------------------
// Nemesis-MCP core types
// ---------------------------------------------------------------------------

export type LanguageId = 'typescript' | 'javascript' | 'php' | 'python' | 'rust';

export type Strictness = 'all' | 'untyped_only' | 'breaking_only';

export type ViolationType =
  | 'GHOST_METHOD'
  | 'ARITY_MISMATCH'
  | 'RETURN_DRIFT'
  | 'VISIBILITY_BREACH';

export type Confidence = 'definite' | 'warning';

/** A method (or function) symbol extracted from production code. */
export interface MethodSymbol {
  name: string;
  /** Declared return type as written (e.g. `Promise<UserProfile>`, `: int`), if any. */
  returnType: string | null;
  /** Parameters in declaration order. */
  params: ParamSymbol[];
  /** Visibility modifier; defaults to public. */
  visibility: 'public' | 'protected' | 'private';
  /** Line of the declaration (1-based). */
  line: number;
  /** Declared static/abstract/exotic modifiers, used for messaging only. */
  modifiers?: string[];
}

export interface ParamSymbol {
  name: string;
  type: string | null;
  hasDefault: boolean;
  variadic: boolean;
}

/** A production type symbol (class, interface, trait, enum, struct, record…). */
export interface TypeSymbol {
  /** Fully qualified name as written (PHP: `App\Foo`, TS: `Foo`, PY: `module.Foo`). */
  name: string;
  /** File the symbol was declared in. */
  file: string;
  kind:
    | 'class'
    | 'interface'
    | 'trait'
    | 'enum'
    | 'struct'
    | 'record'
    | 'type_alias'
    | 'function'
    | 'module';
  methods: Map<string, MethodSymbol>;
  /** Names of the members we know exist but could not fully extract (dynamic langs). */
  unknownMembers: Set<string>;
  extends: string[];
  implements: string[];
  uses: string[];
  /** Type alias / DTO field map used by the fixtures checker. */
  fields?: Map<string, FieldSymbol>;
  line: number;
}

export interface FieldSymbol {
  name: string;
  type: string | null;
  required: boolean;
}

/** The production symbol graph for a scan. */
export interface SymbolGraph {
  /** Fully qualified (lower-cased for lookup) name → symbol. */
  types: Map<string, TypeSymbol>;
  /** Free functions, lower-cased name → symbol. */
  functions: Map<string, MethodSymbol>;
  /** Languages whose grammars failed to load; reported in the summary. */
  skippedLanguages: LanguageId[];
}

/** A test double found in a test file. */
export interface TestDouble {
  framework: string;
  /** Language of the test file. */
  language: LanguageId;
  file: string;
  line: number;
  /** Production symbol the double imitates, as written in the test. */
  targetSymbol: string | null;
  /** Stubbed/spied method name, when the double targets a single method. */
  method: string | null;
  /** All method names the double configures (PHPUnit `->method()` chains etc.). */
  methods: Array<{ name: string; line: number }>;
  /** Argument count passed to a `with(...)` / `toHaveBeenCalledWith(...)` call. */
  withArity: number | null;
  /** Argument count of the assertion call itself. */
  assertedArity: number | null;
  /** Declared return type of the stub, if the test annotates it. */
  returnTypeHint: string | null;
  /** Source text of the return expression, if any. */
  returnExpr: string | null;
  confidence: Confidence;
}

/** A finding produced by the drift analyzer. */
export interface Finding {
  file: string;
  line: number;
  endLine?: number | undefined;
  type: ViolationType;
  confidence: Confidence;
  double_type: string;
  target: string;
  message: string;
  suggestion?: string | undefined;
}

export interface AuditSummary {
  scanned_test_files: number;
  doubles_inspected: number;
  violations_count: number;
  skipped_languages?: LanguageId[];
}

export interface AuditResult {
  summary: AuditSummary;
  violations: Finding[];
}

export interface AnalyzeOptions {
  strictness: Strictness;
  languages: LanguageId[];
  /** Extra files (from `paths` params) to treat as test roots. */
  testRoots?: string[];
  /** Callback for stderr-style notices (grammar load failures etc.). */
  notice?: (message: string) => void;
}
