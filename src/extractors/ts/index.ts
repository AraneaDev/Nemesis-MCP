// ---------------------------------------------------------------------------
// TypeScript/JavaScript production indexer.
// ---------------------------------------------------------------------------

import path from 'node:path';
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

const METHOD_TYPES = new Set([
  'method_definition',
  'method_signature',
  'abstract_method_signature',
]);

/** Extract a flat field map from an object type / interface body / type literal. */
export function fieldsFromTypeText(text: string): Map<string, FieldSymbol> | null {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const fields = new Map<string, FieldSymbol>();
  // Match `name(?): type;` at the top nesting level of the object type.
  const body = text.slice(1, -1);
  let depth = 0;
  let cur = '';
  const parts: string[] = [];
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    if (ch === ';' && depth === 0) {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
    if (ch === '}' || ch === ')') depth = Math.max(0, depth - 0); // keep depth balanced
  }
  if (cur.trim()) parts.push(cur);
  for (const part of parts) {
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?:\s*([^;]+);?\s*$/.exec(
      part.replace(/\n/g, ' '),
    );
    if (m?.[1] && m[3]) {
      fields.set(m[1], {
        name: m[1],
        type: m[3].trim(),
        required: !m[2],
      });
    }
  }
  return fields.size > 0 ? fields : null;
}

function fieldsFromClassBody(
  body: import('web-tree-sitter').Node | null,
): Map<string, FieldSymbol> | null {
  if (!body) return null;
  const fields = new Map<string, FieldSymbol>();
  for (const child of body.namedChildren) {
    if (
      !['property_definition', 'field_definition', 'public_field_definition'].includes(child.type)
    )
      continue;
    const name =
      field(child, 'name')?.text ??
      child.namedChildren.find((n) => n.type === 'property_identifier' || n.type === 'identifier')
        ?.text;
    if (!name) continue;
    fields.set(name, {
      name,
      type: typeTextOf(child, 'type'),
      required: !child.text.includes('?') && !child.text.includes('='),
    });
  }
  return fields.size > 0 ? fields : null;
}

interface TsDecl {
  name: string;
  kind: TypeSymbol['kind'];
  node: import('web-tree-sitter').Node;
  line: number;
}

export async function indexTsFile(
  relFile: string,
  source: string,
  graph: SymbolGraph,
): Promise<void> {
  const ext = path.extname(relFile);
  const grammar =
    ext === '.tsx'
      ? 'tsx'
      : ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs'
        ? 'javascript'
        : 'typescript';
  const parsed = await parseSource(
    grammar === 'javascript' ? 'javascript' : 'typescript',
    source,
    grammar,
  );
  const { root } = parsed;

  // Pass 1: collect declarations (classes, interfaces, enums, aliases).
  const decls: TsDecl[] = [];
  for (const { node } of walk(root)) {
    if (node.type === 'class_declaration' || node.type === 'class') {
      const name = field(node, 'name')?.text;
      if (name) decls.push({ name, kind: 'class', node, line: node.startPosition.row + 1 });
    } else if (node.type === 'interface_declaration') {
      const name = field(node, 'name')?.text;
      if (name) decls.push({ name, kind: 'interface', node, line: node.startPosition.row + 1 });
    } else if (node.type === 'enum_declaration') {
      const name = field(node, 'name')?.text.trim?.() ?? field(node, 'name')?.text;
      if (name) decls.push({ name, kind: 'enum', node, line: node.startPosition.row + 1 });
    } else if (node.type === 'type_alias_declaration') {
      const name = field(node, 'name')?.text;
      if (name) decls.push({ name, kind: 'type_alias', node, line: node.startPosition.row + 1 });
    } else if (node.type === 'function_declaration') {
      const name = field(node, 'name')?.text;
      if (name) {
        const fn = methodFromFunction(node);
        if (fn) addFunction(graph, fn);
      }
    }
  }

  // Pass 2: build symbols with members and heritage.
  for (const d of decls) {
    const typeSym: TypeSymbol = {
      name: d.name,
      file: relFile,
      kind: d.kind,
      methods: new Map(),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: d.line,
    };

    const classFields = d.kind === 'class' ? fieldsFromClassBody(field(d.node, 'body')) : null;
    if (classFields) typeSym.fields = classFields;

    // Heritage clauses.
    for (const { node: n } of walk(d.node)) {
      if (n.type === 'extends_clause' || n.type === 'implements_clause') {
        const target = n.type === 'extends_clause' ? 'extends' : 'implements';
        for (const c of n.namedChildren) {
          // A class `extends` clause holds an expression, because JavaScript
          // allows `extends someExpr`, so the base appears as an `identifier`
          // rather than a `type_identifier`. Matching only the latter left
          // every class's heritage empty: inherited members looked missing,
          // and a base outside the scanned tree could not be recognised.
          if (
            c.type === 'type_identifier' ||
            c.type === 'identifier' ||
            c.type === 'member_expression' ||
            c.type === 'nested_type_identifier'
          ) {
            const bare = c.text.split('<')[0]?.split('.').pop()?.trim();
            if (bare && /^[A-Za-z_$][\w$]*$/.test(bare)) {
              (target === 'extends' ? typeSym.extends : typeSym.implements).push(bare);
            }
          }
        }
      }
      if (n.type === 'extends_type_clause') {
        for (const c of n.namedChildren) {
          if (c.type === 'type_identifier') typeSym.extends.push(c.text);
        }
      }
    }

    // Members / fields.
    if (d.kind === 'type_alias') {
      const value = field(d.node, 'value');
      const fm = value ? fieldsFromTypeText(value.text) : null;
      if (fm) typeSym.fields = fm;
    } else if (d.kind === 'interface') {
      const body = field(d.node, 'body');
      const fm = body ? fieldsFromTypeText(body.text) : null;
      if (fm) typeSym.fields = fm;
    }

    for (const { node: n } of walk(d.node)) {
      if (!METHOD_TYPES.has(n.type)) continue;
      // Only members of THIS declaration: the closest class/interface body
      // ancestor of the member must belong to this declaration node.
      let anc: import('web-tree-sitter').Node | null = n.parent;
      let belongs = false;
      while (anc) {
        if (anc.id === d.node.id) {
          belongs = true;
          break;
        }
        if (
          anc.type === 'class_declaration' ||
          anc.type === 'class' ||
          anc.type === 'interface_declaration'
        ) {
          break; // reached a different declaration first
        }
        anc = anc.parent;
      }
      if (!belongs) continue;

      const name = field(n, 'name')?.text;
      if (!name) continue;
      const params: ParamSymbol[] = [];
      const paramList = field(n, 'parameters');
      if (paramList) {
        for (const p of paramList.namedChildren) {
          const param = paramFromTs(p);
          if (param) params.push(param);
        }
      }
      const sym: MethodSymbol = {
        name,
        returnType: typeTextOf(n, 'return_type'),
        params,
        visibility: visibilityOf(n),
        line: n.startPosition.row + 1,
      };
      typeSym.methods.set(name, sym);
    }

    addType(graph, typeSym);
  }
}

function paramFromTs(p: import('web-tree-sitter').Node): ParamSymbol | null {
  if (p.type === 'rest_pattern') {
    const inner = p.namedChildren[0];
    const name = inner?.text ?? '...';
    return { name, type: null, hasDefault: false, variadic: true };
  }
  if (p.type === 'required_parameter' || p.type === 'optional_parameter') {
    const pattern = field(p, 'pattern');
    const name = pattern?.text.split(/[:=]/)[0]?.trim() ?? p.text;
    return {
      name,
      type: typeTextOf(p, 'type'),
      // `code?: string` is optional whether or not it also has a default.
      // Requiring the `=` counted every optional parameter as mandatory, so a
      // correct call was reported as passing too few arguments.
      hasDefault: p.type === 'optional_parameter' || p.children.some((c) => c.text === '='),
      variadic: p.children.some((c) => c.type === 'rest_pattern'),
    };
  }
  if (p.type === 'assignment_pattern') {
    // JS default: `function f(a = 1)`
    const name = field(p, 'left')?.text ?? p.text;
    return { name, type: null, hasDefault: true, variadic: false };
  }
  if (p.type === 'identifier' || p.type === 'shorthand_property_identifier') {
    return { name: p.text, type: null, hasDefault: false, variadic: false };
  }
  if (p.type === 'formal_parameter') {
    // JS grammar
    const name = field(p, 'pattern')?.text ?? p.text;
    return {
      name,
      type: null,
      hasDefault: p.children.some((c) => c.text === '='),
      variadic: false,
    };
  }
  return null;
}

function methodFromFunction(node: import('web-tree-sitter').Node): MethodSymbol | null {
  const name = field(node, 'name')?.text;
  if (!name) return null;
  const params: ParamSymbol[] = [];
  const paramList = field(node, 'parameters');
  if (paramList) {
    for (const p of paramList.namedChildren) {
      const param = paramFromTs(p);
      if (param) params.push(param);
    }
  }
  return {
    name,
    returnType: typeTextOf(node, 'return_type'),
    params,
    visibility: 'public',
    line: node.startPosition.row + 1,
  };
}
