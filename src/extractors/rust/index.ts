// ---------------------------------------------------------------------------
// Rust production indexer (traits, structs, enums, functions).
// ---------------------------------------------------------------------------

import type {
  FieldSymbol,
  MethodSymbol,
  ParamSymbol,
  SymbolGraph,
  TypeSymbol,
  ScanDiagnostic,
} from '../../core/types.js';
import { addType, addFunction, resolveType } from '../../core/symbolGraph.js';
import { parseSource, report } from '../../parser/loader.js';
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

function fieldsOfStruct(node: SyntaxNode): Map<string, FieldSymbol> | null {
  const body = field(node, 'body');
  if (!body) return null;
  const fields = new Map<string, FieldSymbol>();
  for (const child of body.namedChildren) {
    if (child.type !== 'field_declaration') continue;
    const name = field(child, 'name')?.text;
    if (!name) continue;
    fields.set(name, {
      name,
      type: typeTextOf(child, 'type'),
      required: true,
    });
  }
  return fields.size > 0 ? fields : null;
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
  diagnostics?: ScanDiagnostic[],
): Promise<void> {
  const parsed = await parseSource('rust', source, undefined, report(relFile, 'rust', diagnostics));
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
        // `trait Derived: Base` inherits Base's members. Leaving this empty
        // reported every inherited method as missing from the subtrait.
        extends: supertraitNames(node),
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
        ...(fieldsOfStruct(node) ? { fields: fieldsOfStruct(node)! } : {}),
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
    } else if (node.type === 'impl_item') {
      const ownerName = field(node, 'type')?.text;
      const owner = ownerName ? resolveType(graph, ownerName) : null;
      const body = field(node, 'body');
      if (owner && body) {
        for (const child of body.namedChildren) {
          if (child.type !== 'function_item') continue;
          const method = fnFromNode(child);
          if (method) owner.methods.set(method.name, method);
        }
      }
    } else if (node.type === 'function_item') {
      const parent = node.parent;
      if (parent?.type === 'source_file') {
        const fn = fnFromNode(node);
        if (fn) addFunction(graph, fn);
      }
    }
  }
}

/** Supertrait names from `trait Derived: Base + Send`, generics stripped. */
function supertraitNames(traitNode: SyntaxNode): string[] {
  const bounds = field(traitNode, 'bounds');
  if (!bounds) return [];
  const names: string[] = [];
  for (const child of bounds.namedChildren) {
    if (child.type === 'lifetime') continue;
    const text = child.text.trim();
    // `Base<T>` and `path::Base` both contribute the bare trait name.
    const match = /([A-Za-z_]\w*)\s*(<.*>)?$/.exec(text.split('<')[0] ?? text);
    const bare = match?.[1];
    if (bare && !AUTO_TRAITS.has(bare)) names.push(bare);
  }
  return names;
}

/** Marker traits that carry no members, so following them is pointless. */
const AUTO_TRAITS = new Set([
  'Send',
  'Sync',
  'Sized',
  'Unpin',
  'Copy',
  'Clone',
  'Debug',
  'Default',
  'Eq',
  'PartialEq',
  'Ord',
  'PartialOrd',
  'Hash',
]);
