// ---------------------------------------------------------------------------
// Python production indexer (classes, methods, functions).
// ---------------------------------------------------------------------------

import type {
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
      params.push({ name: p.text, type: null, hasDefault: false, variadic: false });
    } else if (p.type === 'default_parameter' || p.type === 'typed_parameter' || p.type === 'typed_default_parameter') {
      const nameNode = field(p, 'name');
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

function fnFromNode(node: SyntaxNode): MethodSymbol | null {
  const name = field(node, 'name')?.text;
  if (!name) return null;
  return {
    name,
    returnType: typeTextOf(node, 'return_type'),
    params: paramsOf(node),
    visibility:
      node.children.some((c) => !c.isNamed && c.text === 'async') ? 'public' : 'public',
    line: node.startPosition.row + 1,
  };
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
  let parsed;
  try {
    parsed = await parseSource('python', source);
  } catch {
    return;
  }
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
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      };
      const body = field(node, 'body');
      if (body) {
        for (const n of body.namedChildren) {
          if (n.type === 'function_definition' || n.type === 'decorated_definition') {
            const fnNode = n.type === 'decorated_definition' ? n.namedChildren.find((c) => c.type === 'function_definition') : n;
            const m = fnNode ? fnFromNode(fnNode) : null;
            if (m) {
              m.visibility = pyVisibility(m.name);
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
      if (parent && (parent.type === 'module' || parent.type === 'block' && parent.parent?.type === 'module')) {
        const fn = fnFromNode(node);
        if (fn) addFunction(graph, fn);
      }
    }
  }
}
