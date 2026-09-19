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

async function project(dto: string, fixture: unknown): Promise<string[]> {
  root = await mkdtemp(path.join(os.tmpdir(), 'nemesis-nested-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'fixtures'), { recursive: true });
  await writeFile(path.join(root, 'src', 'dto.ts'), dto, 'utf8');
  await writeFile(
    path.join(root, 'fixtures', 'consignments.fixture.json'),
    JSON.stringify(fixture, null, 2),
    'utf8',
  );
  const result = await checkFixtures(root);
  return result.violations.map((v) => v.message);
}

const DTO = `export interface ShippingAddress {
  street: string;
  city: string;
}

export interface ConsignmentRecord {
  reference: string;
  destination: ShippingAddress;
  stops: ShippingAddress[];
  lookup: Record<string, ShippingAddress>;
}
`;

function consignment(over: Record<string, unknown> = {}) {
  return [
    {
      reference: 'CN-1',
      destination: { street: 'Kanaalweg', city: 'Utrecht' },
      stops: [{ street: 'Havenkade', city: 'Rotterdam' }],
      lookup: {},
      ...over,
    },
  ];
}

describe('a fixture whose nested object drifted', () => {
  it('reports a renamed field inside a nested object', async () => {
    const messages = await project(
      DTO,
      consignment({ destination: { street: 'Kanaalweg', town: 'Utrecht' } }),
    );
    expect(messages).toContain(
      "Fixture 'consignments.fixture.json' is missing required field 'destination.city' of ShippingAddress.",
    );
    expect(
      messages.some((m) => m.includes("field 'destination.town' which no longer exists")),
    ).toBe(true);
  });

  it('reports it inside each element of a nested array', async () => {
    const messages = await project(
      DTO,
      consignment({
        stops: [
          { street: 'A', city: 'X' },
          { street: 'B', town: 'Y' },
        ],
      }),
    );
    expect(messages.some((m) => m.includes("field 'stops.city' of ShippingAddress"))).toBe(true);
    expect(messages.filter((m) => m.includes('stops.')).length).toBe(2);
  });

  it('says nothing when the nested object still fits', async () => {
    expect(await project(DTO, consignment())).toEqual([]);
  });

  it('leaves a map of the nested type alone', async () => {
    // The keys of a `Record<string, T>` are data. Descending into it would
    // report every one of them as a field that no longer exists.
    expect(await project(DTO, consignment({ lookup: { 'anything at all': {} } }))).toEqual([]);
  });

  it('does not loop on a type that contains itself', async () => {
    const recursive = `export interface Leg {
  label: string;
  next: Leg | null;
}

export interface ConsignmentRecord {
  reference: string;
  route: Leg;
}
`;
    const deep = (depth: number): unknown =>
      depth === 0 ? { label: 'end', next: null } : { label: `n${depth}`, next: deep(depth - 1) };
    const messages = await project(recursive, [{ reference: 'CN-1', route: deep(8) }]);
    expect(messages).toEqual([]);
  });
});
