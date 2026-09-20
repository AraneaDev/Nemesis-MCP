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
import { addType, addFunction, addModule } from '../../core/symbolGraph.js';
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
  // CommonJS. `module.exports = { getPool, sql }` is an export list as much as
  // an `export` keyword is, and reading only the keyword left every CJS file
  // looking like a module that exports nothing at all.
  for (const { node } of walk(root)) {
    if (node.type !== 'assignment_expression') continue;
    const left = field(node, 'left')?.text ?? '';
    if (!/^(module\.)?exports\b/.test(left)) continue;
    const property = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (property?.[1]) {
      names.add(property[1]);
      continue;
    }
    if (!/^(module\.)?exports$/.test(left)) {
      complete = false;
      continue;
    }
    const right = field(node, 'right');
    if (right?.type !== 'object') {
      complete = false;
      continue;
    }
    for (const entry of right.namedChildren) {
      if (entry.type === 'comment') continue;
      if (entry.type === 'spread_element') {
        complete = false;
        continue;
      }
      const key = entry.type === 'shorthand_property_identifier' ? entry : field(entry, 'key');
      if (!key || key.type === 'computed_property_name') {
        complete = false;
        continue;
      }
      names.add(key.type === 'string' ? key.text.replace(/^['"`]|['"`]$/g, '') : key.text);
    }
  }
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
  // A file that turned out to export nothing says nothing: it is either not a
  // module or exports in a way this does not read, and neither is evidence.
  graph.exportsByFile.set(relFile, complete && names.size > 0 ? names : null);
}

/**
 * The module symbol for a TypeScript or JavaScript file: what it exports with
 * signatures, and what it imports.
 *
 * `recordExports` already walks these nodes for names and keeps doing so
 * unchanged: checks 22, 28 and 29 read `exportsByFile`. This builds the
 * richer symbol beside it. A name is a module member if it is reachable,
 * however it got there; when it cannot be described with a signature it
 * still goes in `unknownMembers` so it is never mistaken for a ghost.
 */
function moduleSymbolFor(
  relFile: string,
  root: import('web-tree-sitter').Node,
  graph: SymbolGraph,
): TypeSymbol {
  const sym: TypeSymbol = {
    name: relFile,
    file: relFile,
    kind: 'module',
    methods: new Map(),
    imports: new Map(),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  };

  // An export list this scan could not take whole means nothing is reportable.
  if (graph.exportsByFile.get(relFile) === null) sym.unknownMembers.add('*');

  // Every top-level function or function-valued const this file declares,
  // exported or not. CommonJS declares them first and lists them afterwards
  // in `module.exports`, so the lookup has to be able to look backwards.
  const declared = new Map<string, MethodSymbol>();

  const fnFromValue = (
    name: string,
    value: import('web-tree-sitter').Node,
    line: number,
  ): MethodSymbol | null => {
    if (value.type !== 'arrow_function' && value.type !== 'function_expression') return null;
    const params: ParamSymbol[] = [];
    const paramList = field(value, 'parameters');
    if (paramList) {
      for (const p of paramList.namedChildren) {
        const param = paramFromTs(p);
        if (param) params.push(param);
      }
    }
    return {
      name,
      returnType: typeTextOf(value, 'return_type'),
      params,
      visibility: 'public',
      line,
    };
  };

  const takeFunction = (node: import('web-tree-sitter').Node, exported: boolean): void => {
    const fn = methodFromFunction(node);
    if (!fn) return;
    declared.set(fn.name, fn);
    if (exported) sym.methods.set(fn.name, fn);
  };

  const takeArrowConst = (declarator: import('web-tree-sitter').Node, exported: boolean): void => {
    const name = field(declarator, 'name');
    const value = field(declarator, 'value');
    if (name?.type !== 'identifier') return;
    const fn = value ? fnFromValue(name.text, value, declarator.startPosition.row + 1) : null;
    if (fn) {
      declared.set(fn.name, fn);
      if (exported) sym.methods.set(fn.name, fn);
      return;
    }
    // A non-function const, e.g. `export const sounds = new SoundManager()` or
    // `export const MAX = 5`: the name is reachable, but nothing here can
    // describe it with a signature.
    if (exported) sym.unknownMembers.add(name.text);
  };

  // An exported class, interface, type alias or enum: the NAME is a member,
  // not a callable one, so it belongs in `unknownMembers` rather than
  // `methods`.
  const takeNamedDecl = (node: import('web-tree-sitter').Node): void => {
    const name = field(node, 'name')?.text;
    if (name) sym.unknownMembers.add(name);
  };

  for (const statement of root.namedChildren) {
    if (statement.type === 'function_declaration') {
      takeFunction(statement, false);
      continue;
    }
    if (statement.type === 'lexical_declaration' || statement.type === 'variable_declaration') {
      for (const d of statement.namedChildren) {
        if (d.type === 'variable_declarator') takeArrowConst(d, false);
      }
      continue;
    }
    if (statement.type === 'import_statement') {
      const from = statement.namedChildren.find((c) => c.type === 'string');
      const clause = statement.namedChildren.find((c) => c.type === 'import_clause');
      if (!from || !clause) continue;
      const source = unquoteTs(from.text);
      for (const part of clause.namedChildren) {
        if (part.type === 'named_imports') {
          for (const spec of part.namedChildren) {
            if (spec.type !== 'import_specifier') continue;
            const name = field(spec, 'name')?.text;
            const alias = field(spec, 'alias')?.text;
            if (name) {
              sym.imports!.set(alias ?? name, { from: source, name });
              sym.unknownMembers.add(alias ?? name);
            }
          }
        } else if (part.type === 'identifier') {
          // `import foo from './x'` — the default export, bound locally.
          sym.imports!.set(part.text, { from: source, name: 'default' });
          sym.unknownMembers.add(part.text);
        } else if (part.type === 'namespace_import') {
          // `import * as ns from './x'` binds `ns` to the whole namespace
          // object. It is a member of THIS file, not of the module it came
          // from, so it has no single symbol to delegate to.
          const nsName = part.namedChildren.find((c) => c.type === 'identifier')?.text;
          if (nsName) sym.unknownMembers.add(nsName);
        }
      }
      continue;
    }
    if (statement.type === 'export_statement') {
      const isDefault = statement.children.some((c) => !c.isNamed && c.text === 'default');
      let sawDefaultTarget = false;
      for (const child of statement.namedChildren) {
        if (child.type === 'function_declaration') {
          if (isDefault) {
            sawDefaultTarget = true;
            const fn = methodFromFunction(child);
            if (fn) {
              declared.set(fn.name, fn);
              sym.methods.set('default', { ...fn, name: 'default' });
            } else {
              sym.unknownMembers.add('default');
            }
          } else {
            takeFunction(child, true);
          }
        } else if (child.type === 'lexical_declaration' || child.type === 'variable_declaration') {
          for (const d of child.namedChildren) {
            if (d.type === 'variable_declarator') takeArrowConst(d, true);
          }
        } else if (
          child.type === 'class_declaration' ||
          child.type === 'interface_declaration' ||
          child.type === 'enum_declaration' ||
          child.type === 'type_alias_declaration'
        ) {
          if (isDefault) {
            sawDefaultTarget = true;
            sym.unknownMembers.add('default');
          } else {
            takeNamedDecl(child);
          }
        } else if (child.type === 'export_clause') {
          // `export { foo, bar as baz }` re-exports names declared earlier
          // in this file under their local (or aliased) name.
          for (const spec of child.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const localName = field(spec, 'name')?.text;
            const exportedName = field(spec, 'alias')?.text ?? localName;
            if (!exportedName) continue;
            const fn = localName ? declared.get(localName) : undefined;
            if (fn) sym.methods.set(exportedName, fn);
            else sym.unknownMembers.add(exportedName);
          }
        }
      }
      // `export default <expr>` with no declaration child at all — an
      // identifier, object literal, call expression, and so on. Still a
      // reachable member, just not one with a signature.
      if (isDefault && !sawDefaultTarget && !sym.methods.has('default')) {
        sym.unknownMembers.add('default');
      }
      continue;
    }
  }

  // CommonJS. `module.exports = { getPool }`, `module.exports.getPool = ...`
  // and `exports.getPool = ...` all name members reachable from outside this
  // file, whether or not they resolve to something declared above with a
  // signature this pass can read.
  for (const { node } of walk(root)) {
    if (node.type !== 'assignment_expression') continue;
    const left = field(node, 'left')?.text ?? '';
    if (!/^(module\.)?exports\b/.test(left)) continue;
    const right = field(node, 'right');

    const property = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
    if (property?.[1]) {
      const propName = property[1];
      if (sym.methods.has(propName)) continue;
      const viaIdentifier = right?.type === 'identifier' ? declared.get(right.text) : undefined;
      const viaValue = right ? fnFromValue(propName, right, node.startPosition.row + 1) : null;
      const fn = viaIdentifier ?? viaValue;
      if (fn) sym.methods.set(propName, fn);
      else sym.unknownMembers.add(propName);
      continue;
    }

    if (!/^(module\.)?exports$/.test(left)) continue;
    if (right?.type !== 'object') continue; // exportsByFile already marked '*' for this

    for (const entry of right.namedChildren) {
      if (entry.type === 'comment' || entry.type === 'spread_element') continue;
      const key =
        entry.type === 'shorthand_property_identifier'
          ? entry
          : (field(entry, 'key') ?? field(entry, 'name'));
      if (!key || key.type === 'computed_property_name') continue;
      const keyName = key.type === 'string' ? unquoteTs(key.text) : key.text;
      if (sym.methods.has(keyName)) continue;
      const viaIdentifier = declared.get(keyName);
      const pairValue = entry.type === 'pair' ? field(entry, 'value') : null;
      const viaValue = pairValue
        ? fnFromValue(keyName, pairValue, entry.startPosition.row + 1)
        : field(entry, 'parameters')
          ? methodFromFunction(entry)
          : null;
      const fn = viaIdentifier ?? viaValue;
      if (fn) sym.methods.set(keyName, fn);
      else sym.unknownMembers.add(keyName);
    }
  }

  return sym;
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

  addModule(graph, moduleSymbolFor(relFile, root, graph));
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
