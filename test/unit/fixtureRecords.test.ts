import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkFixtures } from '../../src/fixtures/staleFixtures.js';

let root = '';

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = '';
});

async function project(dto: string, name: string, fixture: unknown): Promise<string[]> {
  root = await mkdtemp(path.join(os.tmpdir(), 'nemesis-records-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'fixtures'), { recursive: true });
  await writeFile(path.join(root, 'src', 'dto.ts'), dto, 'utf8');
  await writeFile(path.join(root, 'fixtures', name), JSON.stringify(fixture, null, 2), 'utf8');
  const result = await checkFixtures(root);
  return result.violations.map((v) => v.message);
}

// A fixture whose top level IS the record, and which happens to hold an array
// of objects somewhere inside it. The array fallback claimed those items were
// the records and compared each against the whole DTO, so every required field
// was reported missing once per item. One repository produced 5,232 definite
// findings this way, 504 of them against a single correct file.
describe('a fixture whose top level is the record', () => {
  const DTO = `export interface CaptureMeta {
  app: string;
  mode: string;
  run: number;
  gaps: Gap[];
}

export interface Gap {
  kind: string;
  ms: number;
}
`;

  const META = {
    app: 'directus',
    mode: 'baseline',
    run: 1,
    gaps: [
      { kind: 'idle', ms: 12 },
      { kind: 'idle', ms: 40 },
    ],
  };

  it('reads the object itself as the record, not the array inside it', async () => {
    expect(await project(DTO, 'captureMeta.fixture.json', META)).toEqual([]);
  });

  it('still reports a field the record is really missing', async () => {
    const { app: _drop, ...without } = META;
    const messages = await project(DTO, 'captureMeta.fixture.json', without);
    expect(messages.some((m) => m.includes("missing required field 'app'"))).toBe(true);
    // Once, not once per item of the array it happens to contain.
    expect(messages.filter((m) => m.includes("missing required field 'app'"))).toHaveLength(1);
  });

  it('still treats a top-level array as the record list', async () => {
    const LIST = `export interface UserRecord {
  id: string;
  name: string;
}
`;
    const messages = await project(LIST, 'users.fixture.json', [{ id: '1' }, { id: '2' }]);
    expect(messages.filter((m) => m.includes("missing required field 'name'"))).toHaveLength(2);
  });
});

// A JSON scalar compared against a named type cannot be decided without
// resolving the name, and a union alias is not indexed with its members. The
// checker reported `"baseline"` against `mode: Mode` as definite drift, which
// is exactly the "two differing named types" case the README calls a heuristic.
describe('a field declared as a named type', () => {
  const DTO = `export type Mode = 'q' | 'r' | 'baseline';

export interface CaptureMeta {
  app: string;
  mode: Mode;
}
`;

  it('says nothing about a scalar it cannot decide', async () => {
    expect(
      await project(DTO, 'captureMeta.fixture.json', { app: 'directus', mode: 'baseline' }),
    ).toEqual([]);
  });

  it('still reports a scalar against a primitive it can decide', async () => {
    const messages = await project(DTO, 'captureMeta.fixture.json', { app: 7, mode: 'baseline' });
    expect(messages.some((m) => m.includes("has 'app' as int"))).toBe(true);
  });

  it('still reports a required field the record is missing', async () => {
    const messages = await project(DTO, 'captureMeta.fixture.json', { mode: 'baseline' });
    expect(messages.some((m) => m.includes("missing required field 'app'"))).toBe(true);
  });
});
