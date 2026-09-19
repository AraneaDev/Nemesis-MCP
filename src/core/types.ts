// ---------------------------------------------------------------------------
// Nemesis-MCP core types
// ---------------------------------------------------------------------------

export type LanguageId = 'typescript' | 'javascript' | 'php' | 'python' | 'rust';

export type Strictness = 'all' | 'untyped_only' | 'breaking_only';

export type ViolationType =
  'GHOST_METHOD' | 'ARITY_MISMATCH' | 'RETURN_DRIFT' | 'VISIBILITY_BREACH';

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
  /** Declarations modifiers on the type itself, such as `final` or `abstract`. */
  modifiers?: string[];
  /** Type alias / DTO field map used by the fixtures checker. */
  fields?: Map<string, FieldSymbol>;
  line: number;
}

export interface FieldSymbol {
  name: string;
  type: string | null;
  required: boolean;
  /** Literal value, for an enum case with a backing value. */
  value?: string;
}

/** The production symbol graph for a scan. */
export interface SymbolGraph {
  /** Fully qualified (lower-cased for lookup) name → symbol. */
  types: Map<string, TypeSymbol>;
  /** Every symbol sharing a lookup key, so same-named types never overwrite. */
  typeVariants: Map<string, TypeSymbol[]>;
  /** Free functions, lower-cased name → symbol. */
  functions: Map<string, MethodSymbol>;
  /**
   * Names each scanned TypeScript or JavaScript file exports. A file that
   * re-exports with `export *` maps to null: its export list is not knowable
   * from that file alone, so nothing is reported about it.
   */
  exportsByFile: Map<string, Set<string> | null>;
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
  /** Source text of those arguments, when they were captured. */
  withArgs?: string[];
  /** Argument count of the assertion call itself. */
  assertedArity: number | null;
  /** Declared return type of the stub, if the test annotates it. */
  returnTypeHint: string | null;
  /** Source text of the return expression, if any. */
  returnExpr: string | null;
  /**
   * A module double (`vi.mock('../src/api', factory)`): the specifier it
   * replaces. `methods` then holds the keys the factory supplies rather than
   * members of a class.
   */
  moduleSpecifier?: string;
  /** The stub supplies a resolved value, so it believes the method is async. */
  resolvedReturn?: boolean;
  /**
   * Parameters declared by a replacement function (`mockImplementation`,
   * `side_effect`). Unlike an asserted call, this is what the test believes
   * the signature to be rather than what it passes.
   */
  fakeArity?: number | null;
  /** Types those parameters declare, positionally; null where unannotated. */
  fakeParamTypes?: (string | null)[];
  /**
   * True when the spy was pointed at the class itself, false when it was
   * pointed at an instance. Undefined where the receiver says neither.
   */
  staticReceiver?: boolean;
  /** The stub is configured to return the mock itself (`willReturnSelf`). */
  returnsSelf?: boolean;
  /** `vi.spyOn(obj, 'x', 'get')`: the accessor the spy replaces, if given. */
  accessType?: string;
  confidence: Confidence;
}

/** A finding produced by the drift analyzer. */
export type FindingEvidence = 'typed' | 'untyped' | 'heuristic';

export interface Finding {
  file: string;
  line: number;
  endLine?: number | undefined;
  type: ViolationType;
  confidence: Confidence;
  /** Evidence category used by strictness filtering. */
  evidence?: FindingEvidence;
  double_type: string;
  target: string;
  message: string;
  suggestion?: string | undefined;
}

export interface ScanDiagnostic {
  file?: string;
  language?: LanguageId;
  stage: 'discovery' | 'read' | 'parse' | 'index' | 'extract' | 'fixture' | 'budget';
  message: string;
  fatal: boolean;
}

export interface AuditSummary {
  scanned_test_files: number;
  doubles_inspected: number;
  violations_count: number;
  doubles_checked?: number;
  doubles_unresolved?: number;
  doubles_unknowable?: number;
  skipped_languages?: LanguageId[];
  diagnostics?: ScanDiagnostic[];
  partial?: boolean;
}

export interface AuditResult {
  summary: AuditSummary;
  violations: Finding[];
}

export interface AnalyzeOptions {
  strictness: Strictness;
  languages: LanguageId[];
  /** Callback for stderr-style notices (grammar load failures etc.). */
  notice?: (message: string) => void;
}

/**
 * What the analyzer actually reached, counted per double.
 *
 * `doubles_inspected` used to be the only number in the summary, and it
 * counts doubles found rather than doubles compared. On one repository in
 * the corpus it read 4,772 when 47 had been compared against anything.
 */
export interface AnalyzeStats {
  /** Target resolved and at least one member was looked up. */
  checked: number;
  /** Target named something this scan could not find. */
  unresolved: number;
  /** A built-in or a package: there is no contract to check, and never was. */
  unknowable: number;
  /** The extractor found a double but could not name what it stands for. */
  noTarget: number;
}
