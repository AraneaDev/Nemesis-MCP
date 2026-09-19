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
import { addType, addFunction } from '../../core/symbolGraph.js';
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
}
