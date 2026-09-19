// ---------------------------------------------------------------------------
// Single source for the package version, so the CLI and the MCP server cannot
// drift apart from the manifest or from each other.
// ---------------------------------------------------------------------------

import { createRequire } from 'node:module';

let cached: string | null = null;

/** Version from the package manifest, or `unknown` if it cannot be read. */
export function packageVersion(): string {
  if (cached !== null) return cached;
  try {
    const require = createRequire(import.meta.url);
    const pkg = require('../../package.json') as { version?: string };
    cached = pkg.version ?? 'unknown';
  } catch {
    cached = 'unknown';
  }
  return cached;
}
