import { describe, expect, it } from 'vitest';
import { extractTsDoubles } from '../../src/extractors/ts/doubles.js';
import { extractPythonDoubles } from '../../src/extractors/python/doubles.js';
import { extractPhpDoubles } from '../../src/extractors/php/doubles.js';
import { analyzeDoubles } from '../../src/core/analyzer.js';
import { addType, emptyGraph } from '../../src/core/symbolGraph.js';
import type { MethodSymbol, SymbolGraph, TestDouble } from '../../src/core/types.js';

function param(name: string, extra: Partial<{ hasDefault: boolean; variadic: boolean }> = {}) {
  return { name, type: null, hasDefault: false, variadic: false, ...extra };
}

function method(name: string, params: ReturnType<typeof param>[]): MethodSymbol {
  return { name, returnType: null, params, visibility: 'public', line: 1 };
}

function mailerGraph(): SymbolGraph {
  const g = emptyGraph();
  addType(g, {
    name: 'Mailer',
    file: 'src/Mailer.ts',
    kind: 'class',
    methods: new Map([
      ['send', method('send', [param('to')])],
      ['retry', method('retry', [{ ...param('attempt'), type: 'number' }])],
      ['all', method('all', [param('parts', { variadic: true })])],
    ]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  addType(g, {
    name: 'App\\Mailer',
    file: 'src/Mailer.php',
    kind: 'class',
    methods: new Map([
      ['send', method('send', [{ ...param('to'), type: 'string' }])],
      ['all', method('all', [param('parts', { variadic: true })])],
    ]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  // The same class on the Python side: resolution stays inside a language
  // family, so a Python double never reaches the TypeScript declaration.
  addType(g, {
    name: 'Mailer',
    file: 'app/mailer.py',
    kind: 'class',
    methods: new Map([['send', method('send', [param('to')])]]),
    unknownMembers: new Set(),
    extends: [],
    implements: [],
    uses: [],
    line: 1,
  });
  return g;
}

function findings(doubles: TestDouble[], file: string, lines: string[]) {
  return analyzeDoubles({
    doubles,
    graph: mailerGraph(),
    fileLines: new Map([[file, lines]]),
    options: { strictness: 'all' },
  });
}

/** Only the arity findings: these fixtures declare no return types. */
async function arity(body: string) {
  const { found } = await tsRun(body);
  return found.filter((f) => f.type === 'ARITY_MISMATCH');
}

async function tsRun(body: string) {
  const source = `const mailer = new Mailer();\n${body}\n`;
  const { doubles } = await extractTsDoubles('a.test.ts', source, 'typescript');
  return { doubles, found: findings(doubles, 'a.test.ts', source.split('\n')) };
}

describe('a replacement function that outlived the signature', () => {
  it('reports a fake declaring a parameter the method does not have', async () => {
    const { found } = await tsRun(
      `vi.spyOn(mailer, 'send').mockImplementation((to, subject) => true);`,
    );
    expect(found[0]?.type).toBe('ARITY_MISMATCH');
    expect(found[0]?.message).toContain('declares 2 parameter(s)');
  });

  it('accepts a fake that ignores arguments', async () => {
    // Taking fewer is how most fakes are written and says nothing about drift.
    // The methods here declare no return type, so the concise body raises an
    // untyped warning of its own. Arity is what this asserts about.
    expect(await arity(`vi.spyOn(mailer, 'send').mockImplementation(() => true);`)).toEqual([]);
    expect(await arity(`vi.spyOn(mailer, 'send').mockImplementation((to) => true);`)).toEqual([]);
  });

  it('says nothing when the method is variadic', async () => {
    expect(await arity(`vi.spyOn(mailer, 'all').mockImplementation((a, b, c) => 1);`)).toEqual([]);
  });

  it('says nothing about a rest parameter or a function passed by name', async () => {
    expect(await arity(`vi.spyOn(mailer, 'send').mockImplementation((...args) => true);`)).toEqual(
      [],
    );
    expect(await arity(`vi.spyOn(mailer, 'send').mockImplementation(existingFake);`)).toEqual([]);
  });

  it('reports a parameter the fake types differently', async () => {
    const found = await arity(
      `vi.spyOn(mailer, 'retry').mockImplementation((attempt: string) => true);`,
    );
    expect(found[0]?.message).toContain("parameter 1 as 'string'");
  });

  it('says nothing when the fake agrees, or says nothing about the type', async () => {
    expect(
      await arity(`vi.spyOn(mailer, 'retry').mockImplementation((attempt: number) => true);`),
    ).toEqual([]);
    expect(await arity(`vi.spyOn(mailer, 'retry').mockImplementation((attempt) => true);`)).toEqual(
      [],
    );
    expect(
      await arity(`vi.spyOn(mailer, 'retry').mockImplementation((attempt: any) => true);`),
    ).toEqual([]);
  });

  it('reads a concise body as the return value', async () => {
    const { doubles } = await tsRun(`vi.spyOn(mailer, 'send').mockImplementation(() => 'yes');`);
    expect(doubles[0]?.returnExpr).toBe("'yes'");
    expect(doubles[0]?.returnTypeHint).toBe('string');
  });

  it('leaves a block body alone', async () => {
    const { doubles } = await tsRun(
      `vi.spyOn(mailer, 'send').mockImplementation(() => { return true; });`,
    );
    expect(doubles[0]?.returnExpr).toBeNull();
  });

  it('reports the same drift through a Python side_effect lambda', async () => {
    const source = [
      'def test_send(mocker):',
      '    mocker.patch.object(Mailer, "send", side_effect=lambda to, subject: True)',
      '',
    ].join('\n');
    const doubles = await extractPythonDoubles('test_a.py', source);
    expect(findings(doubles, 'test_a.py', source.split('\n'))[0]?.message).toContain(
      'declares 2 parameter(s)',
    );
  });

  it('drops a receiver the lambda declares for autospec', async () => {
    // `autospec=True` hands the lambda the instance, so `self` is not an
    // argument the caller passes any more than it is on the method.
    const source = [
      'def test_send(mocker):',
      '    mocker.patch.object(Mailer, "send", autospec=True, side_effect=lambda self, to: True)',
      '',
    ].join('\n');
    const doubles = await extractPythonDoubles('test_a.py', source);
    expect(findings(doubles, 'test_a.py', source.split('\n'))).toEqual([]);
  });

  it('reports the same drift through a PHPUnit callback', async () => {
    const source = [
      '<?php',
      'use App\\Mailer;',
      '$m = $this->createMock(Mailer::class);',
      "$m->method('send')->willReturnCallback(function (string $to, bool $subject) { return true; });",
      '',
    ].join('\n');
    const doubles = await extractPhpDoubles('MailerTest.php', source);
    const found = findings(doubles, 'MailerTest.php', source.split('\n'));
    expect(found[0]?.message).toContain('declares 2 parameter(s)');
  });

  it('reports a PHP callback that types a parameter differently', async () => {
    const source = [
      '<?php',
      'use App\\Mailer;',
      '$m = $this->createMock(Mailer::class);',
      "$m->method('send')->willReturnCallback(fn (int $to) => true);",
      '',
    ].join('\n');
    const doubles = await extractPhpDoubles('MailerTest.php', source);
    const found = findings(doubles, 'MailerTest.php', source.split('\n'));
    expect(found[0]?.message).toContain("parameter 1 as 'int'");
  });

  it('does not read a PHP callback as a return value', async () => {
    // `willReturnCallback('handler')` names a function. Read as a value it
    // looked like a stub returning the string 'handler'.
    const source = [
      '<?php',
      'use App\\Mailer;',
      '$m = $this->createMock(Mailer::class);',
      "$m->method('send')->willReturnCallback('handler');",
      '',
    ].join('\n');
    const doubles = await extractPhpDoubles('MailerTest.php', source);
    expect(doubles.every((d) => d.returnExpr === null)).toBe(true);
    expect(findings(doubles, 'MailerTest.php', source.split('\n'))).toEqual([]);
  });

  it('says nothing about a PHP callback taking the arguments it is given', async () => {
    const source = [
      '<?php',
      'use App\\Mailer;',
      '$m = $this->createMock(Mailer::class);',
      "$m->method('send')->willReturnCallback(fn (string $to) => true);",
      "$m->method('all')->willReturnCallback(fn ($a, $b, $c) => 1);",
      "$m->method('send')->willReturnCallback(function ($a, ...$rest) { return true; });",
      '',
    ].join('\n');
    const doubles = await extractPhpDoubles('MailerTest.php', source);
    expect(findings(doubles, 'MailerTest.php', source.split('\n'))).toEqual([]);
  });

  it('says nothing about a side_effect that is not a lambda', async () => {
    const source = [
      'def test_send(mocker):',
      '    mocker.patch.object(Mailer, "send", side_effect=ValueError)',
      '',
    ].join('\n');
    const doubles = await extractPythonDoubles('test_a.py', source);
    expect(doubles.every((d) => d.fakeArity === undefined)).toBe(true);
  });
});

describe('a spy pointed at the wrong object', () => {
  function clockGraph(): SymbolGraph {
    const g = emptyGraph();
    addType(g, {
      name: 'Clock',
      file: 'src/Clock.ts',
      kind: 'class',
      methods: new Map([
        ['now', { ...method('now', []), modifiers: ['static'] }],
        ['format', method('format', [param('at')])],
      ]),
      unknownMembers: new Set(),
      extends: [],
      implements: [],
      uses: [],
      line: 1,
    });
    return g;
  }

  async function run(body: string) {
    const source = `const clock = new Clock();\n${body}\n`;
    const { doubles } = await extractTsDoubles('a.test.ts', source, 'typescript');
    return analyzeDoubles({
      doubles,
      graph: clockGraph(),
      fileLines: new Map([['a.test.ts', source.split('\n')]]),
      options: { strictness: 'all' },
    });
  }

  it('reports an instance method spied on the class', async () => {
    const found = await run(`vi.spyOn(Clock, 'format');`);
    expect(found[0]?.message).toContain("'format' is an instance method of 'Clock'");
  });

  it('reports a static method spied on an instance', async () => {
    const found = await run(`vi.spyOn(clock, 'now');`);
    expect(found[0]?.message).toContain("'now' is static on 'Clock'");
  });

  it('accepts each of them on the object that carries it', async () => {
    expect(await run(`vi.spyOn(Clock, 'now');`)).toEqual([]);
    expect(await run(`vi.spyOn(clock, 'format');`)).toEqual([]);
  });

  it('treats a prototype spy as the instance side', async () => {
    expect(await run(`vi.spyOn(Clock.prototype, 'format');`)).toEqual([]);
    const found = await run(`vi.spyOn(Clock.prototype, 'now');`);
    expect(found[0]?.message).toContain("'now' is static on 'Clock'");
  });

  it('checks members of a prototype spy, which used to resolve to nothing', async () => {
    const found = await run(`vi.spyOn(Clock.prototype, 'formatt');`);
    expect(found[0]?.type).toBe('GHOST_METHOD');
    expect(found[0]?.suggestion).toBe('format');
  });

  it('says nothing when the receiver decides neither', async () => {
    // `this.clock` names a member, not a class and not an instance variable
    // this file declared, so the spy's receiver is simply unknown.
    expect(await run(`vi.spyOn(this.clock, 'format');`)).toEqual([]);
  });
});
