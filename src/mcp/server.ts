// ---------------------------------------------------------------------------
// MCP server: exposes nemesis_audit, nemesis_verify_symbol, nemesis_stale_fixtures.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runAudit, verifySymbol } from '../core/runtime.js';
import { checkFixtures, filterFixtureFindings } from '../fixtures/staleFixtures.js';
import type { LanguageId, Strictness } from '../core/types.js';

const LANGS = ['typescript', 'javascript', 'php', 'python', 'rust'] as const;
const STRICT = ['all', 'untyped_only', 'breaking_only'] as const;

const LangSchema = z.enum(LANGS);
const StrictnessSchema = z.enum(STRICT);

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nemesis-mcp',
    version: '0.1.0',
  });

  server.registerTool(
    'nemesis_audit',
    {
      title: 'Nemesis Audit',
      description:
        'Scan the repository (or given paths) for contract drift between test doubles (mocks, stubs, spies) and production code.',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Test files or directories to inspect; defaults to standard discovery'),
        strictness: StrictnessSchema.default('breaking_only').describe('Severity filter'),
        lang: z.array(LangSchema).optional().describe('Restrict to these languages'),
      },
    },
    async ({ paths, strictness, lang }) => {
      const result = await runAudit({
        rootDir: process.cwd(),
        ...(paths && paths.length ? { paths } : {}),
        strictness: (strictness ?? 'breaking_only') as Strictness,
        languages: (lang && lang.length ? lang : LANGS) as LanguageId[],
      });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    },
  );

  server.registerTool(
    'nemesis_verify_symbol',
    {
      title: 'Nemesis Verify Symbol',
      description:
        'List every test double pointing at a production symbol and whether each remains valid.',
      inputSchema: {
        symbol: z.string().describe('Qualified or short class/interface/trait name'),
        strictness: StrictnessSchema.default('breaking_only'),
      },
    },
    async ({ symbol, strictness }) => {
      const report = await verifySymbol(
        {
          rootDir: process.cwd(),
          strictness: (strictness ?? 'breaking_only') as Strictness,
          languages: [...LANGS] as LanguageId[],
        },
        symbol,
      );
      return { content: [{ type: 'text', text: JSON.stringify(report, null, 2) }] };
    },
  );

  server.registerTool(
    'nemesis_stale_fixtures',
    {
      title: 'Nemesis Stale Fixtures',
      description:
        'Check JSON/YAML fixtures against current production DTO shapes (missing/renamed/removed fields).',
      inputSchema: {
        paths: z.array(z.string()).optional().describe('Fixture files or directories'),
        strictness: StrictnessSchema.default('breaking_only'),
      },
    },
    async ({ paths, strictness }) => {
      const result = await checkFixtures(process.cwd(), paths && paths.length ? paths : undefined);
      const filtered = filterFixtureFindings(result.violations, strictness ?? 'breaking_only');
      const payload = {
        summary: {
          scanned_fixtures: result.scanned,
          violations_count: filtered.length,
          ...(result.diagnostics.length ? { diagnostics: result.diagnostics, partial: true } : {}),
        },
        violations: filtered,
      };
      return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    },
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
