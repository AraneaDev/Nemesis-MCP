// ---------------------------------------------------------------------------
// MCP server: exposes nemesis_audit, nemesis_verify_symbol, nemesis_stale_fixtures.
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { runAudit, verifySymbol } from '../core/runtime.js';
import { checkFixtures, filterFixtureFindings } from '../fixtures/staleFixtures.js';
import { packageVersion } from '../core/version.js';
import type { LanguageId, Strictness } from '../core/types.js';

const LANGS = ['typescript', 'javascript', 'php', 'python', 'rust'] as const;
const STRICT = ['all', 'untyped_only', 'breaking_only'] as const;

const LangSchema = z.enum(LANGS);
const StrictnessSchema = z.enum(STRICT);

const ExcludeSchema = z
  .array(z.string())
  .optional()
  .describe("Directory names to skip, e.g. a repository's own intentionally broken drift fixtures");

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function ok(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

/**
 * A thrown scan turns into a readable tool error rather than a transport-level
 * rejection, so the agent gets something it can act on.
 */
async function guarded(tool: string, run: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await run();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text', text: `${tool} failed: ${message}` }],
      isError: true,
    };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: 'nemesis-mcp',
    version: packageVersion(),
  });

  server.registerTool(
    'nemesis_audit',
    {
      title: 'Nemesis Audit',
      description:
        'Scan the repository (or given paths) for contract drift between test doubles (mocks, stubs, spies) and production code.',
      inputSchema: {
        paths: z
          .array(z.string())
          .optional()
          .describe('Test files or directories to inspect; defaults to standard discovery'),
        strictness: StrictnessSchema.default('breaking_only').describe('Severity filter'),
        lang: z.array(LangSchema).optional().describe('Restrict to these languages'),
        exclude: ExcludeSchema,
      },
    },
    async ({ paths, strictness, lang, exclude }) =>
      guarded('nemesis_audit', async () => {
        const result = await runAudit({
          rootDir: process.cwd(),
          ...(paths && paths.length ? { paths } : {}),
          strictness: (strictness ?? 'breaking_only') as Strictness,
          languages: (lang && lang.length ? lang : LANGS) as LanguageId[],
          ...(exclude && exclude.length ? { extraExcludes: exclude } : {}),
        });
        return ok(result);
      }),
  );

  server.registerTool(
    'nemesis_verify_symbol',
    {
      title: 'Nemesis Verify Symbol',
      description:
        'List every test double pointing at a production symbol and whether each remains valid.',
      inputSchema: {
        symbol: z.string().min(1).describe('Qualified or short class/interface/trait name'),
        strictness: StrictnessSchema.default('breaking_only'),
        exclude: ExcludeSchema,
      },
    },
    async ({ symbol, strictness, exclude }) =>
      guarded('nemesis_verify_symbol', async () => {
        const report = await verifySymbol(
          {
            rootDir: process.cwd(),
            strictness: (strictness ?? 'breaking_only') as Strictness,
            languages: [...LANGS] as LanguageId[],
            ...(exclude && exclude.length ? { extraExcludes: exclude } : {}),
          },
          symbol,
        );
        return ok({
          ...report,
          summary: {
            doubles: report.doubles.length,
            invalid: report.doubles.filter((d) => !d.valid).length,
          },
        });
      }),
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
    async ({ paths, strictness }) =>
      guarded('nemesis_stale_fixtures', async () => {
        const result = await checkFixtures(
          process.cwd(),
          paths && paths.length ? paths : undefined,
        );
        const filtered = filterFixtureFindings(result.violations, strictness ?? 'breaking_only');
        return ok({
          summary: {
            scanned_fixtures: result.scanned,
            unmatched_fixtures: result.unmatched,
            ...(result.unparsable.length ? { unparsable_fixtures: result.unparsable } : {}),
            violations_count: filtered.length,
            ...(result.diagnostics.length
              ? { diagnostics: result.diagnostics, partial: true }
              : {}),
          },
          violations: filtered,
        });
      }),
  );

  return server;
}

export async function serveStdio(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
