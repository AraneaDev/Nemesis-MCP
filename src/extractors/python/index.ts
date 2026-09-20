// ---------------------------------------------------------------------------
// Python production indexer (classes, methods, functions).
// ---------------------------------------------------------------------------

import type {
  FieldSymbol,
  MethodSymbol,
  ParamSymbol,
  SymbolGraph,
  TypeSymbol,
} from '../../core/types.js';
import { addType, addFunction, addModule } from '../../core/symbolGraph.js';
import { parseSource } from '../../parser/loader.js';
import { walk, field, typeTextOf } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

function paramsOf(node: SyntaxNode): ParamSymbol[] {
  const params: ParamSymbol[] = [];
  const paramList = field(node, 'parameters');
  if (!paramList) return params;
  for (const p of paramList.namedChildren) {
    if (p.type === 'identifier') {
      params.push({
        name: p.text.split(/[:=]/)[0]?.trim() ?? p.text,
        type: null,
        hasDefault: false,
        variadic: false,
      });
    } else if (
      p.type === 'default_parameter' ||
      p.type === 'typed_parameter' ||
      p.type === 'typed_default_parameter'
    ) {
      // `typed_parameter` exposes no `name` field, so the annotation used to
      // end up inside the parameter name.
      const nameNode = field(p, 'name') ?? p.namedChildren.find((c) => c.type === 'identifier');
      const name = nameNode?.text.split(/[:=]/)[0]?.trim() ?? p.text;
      params.push({
        name,
        type: typeTextOf(p, 'type'),
        hasDefault: p.type === 'default_parameter' || p.type === 'typed_default_parameter',
        variadic: false,
      });
    } else if (p.type === 'list_splat_pattern') {
      params.push({ name: p.text, type: null, hasDefault: false, variadic: true });
    } else if (p.type === 'dictionary_splat_pattern') {
      params.push({ name: p.text, type: null, hasDefault: false, variadic: true });
    }
  }
  return params;
}

/**
 * `self` and `cls` are bound by the call, not passed by the caller, so a
 * method declared `def login(self, username)` takes one argument. Counting the
 * receiver inverted every Python arity check: a correct two-argument
 * assertion was reported as needing three, while a genuinely wrong
 * three-argument one fitted inside the inflated maximum and passed.
 */
function dropReceiver(params: ParamSymbol[], isMethod: boolean): ParamSymbol[] {
  if (!isMethod) return params;
  const first = params[0];
  if (first && !first.variadic && /^(self|cls|mcs)$/.test(first.name)) {
    return params.slice(1);
  }
  return params;
}

function fnFromNode(node: SyntaxNode, isMethod = false): MethodSymbol | null {
  const name = field(node, 'name')?.text;
  if (!name) return null;
  return {
    name,
    returnType: typeTextOf(node, 'return_type'),
    params: dropReceiver(paramsOf(node), isMethod),
    visibility: node.children.some((c) => !c.isNamed && c.text === 'async') ? 'public' : 'public',
    line: node.startPosition.row + 1,
  };
}

function fieldsOfClassBody(body: SyntaxNode | null): Map<string, FieldSymbol> | null {
  if (!body) return null;
  const fields = new Map<string, FieldSymbol>();
  for (const child of body.namedChildren) {
    const text = child.text.trim();
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=]+))?\s*(?:=\s*.+)?$/.exec(text);
    if (!match || /^(def|async|return|if|for|while|with|raise|pass)(?:\s|$)/.test(text)) continue;
    const name = match[1];
    const type = match[2]?.trim() ?? null;
    if (!name || (!type && !text.includes('='))) continue;
    fields.set(name, { name, type, required: !text.includes('=') });
  }
  return fields.size > 0 ? fields : null;
}

/** Python visibility: leading underscores. */
export function pyVisibility(name: string): 'public' | 'protected' | 'private' {
  if (name.startsWith('__') && !name.endsWith('__')) return 'private';
  if (name.startsWith('_')) return 'protected';
  return 'public';
}

/** `core/webhook/manager.py` + `.formatters` -> `core.webhook.formatters`. */
function absolutizeRelative(relFile: string, dots: number, tail: string): string {
  const parts = relFile.replace(/\.py$/, '').split('/');
  parts.pop(); // the module's own name
  const base = parts.slice(0, parts.length - (dots - 1));
  return [...base, ...(tail ? tail.split('.') : [])].filter(Boolean).join('.');
}

/**
 * Plain identifiers bound by an assignment target, recursively unwrapping
 * tuple/list patterns (`x, y = f()`, `(x, [y, z]) = f()`). A target that is
 * not a plain identifier — a `subscript` (`arr[0] = ...`) or an `attribute`
 * (`obj.attr = ...`) — binds no module-level name, so it contributes nothing.
 */
function identifiersInTarget(node: SyntaxNode): string[] {
  if (node.type === 'identifier') return [node.text];
  if (
    node.type === 'pattern_list' ||
    node.type === 'tuple_pattern' ||
    node.type === 'list_pattern'
  ) {
    return node.namedChildren.flatMap(identifiersInTarget);
  }
  return [];
}

/**
 * A module rewriting its own namespace at import time: `setattr` against this
 * module object, or an assignment through `globals()`.
 *
 * `setattr` against anything else, a class or an instance, says nothing about
 * what the module binds.
 */
const MODULE_SELF_MUTATION =
  /\bsetattr\s*\(\s*(?:sys\s*\.\s*modules\s*\[|globals\s*\(\s*\)|__import__\s*\(|module\b)|\bglobals\s*\(\s*\)\s*\[/;

/**
 * Statements that can hold a module-level definition without opening a scope of
 * their own, so a `def` inside one is still a module attribute.
 *
 * `function_definition` and `class_definition` are deliberately absent: both do
 * open a scope, and neither is descended into.
 */
const SCOPE_PRESERVING = new Set([
  'block',
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'for_statement',
  'while_statement',
  'match_statement',
  'case_clause',
]);

/**
 * Record every name a scope-preserving block binds, at any depth reachable
 * without crossing into a function or a class.
 *
 * Names land in `unknownMembers` rather than in `methods`: a conditional
 * definition may be one of several competing branches, so which signature
 * survives at import time cannot be read off the source. The name exists, its
 * signature does not, which is how a decorated definition is treated too.
 */
function collectBlockBindings(node: SyntaxNode, sym: TypeSymbol): void {
  for (const child of node.namedChildren) {
    if (child.type === 'function_definition' || child.type === 'class_definition') {
      const name = field(child, 'name')?.text;
      if (name) {
        sym.unknownMembers.add(name);
        // PEP 562, as at the top level: a module with __getattr__ answers to
        // any name, whether or not the guard around it is taken.
        if (name === '__getattr__') sym.unknownMembers.add('*');
      }
      continue;
    }

    if (child.type === 'decorated_definition') {
      const inner = child.namedChildren.find(
        (c) => c.type === 'function_definition' || c.type === 'class_definition',
      );
      const name = inner ? field(inner, 'name')?.text : undefined;
      if (name) {
        sym.unknownMembers.add(name);
        if (name === '__getattr__') sym.unknownMembers.add('*');
      }
      continue;
    }

    if (child.type === 'expression_statement') {
      const assign = child.namedChildren[0];
      if (assign && (assign.type === 'assignment' || assign.type === 'augmented_assignment')) {
        const left = field(assign, 'left');
        if (left) {
          for (const name of identifiersInTarget(left)) sym.unknownMembers.add(name);
        }
      }
      continue;
    }

    if (SCOPE_PRESERVING.has(child.type)) collectBlockBindings(child, sym);
  }
}

/**
 * The module symbol for a Python file: what it defines at the top level, and
 * what it binds from elsewhere.
 *
 * The second half is what makes this useful. Python's convention is to patch a
 * name where it is used, so `patch("core.webhook.manager.get_db")` names an
 * attribute that `manager.py` imports rather than defines. Indexing only
 * definitions would report thousands of those as missing.
 */
function moduleSymbolFor(relFile: string, root: SyntaxNode): TypeSymbol {
  const sym: TypeSymbol = {
    name: relFile,
    file: relFile,
    kind: 'module',
    methods: new Map(),
    imports: new Map(),
    // Builtins are exempted at lookup time (see `PYTHON_BUILTINS`), not
    // seeded here: this set is what the module itself actually binds.
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };

  const bind = (alias: string, from: string, name: string): void => {
    sym.imports!.set(alias, { from, name });
    // Also unknown: a source outside the scan must never become a ghost.
    sym.unknownMembers.add(alias);
  };

  for (const child of root.namedChildren) {
    if (child.type === 'function_definition') {
      const fn = fnFromNode(child);
      if (!fn) continue;
      // PEP 562: a module with __getattr__ answers to any name.
      if (fn.name === '__getattr__') sym.unknownMembers.add('*');
      sym.methods.set(fn.name, fn);
      continue;
    }

    if (child.type === 'decorated_definition') {
      // A decorator can change what calling the name does — `@contextmanager`
      // turns a generator function into a context manager, so the declared
      // signature describes the undecorated function, not the thing a test
      // patches. The name exists as a module member; its signature does not.
      const inner = child.namedChildren.find(
        (c) => c.type === 'function_definition' || c.type === 'class_definition',
      );
      const name = inner ? field(inner, 'name')?.text : undefined;
      if (name) {
        sym.unknownMembers.add(name);
        if (name === '__getattr__') sym.unknownMembers.add('*');
      }
      continue;
    }

    if (child.type === 'class_definition') {
      // The class itself is resolved by name elsewhere; here it only needs
      // to exist as a module member so `patch("module.ClassName")` resolves.
      const name = field(child, 'name')?.text;
      if (name) sym.unknownMembers.add(name);
      continue;
    }

    if (child.type === 'expression_statement') {
      const assign = child.namedChildren[0];
      if (assign && (assign.type === 'assignment' || assign.type === 'augmented_assignment')) {
        const left = field(assign, 'left');
        if (left) {
          for (const name of identifiersInTarget(left)) sym.unknownMembers.add(name);
        }
      }
    }
  }

  // A version guard, an import fallback or a feature flag puts an ordinary
  // definition one level down, and the loop above reads only the top level. A
  // name left bound by nothing becomes a ghost, so the same reasoning the
  // import walk below is built on applies here: descend, and accept that a
  // definition the interpreter may never execute is counted as present. That
  // direction costs a missed finding rather than a wrong one.
  for (const child of root.namedChildren) {
    if (SCOPE_PRESERVING.has(child.type)) collectBlockBindings(child, sym);
  }

  // `setattr(sys.modules[__name__], ...)` and `globals()[x] = y` put names in
  // the module that nothing here mentions.
  //
  // The target is what decides this. `setattr(SomeClass, "x", 1)` mutates that
  // class, not the module, and reading any `setattr(` at all as a module
  // mutation silenced every question about the file, including the ones it
  // could have answered.
  //
  // Asked of the whole file rather than of each top-level statement. The loop
  // above returns early for a function, a decorated function and a class, so a
  // statement-by-statement test never saw a mutation written inside a
  // top-level helper, which is the ordinary way it is written. That left a
  // definite ghost finding on a name the module really does gain at import
  // time.
  if (MODULE_SELF_MUTATION.test(root.text)) {
    sym.unknownMembers.add('*');
  }

  // Imports are walked rather than read off the top level, because
  // `try: import x except ImportError:` and `if TYPE_CHECKING:` are ordinary
  // and both bury the statement one level down. Reading only the top level
  // would leave those names bound by nothing, and a bound name that this does
  // not know about becomes a ghost.
  //
  // An import inside a function body is not a module attribute, so this is
  // over-inclusive. That direction costs a missed finding rather than a wrong
  // one, which is the trade this tool makes everywhere else.
  for (const { node: child } of walk(root)) {
    if (child.type === 'import_statement') {
      for (const spec of child.namedChildren) {
        if (spec.type === 'aliased_import') {
          const alias = field(spec, 'alias')?.text;
          const name = field(spec, 'name')?.text ?? '';
          if (alias) bind(alias, name, name.split('.').pop() ?? name);
        } else if (spec.type === 'dotted_name') {
          // `import os.path` binds `os`.
          const head = spec.text.split('.')[0];
          if (head) bind(head, head, head);
        }
      }
      continue;
    }

    if (child.type === 'import_from_statement') {
      const source = child.namedChildren[0];
      if (!source) continue;
      let from = source.text;
      if (source.type === 'relative_import') {
        const dots = (/^\.+/.exec(source.text)?.[0] ?? '.').length;
        from = absolutizeRelative(relFile, dots, source.text.replace(/^\.+/, ''));
      }
      for (const spec of child.namedChildren.slice(1)) {
        if (spec.type === 'wildcard_import') {
          sym.unknownMembers.add('*');
        } else if (spec.type === 'aliased_import') {
          const alias = field(spec, 'alias')?.text;
          const name = field(spec, 'name')?.text ?? '';
          if (alias) bind(alias, from, name);
        } else if (spec.type === 'dotted_name') {
          bind(spec.text, from, spec.text);
        }
      }
      continue;
    }
  }

  return sym;
}

export async function indexPythonFile(
  relFile: string,
  source: string,
  graph: SymbolGraph,
): Promise<void> {
  const parsed = await parseSource('python', source);
  const { root } = parsed;

  for (const { node } of walk(root)) {
    if (node.type === 'class_definition') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name,
        file: relFile,
        kind: 'class',
        methods: new Map(),
        unknownMembers: new Set(['__getattr__']),
        ...(fieldsOfClassBody(field(node, 'body'))
          ? { fields: fieldsOfClassBody(field(node, 'body'))! }
          : {}),
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      };
      const body = field(node, 'body');
      if (body) {
        for (const n of body.namedChildren) {
          if (n.type === 'function_definition' || n.type === 'decorated_definition') {
            const fnNode =
              n.type === 'decorated_definition'
                ? n.namedChildren.find((c) => c.type === 'function_definition')
                : n;
            // A @staticmethod takes no receiver, so nothing is dropped there.
            const isStatic =
              n.type === 'decorated_definition' &&
              n.namedChildren.some(
                (c) => c.type === 'decorator' && /\bstaticmethod\b/.test(c.text),
              );
            // `@property` makes the member an attribute, not a callable, so
            // patching it the ordinary way replaces the descriptor with a Mock
            // and the property stops behaving like one.
            const decorators =
              n.type === 'decorated_definition'
                ? n.namedChildren.filter((c) => c.type === 'decorator').map((c) => c.text)
                : [];
            const accessor = decorators.some((t) => /^@\s*property\b/.test(t.trim()))
              ? 'get'
              : decorators.some((t) => /\.setter\b/.test(t))
                ? 'set'
                : null;
            const m = fnNode ? fnFromNode(fnNode, !isStatic) : null;
            if (m) {
              m.visibility = pyVisibility(m.name);
              if (accessor) m.modifiers = [...(m.modifiers ?? []), accessor];
              const existing = sym.methods.get(m.name);
              // A getter describes what reading the member yields, which is
              // what a patch replaces, so it wins over its setter.
              if (existing?.modifiers?.includes('get') && accessor === 'set') continue;
              sym.methods.set(m.name, m);
            }
          }
        }
      }
      // Superclasses → extends.
      const supers = node.namedChildren.find((c) => c.type === 'argument_list');
      if (supers) {
        for (const c of supers.namedChildren) {
          if (c.type === 'identifier' || c.type === 'attribute') {
            sym.extends.push(c.text);
          }
        }
      }
      addType(graph, sym);
    } else if (node.type === 'function_definition') {
      // Only top-level functions (parent is module root).
      const parent = node.parent;
      if (
        parent &&
        (parent.type === 'module' || (parent.type === 'block' && parent.parent?.type === 'module'))
      ) {
        const fn = fnFromNode(node);
        if (fn) addFunction(graph, fn);
      }
    }
  }

  addModule(graph, moduleSymbolFor(relFile, root));
}
