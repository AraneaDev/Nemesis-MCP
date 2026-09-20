// ---------------------------------------------------------------------------
// Python builtins reachable on any module without that module binding them.
// ---------------------------------------------------------------------------

/**
 * `unittest.mock` has special-cased builtins since Python 3.5: "If you are
 * patching builtins in a module then you don't need to pass create=True, it
 * will be added by default." `patch("services.files_service.open", ...)` is
 * correct code even though `files_service.py` neither imports nor defines
 * `open` — the name is reachable on every module regardless of what that
 * module actually binds.
 *
 * Kept out of a module's `unknownMembers` and consulted here instead, at
 * lookup time, for two reasons. First, `unknownMembers.size > 0` also drives
 * the confidence downgrade for an unrelated ghost, and seeding it with this
 * whole set made every Python module "known" whether or not it had anything
 * else in it. Second, and separately: a name here is treated as reachable
 * unconditionally, so a name that is both a builtin and a common attribute
 * name would silence a genuinely removed member of that name. `filter`,
 * `format`, `id` and `type` were dropped for exactly that reason — each is
 * an ordinary name for a module's own function or field, and the false
 * negative costs more than the exemption is worth. `open` stays: mocking the
 * builtin file-open call from inside a module is the exemption's canonical
 * use, and a module rarely defines its own `open`.
 */
export const PYTHON_BUILTINS: ReadonlySet<string> = new Set([
  'open',
  'print',
  'input',
  'len',
  'range',
  'isinstance',
  'issubclass',
  'hasattr',
  'getattr',
  'setattr',
  'delattr',
  'callable',
  'super',
  'hash',
  'repr',
  'str',
  'int',
  'float',
  'bool',
  'bytes',
  'bytearray',
  'memoryview',
  'list',
  'dict',
  'set',
  'frozenset',
  'tuple',
  'object',
  'exec',
  'eval',
  'compile',
  '__import__',
  'globals',
  'locals',
  'vars',
  'dir',
  'next',
  'iter',
  'sorted',
  'reversed',
  'enumerate',
  'zip',
  'map',
  'sum',
  'min',
  'max',
  'abs',
  'round',
  'any',
  'all',
  'chr',
  'ord',
  'bin',
  'hex',
  'oct',
  'divmod',
  'pow',
  'slice',
  'complex',
  'staticmethod',
  'classmethod',
  'property',
  'breakpoint',
  'help',
]);
