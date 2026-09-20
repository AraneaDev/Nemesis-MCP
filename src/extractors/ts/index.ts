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

/**
 * Extract a flat field map from the TEXT of an object type.
 *
 * Prefer `fieldsFromTypeBody` wherever the parse node is available. This is for
 * the places that only have text, such as the declared type of a field that is
 * itself an object.
 */
export function fieldsFromTypeText(text: string): Map<string, FieldSymbol> | null {
  if (!text.startsWith('{') || !text.endsWith('}')) return null;
  const fields = new Map<string, FieldSymbol>();
  // Split `name(?): type` members at the top nesting level. TypeScript accepts
  // a semicolon, a comma or nothing but a newline between them, and all three
  // have to end a member or the rest of the object reads as part of the first
  // field's type.
  const body = text.slice(1, -1);
  let depth = 0;
  let cur = '';
  let prev = '';
  const parts: string[] = [];
  const push = (): void => {
    if (cur.trim()) parts.push(cur);
    cur = '';
  };
  for (const ch of body) {
    if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
    // `>` closes a type argument list, except in `=>`, which closes nothing.
    else if (ch === '}' || ch === ')' || ch === ']' || (ch === '>' && prev !== '='))
      depth = Math.max(0, depth - 1);
    if ((ch === ';' || ch === ',' || ch === '\n') && depth === 0) {
      push();
    } else {
      cur += ch;
    }
    if (!/\s/.test(ch)) prev = ch;
  }
  push();
  for (const part of parts) {
    // The type runs to the end of the member. It is NOT "everything up to a
    // semicolon": the split above already ended the member at the top-level
    // semicolon, and any semicolon still inside belongs to an inline object
    // type (`pagination: { page: number; total: number }`). Stopping at the
    // first one dropped every such field, which then read as a field the type
    // does not have, and any stub supplying it was reported as drift.
    const m = /^\s*(?:readonly\s+)?([A-Za-z_$][\w$]*)(\?)?:\s*([\s\S]+)$/.exec(
      part.replace(/\n/g, ' '),
    );
    const declared = m?.[3]?.replace(/;\s*$/, '').trim();
    if (m?.[1] && declared) {
      fields.set(m[1], {
        name: m[1],
        type: declared,
        required: !m[2],
      });
    }
  }
  return fields.size > 0 ? fields : null;
}

/**
 * The fields of an `interface_body` or an `object_type`, read from the parse
 * tree rather than from its text.
 *
 * TypeScript lets an interface separate its members with semicolons, commas or
 * nothing but a newline. Splitting the text on semicolons therefore read a
 * newline-separated interface as one enormous member: the first field was
 * registered and every other one reported as a field the type does not have.
 * The grammar already knows where a member ends, so ask it.
 *
 * `fieldsFromTypeText` remains for the places that only have text, such as the
 * declared type of a field that is itself an object.
 */
function fieldsFromTypeBody(
  body: import('web-tree-sitter').Node | null,
): Map<string, FieldSymbol> | null {
  if (!body) return null;
  const fields = new Map<string, FieldSymbol>();
  for (const child of body.namedChildren) {
    if (child.type !== 'property_signature') continue;
    const name =
      field(child, 'name')?.text ??
      child.namedChildren.find(
        (n) => n.type === 'property_identifier' || n.type === 'string' || n.type === 'identifier',
      )?.text;
    if (!name) continue;
    // `?` is an anonymous token between the name and the type annotation.
    const optional = child.children.some((c) => !c.isNamed && c.text === '?');
    fields.set(name.replace(/^(['"`])(.*)\1$/, '$2'), {
      name,
      type: typeTextOf(child, 'type'),
      required: !optional,
    });
  }
  return fields.size > 0 ? fields : null;
}

/**
 * True when a declaration sits inside `declare global { ... }`, which augments
 * a type declared elsewhere rather than declaring one here.
 */
function isGlobalAugmentation(node: import('web-tree-sitter').Node): boolean {
  let anc: import('web-tree-sitter').Node | null = node.parent;
  while (anc) {
    if (anc.type === 'ambient_declaration' && /^declare\s+global\b/.test(anc.text)) return true;
    anc = anc.parent;
  }
  return false;
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
      // A shorthand method (`{ foo(a, b) {} }`) holds its name under `name`,
      // not `key`. Without the fallback the entry read as nameless, which gave
      // up on the export list for the whole file and silenced every question
      // about it. `moduleSymbolFor` reads both fields, and the two readers of
      // one construct have to agree.
      const key =
        entry.type === 'shorthand_property_identifier'
          ? entry
          : (field(entry, 'key') ?? field(entry, 'name'));
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

  // Every name this file imports, local name -> where it came from. An import
  // is not an export: `import { query } from './pg.js'` binds `query`
  // locally and says nothing about what THIS file hands back to an importer.
  // Unlike Python, where `from x import y` genuinely makes `y` an attribute
  // of the importing module, a plain TypeScript import is invisible from
  // outside the file. It only becomes a member — and only then does it
  // belong in `sym.imports` — if an `export` statement re-exports it, which
  // is resolved once every import and export in the file has been read.
  const importedLocals = new Map<string, { from: string; name: string }>();

  // Local name -> constructor name, for `const svc = new Svc()`, exported or
  // not. Consulted when `export default svc` turns out to default-export a
  // name declared earlier in the file: a default IMPORT binds the module's
  // default export, not the module, and that export is usually an instance
  // like this one rather than anything the module itself defines.
  const constTypeOf = new Map<string, string>();

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
    // `const svc = new Svc()`: not callable, but its type is knowable, which
    // matters if this name turns out to be a bare `export default svc` later
    // in the file.
    if (value?.type === 'new_expression') {
      const ctor = field(value, 'constructor');
      if (ctor) constTypeOf.set(name.text, ctor.text);
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
            // Recorded for a later `export { ... }` to promote, not entered
            // into `imports`/`unknownMembers` here: a plain import is a
            // local binding, not a member of this file.
            if (name) importedLocals.set(alias ?? name, { from: source, name });
          }
        } else if (part.type === 'identifier') {
          // `import foo from './x'` — the default export, bound locally.
          importedLocals.set(part.text, { from: source, name: 'default' });
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
      // `export { foo } from './other'` carries a source string alongside
      // the export_clause; `export { foo, bar as baz }` does not. The two
      // need different treatment below: the first names a member this file
      // neither defines nor imports at all, the second re-exports something
      // already declared or imported here.
      const reExportSource = statement.namedChildren.find((c) => c.type === 'string');
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
        } else if (isDefault && child.type === 'identifier') {
          // `export default svc` — reachable, and its type is knowable when
          // `svc` was declared earlier in this file as `new Svc()`.
          sawDefaultTarget = true;
          const ctor = constTypeOf.get(child.text);
          if (ctor) sym.defaultExportType = ctor;
          else sym.unknownMembers.add('default');
        } else if (isDefault && child.type === 'new_expression') {
          // `export default new Svc()`, inline rather than through a name.
          sawDefaultTarget = true;
          const ctor = field(child, 'constructor');
          if (ctor) sym.defaultExportType = ctor.text;
          else sym.unknownMembers.add('default');
        } else if (child.type === 'export_clause') {
          for (const spec of child.namedChildren) {
            if (spec.type !== 'export_specifier') continue;
            const localName = field(spec, 'name')?.text;
            const exportedName = field(spec, 'alias')?.text ?? localName;
            if (!exportedName) continue;
            if (reExportSource) {
              // `export { foo as bar } from './other'`: a genuine re-export
              // of a name this file never defines or imports itself.
              // `localName` is the name as written in that other module.
              if (localName) {
                sym.imports!.set(exportedName, {
                  from: unquoteTs(reExportSource.text),
                  name: localName,
                });
              }
              continue;
            }
            // `export { foo, bar as baz }` re-exports a name declared or
            // imported earlier in this file under its local (or aliased)
            // name.
            const fn = localName ? declared.get(localName) : undefined;
            if (fn) {
              sym.methods.set(exportedName, fn);
              continue;
            }
            const imported = localName ? importedLocals.get(localName) : undefined;
            if (imported) {
              // `import { query } from './pg.js'; export { query };` — the
              // import only becomes a member of this file now, at the point
              // it is actually re-exported.
              sym.imports!.set(exportedName, imported);
              continue;
            }
            sym.unknownMembers.add(exportedName);
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

    // Members / fields, read from the parse tree. Falls back to the text
    // reader only for an alias whose value is not a plain object type.
    if (d.kind === 'type_alias') {
      const value = field(d.node, 'value');
      const fm = value
        ? (fieldsFromTypeBody(value.type === 'object_type' ? value : null) ??
          fieldsFromTypeText(value.text))
        : null;
      if (fm) typeSym.fields = fm;
      // `type Logger = typeof logger` names an object this scan cannot follow
      // to its members. Indexing the alias with none at all made every call on
      // it a ghost, so say the members are unknown instead of absent.
      if (value?.type === 'type_query') typeSym.unknownMembers.add('*');
      // `type DB = Database.Database` declares no members of its own; they all
      // belong to whatever it aliases. Record that as heritage so member
      // lookups follow it, and so a target living outside the scanned tree is
      // recognised as unreadable rather than as empty.
      if (
        value &&
        (value.type === 'type_identifier' ||
          value.type === 'nested_type_identifier' ||
          value.type === 'generic_type')
      ) {
        const head =
          value.type === 'generic_type'
            ? (value.namedChildren.find(
                (c) => c.type === 'type_identifier' || c.type === 'nested_type_identifier',
              )?.text ?? null)
            : value.text;
        if (head && head !== d.name) typeSym.extends.push(head);
      }
    } else if (d.kind === 'interface') {
      const fm = fieldsFromTypeBody(field(d.node, 'body'));
      if (fm) typeSym.fields = fm;
      // `declare global { interface Window { ... } }` ADDS to a type declared
      // somewhere this scan never reads, usually the DOM's. The members here
      // are real, the ones it already had are not visible, and indexing this as
      // the whole of `Window` made every real DOM method read as missing.
      if (isGlobalAugmentation(d.node)) typeSym.unknownMembers.add('*');
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
