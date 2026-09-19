import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageVersion } from '../src/core/version.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

interface JsonRpcMsg {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
}

/** Minimal stdio JSON-RPC client for smoke testing the MCP server. */
async function withServer(
  fn: (send: (msg: object) => void, next: () => Promise<JsonRpcMsg>) => Promise<void>,
): Promise<void> {
  const child = spawn('npx', ['tsx', path.join(root, 'src', 'mcp', 'main.ts'), '--serve'], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buffer = '';
  const queue: JsonRpcMsg[] = [];
  const waiters: Array<(m: JsonRpcMsg) => void> = [];

  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as JsonRpcMsg;
        const w = waiters.shift();
        if (w) w(msg);
        else queue.push(msg);
      } catch {
        // ignore non-JSON lines (banners on stderr are separate)
      }
    }
  });

  const next = (): Promise<JsonRpcMsg> =>
    new Promise((resolve) => {
      const queued = queue.shift();
      if (queued) resolve(queued);
      else waiters.push(resolve);
    });

  const send = (msg: object): void => {
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  try {
    await fn(send, next);
  } finally {
    child.kill('SIGTERM');
  }
}

let msgId = 0;
function rpc(
  method: string,
  params: unknown,
): { id: number; jsonrpc: '2.0'; method: string; params: unknown } {
  return { jsonrpc: '2.0', id: ++msgId, method, params };
}

describe('nemesis-mcp stdio server', () => {
  it('serves tools/list and nemesis_audit', async () => {
    await withServer(async (send, next) => {
      send(
        rpc('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'smoke', version: '0.0.1' },
        }),
      );
      const init = await next();
      expect(init.id).toBe(1);

      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send(rpc('tools/list', {}));
      const list = await next();
      const result = list.result as { tools: Array<{ name: string }> };
      const names = result.tools.map((t) => t.name).sort();
      expect(names).toEqual(['nemesis_audit', 'nemesis_stale_fixtures', 'nemesis_verify_symbol']);

      send(
        rpc('tools/call', {
          name: 'nemesis_audit',
          arguments: { paths: ['fixtures'], strictness: 'all' },
        }),
      );
      const call = await next();
      const callResult = call.result as { content: Array<{ text: string }> };
      const payload = JSON.parse(callResult.content[0].text);
      expect(payload.summary.doubles_inspected).toBeGreaterThan(0);
      expect(payload.violations.length).toBeGreaterThan(0);

      // The server reports the manifest version rather than a literal that
      // silently falls behind it.
      const serverInfo = (init.result as { serverInfo: { version: string } }).serverInfo;
      expect(serverInfo.version).toBe(packageVersion());

      // `exclude` is what lets an agent audit a repository that keeps
      // deliberately broken drift fixtures, this one included.
      send(
        rpc('tools/call', {
          name: 'nemesis_audit',
          arguments: { strictness: 'all', exclude: ['fixtures'] },
        }),
      );
      const excluded = await next();
      const excludedPayload = JSON.parse(
        (excluded.result as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(excludedPayload.violations).toEqual([]);

      // A failing scan comes back as a readable tool error, not a rejection.
      send(
        rpc('tools/call', {
          name: 'nemesis_audit',
          arguments: { paths: ['no/such/path'] },
        }),
      );
      const failed = await next();
      const failedResult = failed.result as {
        isError?: boolean;
        content: Array<{ text: string }>;
      };
      expect(failedResult.isError).toBe(true);
      expect(failedResult.content[0].text).toContain('nemesis_audit failed');

      // verify_symbol carries a count an agent can branch on.
      send(
        rpc('tools/call', {
          name: 'nemesis_verify_symbol',
          arguments: { symbol: 'UserService' },
        }),
      );
      const verify = await next();
      const verifyPayload = JSON.parse(
        (verify.result as { content: Array<{ text: string }> }).content[0].text,
      );
      expect(verifyPayload.summary.invalid).toBeGreaterThan(0);
    });
  }, 180_000);
});
