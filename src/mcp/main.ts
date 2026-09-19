#!/usr/bin/env node
// ---------------------------------------------------------------------------
// nemesis-mcp entrypoint: serves the MCP server over stdio by default.
// Pass `audit` to run a one-shot CLI audit instead.
// ---------------------------------------------------------------------------

import process from 'node:process';
import { serveStdio } from './server.js';

const arg = process.argv[2];

if (arg === '--serve' || arg === undefined) {
  serveStdio().catch((err) => {
    console.error('nemesis-mcp failed to start:', err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
  });
} else {
  console.error('usage: nemesis-mcp [--serve]');
  process.exitCode = 2;
}
