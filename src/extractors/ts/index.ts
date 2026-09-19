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

/**
 * Every name a module exports, which is what an importer is entitled to ask
 * for. Types alone were not enough: `export const sounds = new SoundManager()`
 * is very much present in the file and absent from a graph of types, so a
 * check reading that graph had to ignore anything not spelled like a class.
 *
 * `export * from './x'` puts names in the module that this file does not
 * mention, so the list becomes null and nothing is reported about it.
 */
function recordExports(
  relFile: string,
  root: import('web-tree-sitter').Node,
  graph: SymbolGraph,
): void {
  const names = new Set<string>();
  let complete = true;
  for (const statement of root.namedChildren) {
    if (statement.type !== 'export_statement') continue;
    const children = statement.namedChildren;
    if (children.length === 0 || (children.length === 1 && children[0]?.type === 'string')) {
      complete = false; // `export * from '...'`
      continue;
    }
    if (statement.children.some((c) => !c.isNamed && c.text === 'default')) names.add('default');
    for (const child of children) {
      if (child.type === 'export_clause') {
        for (const spec of child.namedChildren) {
          if (spec.type !== 'export_specifier') continue;
          // `a as b` is exported under `b`; that is the name an import asks for.
          const exported = field(spec, 'alias') ?? field(spec, 'name');
          if (exported) names.add(exported.text);
        }
      } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
        for (const declarator of child.namedChildren) {
          if (declarator.type !== 'variable_declarator') continue;
          const name = field(declarator, 'name');
          // A destructured export names several bindings at once; the pattern
          // is not one of them.
          if (name?.type === 'identifier') names.add(name.text);
          else if (name) complete = false;
        }
      } else {
        const name = field(child, 'name');
        if (name) names.add(name.text);
      }
    }
  }
  graph.exportsByFile.set(relFile, complete ? names : null);
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

  recordExports(relFile, root, graph);

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
    // Enum members are the enum's contract; a renamed one still type-checks.
    if (d.kind === 'enum') typeSym.fields = enumMembers(d.node);

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
      // `get x()` and `set x(v)` are accessors, not methods. Recording them
      // as ordinary members hid two things: spying on one needs an access
      // type, and a setter's single parameter was being read as the member's
      // arity when both halves shared a name.
      const accessor = n.children.find(
        (c) => !c.isNamed && (c.text === 'get' || c.text === 'set'),
      )?.text;
      // `static` decides which object carries the member, so it decides which
      // object a spy has to be pointed at.
      const isStatic = n.children.some((c) => !c.isNamed && c.text === 'static');
      const modifiers = [...(accessor ? [accessor] : []), ...(isStatic ? ['static'] : [])];
      const sym: MethodSymbol = {
        name,
        returnType: typeTextOf(n, 'return_type'),
        params,
        visibility: visibilityOf(n),
        line: n.startPosition.row + 1,
        ...(modifiers.length ? { modifiers } : {}),
      };
      // A getter describes what reading the member yields, which is what a
      // stub replaces, so it wins over the setter of the same name.
      const existing = typeSym.methods.get(name);
      if (existing?.modifiers?.includes('get') && accessor === 'set') continue;
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

/** Member names of an enum declaration, assigned or bare. */
function enumMembers(node: import('web-tree-sitter').Node): Map<string, FieldSymbol> {
  const members = new Map<string, FieldSymbol>();
  const body = field(node, 'body');
  for (const child of body?.namedChildren ?? []) {
    const name =
      child.type === 'enum_assignment'
        ? (field(child, 'name')?.text ?? child.namedChildren[0]?.text)
        : child.type === 'property_identifier'
          ? child.text
          : null;
    if (name) {
      const literal =
        child.type === 'enum_assignment' ? (field(child, 'value') ?? child.namedChildren[1]) : null;
      members.set(name, {
        name,
        type: null,
        required: true,
        ...(literal ? { value: unquoteTs(literal.text) } : {}),
      });
    }
  }
  return members;
}

/** Strip the quotes around a TypeScript string literal. */
function unquoteTs(text: string): string {
  const t = text.trim();
  return /^(['"`])[\s\S]*\1$/.test(t) ? t.slice(1, -1) : t;
}
