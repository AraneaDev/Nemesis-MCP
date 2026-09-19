// ---------------------------------------------------------------------------
// Shared AST traversal helpers.
// ---------------------------------------------------------------------------

export type SyntaxNode = import('web-tree-sitter').Node;

/** Depth-first pre-order traversal of named nodes. */
export function* walk(node: SyntaxNode, depth = 0): Generator<{ node: SyntaxNode; depth: number }> {
  yield { node, depth };
  if (depth > 200) return; // pathological tree guard
  for (const child of node.namedChildren) {
    yield* walk(child, depth + 1);
  }
}

/** Strip surrounding quotes from a string literal's text. */
export function unquote(text: string): string {
  const t = text.trim();
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2) ||
    (t.startsWith('`') && t.endsWith('`') && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  return t;
}

/** Child by field name, if any. */
export function field(node: SyntaxNode, name: string): SyntaxNode | null {
  return node.childForFieldName(name);
}

/** Visibility token from a declaration's children, if any. */
export function visibilityOf(node: SyntaxNode): 'public' | 'protected' | 'private' {
  for (const c of node.children) {
    const text = c.text.trim();
    // TS/PHP wrap modifiers in a named `visibility_modifier`/`modifier` node;
    // other grammars expose them as bare anonymous tokens.
    if (
      c.isNamed &&
      c.type !== 'visibility_modifier' &&
      c.type !== 'accessibility_modifier' &&
      c.type !== 'modifier'
    ) {
      continue;
    }
    if (text === 'private' || text === 'protected') return text;
  }
  return 'public';
}

/** Type annotation text without the leading `:` / `->`, if present. */
export function typeTextOf(node: SyntaxNode, fieldName: string): string | null {
  const t = field(node, fieldName);
  if (!t) return null;
  return t.text
    .replace(/^:\s*/, '')
    .replace(/^->\s*/, '')
    .trim();
}
