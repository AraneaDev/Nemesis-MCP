// ---------------------------------------------------------------------------
// Shared tree-sitter query strings per language.
// ---------------------------------------------------------------------------

export const TS_QUERIES = {
  class: `(class_declaration name: (type_identifier) @name) @decl`,
  interface: `(interface_declaration name: (type_identifier) @name) @decl`,
  enum: `(enum_declaration name: (type_identifier) @name) @decl`,
  typeAlias: `(type_alias_declaration name: (type_identifier) @name) @decl`,
  method: `(method_definition name: (property_identifier) @name) @decl`,
  fn: `(function_declaration name: (identifier) @name) @decl`,
};

export const PHP_QUERIES = {
  class: `(class_declaration name: (name) @name) @decl`,
  interface: `(interface_declaration name: (name) @name) @decl`,
  trait: `(trait_declaration name: (name) @name) @decl`,
  enum: `(enum_declaration name: (name) @name) @decl`,
  method: `(method_declaration name: (name) @name) @decl`,
  fn: `(function_definition name: (name) @name) @decl`,
};

export const PY_QUERIES = {
  class: `(class_definition name: (identifier) @name) @decl`,
  method: `(function_definition name: (identifier) @name) @decl`,
  fn: `(function_definition name: (identifier) @name) @decl`,
};

export const RS_QUERIES = {
  trait: `(trait_item name: (type_identifier) @name) @decl`,
  struct: `(struct_item name: (type_identifier) @name) @decl`,
  enum: `(enum_item name: (type_identifier) @name) @decl`,
  fn: `(function_item name: (identifier) @name) @decl`,
};
