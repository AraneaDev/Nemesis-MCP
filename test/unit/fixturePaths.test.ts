import { describe, expect, it } from 'vitest';
import { isFixturePath } from '../../src/fixtures/staleFixtures.js';

describe('what counts as a fixture', () => {
  it('accepts data kept beside tests', () => {
    expect(isFixturePath('tests/fixtures/users.json')).toBe(true);
    expect(isFixturePath('test/data.yml')).toBe(true);
    expect(isFixturePath('spec/__snapshots__/render.json')).toBe(true);
    expect(isFixturePath('src/__fixtures__/order.json')).toBe(true);
    expect(isFixturePath('testdata/response.yaml')).toBe(true);
    expect(isFixturePath('app/cassettes/stripe.yml')).toBe(true);
  });

  it('rejects ordinary configuration and lockfiles', () => {
    // These used to be matched against production DTOs and reported as
    // missing every field of whichever class happened to share one key.
    expect(isFixturePath('.pre-commit-config.yaml')).toBe(false);
    expect(isFixturePath('package-lock.json')).toBe(false);
    expect(isFixturePath('tsconfig.json')).toBe(false);
    expect(isFixturePath('docker-compose.yml')).toBe(false);
    expect(isFixturePath('.github/workflows/ci.yml')).toBe(false);
    expect(isFixturePath('docs/YIP/swagger.json')).toBe(false);
  });

  it('rejects files that are not JSON or YAML', () => {
    expect(isFixturePath('tests/fixtures/users.txt')).toBe(false);
    expect(isFixturePath('tests/fixtures/users.php')).toBe(false);
  });

  it('needs a fixture directory, not a fixture-ish file name', () => {
    expect(isFixturePath('users.fixture.json')).toBe(false);
    expect(isFixturePath('tests/users.fixture.json')).toBe(true);
  });

  it('rejects configuration even inside a test corpus', () => {
    // A corpus of miniature projects carries a package.json per case; a
    // two-key one shape-matched a production DTO and was reported stale.
    expect(isFixturePath('tests/corpus/cases/a/package.json')).toBe(false);
    expect(isFixturePath('tests/corpus/cases/a/tsconfig.json')).toBe(false);
    expect(isFixturePath('tests/corpus/cases/a/tsconfig.build.json')).toBe(false);
    expect(isFixturePath('tests/fixtures/docker-compose.yml')).toBe(false);
    expect(isFixturePath('tests/fixtures/vitest.config.json')).toBe(false);
    expect(isFixturePath('tests/fixtures/pnpm-lock.yaml')).toBe(false);
    expect(isFixturePath('tests/fixtures/swagger.json')).toBe(false);
  });

  it('rejects anything under a tooling directory', () => {
    expect(isFixturePath('tests/corpus/case/.cursor/mcp.json')).toBe(false);
    expect(isFixturePath('tests/fixtures/.github/workflows/ci.yml')).toBe(false);
    expect(isFixturePath('tests/fixtures/.vscode/launch.json')).toBe(false);
  });

  it('still accepts ordinary fixture data', () => {
    expect(isFixturePath('tests/fixtures/users.json')).toBe(true);
    expect(isFixturePath('tests/corpus/cases/a/expected-output.json')).toBe(true);
  });
});
