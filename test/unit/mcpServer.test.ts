import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../../src/mcp/server.js';
import { packageVersion } from '../../src/core/version.js';

let client: Client;

async function call(name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return result;
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]?.text ?? '{}');
}

beforeAll(async () => {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer();
  client = new Client({ name: 'test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

afterAll(async () => {
  await client.close();
});

describe('the MCP surface', () => {
  it('advertises exactly the three documented tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'nemesis_audit',
      'nemesis_stale_fixtures',
      'nemesis_verify_symbol',
    ]);
  });

  it('reports the manifest version rather than a literal', async () => {
    expect(client.getServerVersion()?.version).toBe(packageVersion());
  });

  it('audits and reports the fixture drift', async () => {
    const result = await call('nemesis_audit', {
      paths: ['fixtures/ts'],
      strictness: 'all',
    });
    expect(result.isError).toBeFalsy();
    const body = payload(result);
    expect(body.summary.violations_count).toBeGreaterThan(0);
  }, 120_000);

  it('honours exclude, which is what lets an agent audit this repository', async () => {
    const result = await call('nemesis_audit', {
      strictness: 'all',
      exclude: ['fixtures'],
    });
    expect(payload(result).violations).toEqual([]);
  }, 120_000);

  it('narrows by language', async () => {
    const result = await call('nemesis_audit', {
      paths: ['fixtures'],
      strictness: 'all',
      lang: ['php'],
    });
    const files = payload(result).violations.map((v: { file: string }) => v.file);
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f: string) => f.endsWith('.php'))).toBe(true);
  }, 120_000);

  it('returns a readable tool error instead of rejecting', async () => {
    const result = await call('nemesis_audit', { paths: ['no/such/path'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('nemesis_audit failed');
  }, 120_000);

  it('counts invalid doubles for verify_symbol', async () => {
    const result = await call('nemesis_verify_symbol', { symbol: 'UserService' });
    const body = payload(result);
    expect(body.resolved).toBe(true);
    expect(body.summary.invalid).toBeGreaterThan(0);
    expect(body.summary.doubles).toBeGreaterThanOrEqual(body.summary.invalid);
  }, 120_000);

  it('checks fixtures and separates matched from unmatched', async () => {
    const result = await call('nemesis_stale_fixtures', {
      paths: ['fixtures/fixtures-data'],
      strictness: 'all',
    });
    const body = payload(result);
    expect(body.summary.scanned_fixtures).toBe(1);
    expect(body.summary.violations_count).toBeGreaterThan(0);
  }, 120_000);
});
