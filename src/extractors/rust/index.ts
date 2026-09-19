// ---------------------------------------------------------------------------
// Rust production indexer (traits, structs, enums, functions).
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
    if (p.type === 'parameter') {
      const pattern = field(p, 'pattern');
      const name = pattern?.text.split(/[:=]/)[0]?.trim() ?? p.text;
      params.push({
        name,
        type: typeTextOf(p, 'type'),
        hasDefault: false,
        variadic: false,
      });
    } else if (p.type === 'higher_ranked_trait_bound' || p.type === 'for_lifetimes') {
      // skip bounds/lifetimes wrappers
    } else if (p.type === 'variadic_parameter') {
      params.push({ name: '...', type: null, hasDefault: false, variadic: true });
    }
  }
  // `&self` / `&mut self` are captured as `parameter` with pattern `self`;
  // they count as one receiver param, consistent with the other ecosystems.
  return params;
}

function fnFromNode(node: SyntaxNode): MethodSymbol | null {
  const name = field(node, 'name')?.text;
  if (!name) return null;
  return {
    name,
    returnType: typeTextOf(node, 'return_type'),
    params: paramsOf(node),
    visibility: node.children.some((c) => c.text === 'pub') ? 'public' : 'public',
    line: node.startPosition.row + 1,
  };
}

export async function indexRustFile(
  relFile: string,
  source: string,
  graph: SymbolGraph,
): Promise<void> {
  let parsed;
  try {
    parsed = await parseSource('rust', source);
  } catch {
    return;
  }
  const { root } = parsed;

  for (const { node } of walk(root)) {
    if (node.type === 'trait_item') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name,
        file: relFile,
        kind: 'trait',
        methods: new Map(),
        unknownMembers: new Set(),
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      };
      const body = field(node, 'body');
      if (body) {
        for (const n of body.namedChildren) {
          if (n.type === 'function_signature_item' || n.type === 'function_item') {
            const m = fnFromNode(n);
            if (m) sym.methods.set(m.name, m);
          }
        }
      }
      addType(graph, sym);
    } else if (node.type === 'struct_item') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      addType(graph, {
        name,
        file: relFile,
        kind: 'struct',
        methods: new Map(),
        unknownMembers: new Set(),
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      });
    } else if (node.type === 'enum_item') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      addType(graph, {
        name,
        file: relFile,
        kind: 'enum',
        methods: new Map(),
        unknownMembers: new Set(),
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      });
    } else if (node.type === 'function_item') {
      const parent = node.parent;
      if (parent?.type === 'source_file') {
        const fn = fnFromNode(node);
        if (fn) addFunction(graph, fn);
      }
    }
  }
}
