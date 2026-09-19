// ---------------------------------------------------------------------------
// PHP production indexer (classes, interfaces, traits, enums, functions).
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
import { walk, field, typeTextOf, visibilityOf } from '../walk.js';

type SyntaxNode = import('web-tree-sitter').Node;

interface PhpHeader {
  namespace: string;
  uses: Map<string, string>;
}

/** Collect namespace + use-import map from the file header. */
function headerMap(root: SyntaxNode): PhpHeader {
  let namespace = '';
  const uses = new Map<string, string>();
  for (const { node } of walk(root)) {
    if (node.type === 'namespace_definition') {
      const n = field(node, 'name');
      if (n) namespace = n.text;
    } else if (node.type === 'namespace_use_declaration') {
      for (const c of node.namedChildren) {
        if (c.type === 'namespace_use_clause') {
          const name = field(c, 'name')?.text ?? '';
          const alias = field(c, 'alias')?.text;
          if (name) {
            const short = alias ?? name.split('\\').pop() ?? name;
            uses.set(short, name);
          }
        }
      }
    }
  }
  return { namespace, uses };
}

/** Qualify a class reference using the file's use-import map. */
function qualifyName(raw: string, header: PhpHeader): string {
  const t = raw.replace(/^\\+/, '');
  if (t.includes('\\')) return t;
  return header.uses.get(t) ?? (header.namespace ? `${header.namespace}\\${t}` : t);
}

function paramsOf(node: SyntaxNode): ParamSymbol[] {
  const params: ParamSymbol[] = [];
  const paramList = field(node, 'parameters');
  if (!paramList) return params;
  for (const p of paramList.namedChildren) {
    if (p.type === 'simple_parameter' || p.type === 'property_promotion_parameter') {
      params.push({
        name: field(p, 'name')?.text ?? p.text,
        type: typeTextOf(p, 'type'),
        hasDefault: field(p, 'default_value') !== null,
        variadic: p.children.some((c) => c.text === '...'),
      });
    } else if (p.type === 'variadic_parameter' || p.type === 'variadic_unpacking_parameter') {
      params.push({
        name: field(p, 'name')?.text ?? '...',
        type: null,
        hasDefault: false,
        variadic: true,
      });
    }
  }
  return params;
}

function methodFromNode(node: SyntaxNode): MethodSymbol | null {
  const name = field(node, 'name')?.text;
  if (!name) return null;
  const modifiers = modifiersOf(node);
  return {
    name,
    returnType: typeTextOf(node, 'return_type'),
    params: paramsOf(node),
    visibility: visibilityOf(node),
    line: node.startPosition.row + 1,
    ...(modifiers.length > 0 ? { modifiers } : {}),
  };
}

/**
 * Declaration modifiers as written. `final` and `static` decide whether a
 * member can be doubled at all: PHPUnit cannot override a final method, and a
 * static one is not reachable through an instance mock.
 */
function modifiersOf(node: SyntaxNode): string[] {
  const found: string[] = [];
  for (const child of node.children) {
    const text = child.text.trim();
    if (/^(final|static|abstract|readonly)$/.test(text)) found.push(text);
  }
  return found;
}

function fieldsOfBody(decl: SyntaxNode): Map<string, FieldSymbol> | null {
  const body = field(decl, 'body');
  if (!body) return null;
  const fields = new Map<string, FieldSymbol>();
  for (const declaration of body.namedChildren) {
    if (declaration.type !== 'property_declaration') continue;
    const type = typeTextOf(declaration, 'type');
    for (const property of declaration.namedChildren) {
      if (property.type !== 'property_element') continue;
      const nameNode = field(property, 'name');
      const name = nameNode?.text ?? property.text.match(/\\$[A-Za-z_][A-Za-z0-9_]*/)?.[0];
      if (!name) continue;
      const cleanName = name.startsWith('$') ? name.slice(1) : name;
      fields.set(cleanName, {
        name: cleanName,
        type,
        required: !property.text.includes('=') && !declaration.text.includes('?'),
      });
    }
  }
  return fields.size > 0 ? fields : null;
}

function methodsOfBody(decl: SyntaxNode): Map<string, MethodSymbol> {
  const methods = new Map<string, MethodSymbol>();
  const body = field(decl, 'body');
  if (!body) return methods;
  for (const n of body.namedChildren) {
    if (n.type === 'method_declaration') {
      const m = methodFromNode(n);
      if (m) methods.set(m.name, m);
    }
  }
  return methods;
}

/** Names inside a heritage clause (base_clause / class_interface_clause / interface_list). */
function heritageNames(decl: SyntaxNode, clauseTypes: string[], header: PhpHeader): string[] {
  const out: string[] = [];
  for (const child of decl.namedChildren) {
    if (!clauseTypes.includes(child.type)) continue;
    for (const c of child.namedChildren) {
      if (c.type === 'name' || c.type === 'qualified_name') {
        out.push(qualifyName(c.text, header));
      }
    }
  }
  return out;
}

export async function indexPhpFile(
  relFile: string,
  source: string,
  graph: SymbolGraph,
): Promise<void> {
  const parsed = await parseSource('php', source);
  const { root } = parsed;
  const header = headerMap(root);

  for (const { node } of walk(root)) {
    if (node.type === 'class_declaration') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name: qualifyName(name, header),
        file: relFile,
        kind: 'class',
        methods: methodsOfBody(node),
        unknownMembers: new Set(['__call']),
        ...(fieldsOfBody(node) ? { fields: fieldsOfBody(node)! } : {}),
        extends: heritageNames(node, ['base_clause'], header),
        implements: heritageNames(node, ['class_interface_clause'], header),
        uses: [],
        line: node.startPosition.row + 1,
        ...(modifiersOf(node).length > 0 ? { modifiers: modifiersOf(node) } : {}),
      };
      addType(graph, sym);
    } else if (node.type === 'interface_declaration') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name: qualifyName(name, header),
        file: relFile,
        kind: 'interface',
        methods: methodsOfBody(node),
        unknownMembers: new Set(),
        ...(fieldsOfBody(node) ? { fields: fieldsOfBody(node)! } : {}),
        extends: heritageNames(node, ['base_clause'], header),
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      };
      addType(graph, sym);
    } else if (node.type === 'trait_declaration') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name: qualifyName(name, header),
        file: relFile,
        kind: 'trait',
        methods: methodsOfBody(node),
        unknownMembers: new Set(),
        extends: [],
        implements: [],
        uses: [],
        line: node.startPosition.row + 1,
      };
      addType(graph, sym);
    } else if (node.type === 'enum_declaration') {
      const name = field(node, 'name')?.text;
      if (!name) continue;
      const sym: TypeSymbol = {
        name: qualifyName(name, header),
        file: relFile,
        kind: 'enum',
        methods: methodsOfBody(node),
        unknownMembers: new Set(),
        extends: [],
        implements: heritageNames(node, ['interface_list'], header),
        uses: [],
        line: node.startPosition.row + 1,
      };
      addType(graph, sym);
    } else if (node.type === 'function_definition') {
      const fn = methodFromNode(node);
      if (fn) addFunction(graph, fn);
    }
  }
}
