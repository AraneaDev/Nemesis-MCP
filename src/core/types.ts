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
  /**
   * Module only. Names the file binds from elsewhere, and where they came
   * from. Python's convention is to patch a name where it is used rather than
   * where it is defined, so an imported name is a member of the importing
   * module as much as a defined one is.
   */
  imports?: Map<string, { from: string; name: string }>;
  /**
   * Module only (TypeScript/JavaScript). The type a bare `export default
   * <identifier>` or `export default new <Ctor>()` names, when the default
   * export's shape is decidable statically. A default IMPORT binds this,
   * not the module: `import x from './svc'` means whatever the module
   * default-exports, which is usually a class instance and never the
   * module's own top-level members. Left unset when the default export is
   * anything this scan cannot follow to a declared type: a call, a
   * conditional, an object literal, an anonymous class, and so on.
   */
  defaultExportType?: string;
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
  /**
   * One symbol per scanned production file, keyed by repo-relative path.
   * Kept out of `types` and `typeVariants` deliberately: the short-name
   * fallback there splits on `.`, so a module named `src/db.ts` would register
   * under `ts` and collide with every other module in the repository.
   */
  modules: Map<string, TypeSymbol>;
  /** Languages whose grammars failed to load; reported in the summary. */
  skippedLanguages: LanguageId[];
  /**
   * TypeScript `paths` aliases read from every `tsconfig.json` in the
   * repository, once per scan. Empty when none were found or none parsed.
   */
  tsPathAliases: TsPathAlias[];
}

/**
 * One resolved `paths` entry from a `tsconfig.json`, scoped to the directory
 * that declared it. `prefix`/`suffix` are the pattern split on its `*`
 * (`suffix` is `''` for a pattern with no wildcard); `targets` are the
 * repo-relative destination patterns, still carrying `*`, already resolved
 * against that tsconfig's own directory and `baseUrl`. `exact` is true for a
 * key with no `*` at all (`"@app/special": [...]`) as opposed to one whose
 * wildcard just happens to leave `suffix` empty (`"@app/*": [...]`) — the two
 * need different matching rules: an exact key matches only the whole
 * specifier, a wildcard key matches a prefix/suffix pair against any middle.
 */
export interface TsPathAlias {
  configDir: string;
  prefix: string;
  suffix: string;
  exact: boolean;
  targets: string[];
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
  /**
   * Set when `targetSymbol` was reached through the module binding map
   * (`import axios from 'axios'`, `import * as db from './db'`,
   * `const db = require('./db')`) rather than taken at face value from an
   * unrecognised identifier. An untracked identifier stays indistinguishable
   * from a local fake, so only a real binding earns the "unknowable"
   * classification for a non-relative specifier.
   *
   * The two kinds resolve differently. `'namespace'` (a namespace import or
   * `require`) names the module itself, so `targetSymbol` is compared
   * against the module's own top-level members. `'default'` (a default
   * import) names the module's default EXPORT instead, which is usually a
   * class instance and never a top-level member of the module; resolving it
   * requires following that export to its own type.
   */
  moduleBinding?: 'namespace' | 'default';
  /**
   * True for the per-key double a `vi.mock` factory value produces, as
   * distinct from the module-shape double the same `vi.mock` call also
   * produces. A factory-value double is a second view of a key the
   * module-shape double already accounts for, not a second user-written
   * double, so it must not be counted in the statistics.
   *
   * It is also why the same missing key was once reported twice, once against
   * the specifier and once against the resolved file. The member path in the
   * analyzer now leaves the existence question to the module-shape double and
   * keeps only the checks a factory value earns on its own: arity, parameter
   * types and return type.
   */
  fromFactory?: true;
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
  doubles_untargeted?: number;
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
  /**
   * The analyzer had something to say about this double. That means its target
   * resolved, or the name was one the scan watched leave a module it read.
   *
   * Not "a member was looked up": a double that resolves while naming no
   * members counts too. Nothing was compared, but the contract was in hand and
   * the double asked nothing of it.
   */
  checked: number;
  /** Target named something this scan could not find. */
  unresolved: number;
  /** A built-in or a package: there is no contract to check, and never was. */
  unknowable: number;
  /** The extractor found a double but could not name what it stands for. */
  noTarget: number;
}
