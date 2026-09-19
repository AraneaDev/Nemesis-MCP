import { describe, expect, it } from 'vitest';
import { extractPhpDoubles } from '../../src/extractors/php/doubles.js';

async function doubles(body: string) {
  const src = `<?php
class GatewayTest extends TestCase {
  public function testIt(): void {
${body}
  }
}`;
  const result = await extractPhpDoubles('tests/GatewayTest.php', src);
  return Array.isArray(result) ? result : result.doubles;
}

const methodsOf = (d: { methods: Array<{ name: string }> }) => d.methods.map((m) => m.name);

describe('PHPUnit doubles', () => {
  it('reads createMock with a method chain', async () => {
    const [d] = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
    expect(methodsOf(d!)).toEqual(['charge']);
    expect(d?.returnExpr).toBe('1');
  });

  it('reads createStub', async () => {
    const [d] = await doubles(`    $s = $this->createStub(Gateway::class);
    $s->method('charge')->willReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
  });

  it('reads a bare getMockBuilder chain', async () => {
    const [d] = await doubles(`    $m = $this->getMockBuilder(Gateway::class)->getMock();
    $m->method('charge')->willReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
  });

  it('reads a getMockBuilder chain with configurators in between', async () => {
    // Regression: only a single `->getMock()` was unwrapped, so any builder
    // with a configurator call in the middle produced no double at all.
    const [d] = await doubles(`    $m = $this->getMockBuilder(Gateway::class)
      ->disableOriginalConstructor()
      ->onlyMethods(['charge'])
      ->getMock();
    $m->method('charge')->willReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
    expect(methodsOf(d!)).toEqual(['charge']);
  });

  it('reads arity from expects()->method()->with()', async () => {
    const [d] = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->expects($this->once())->method('charge')->with(1, 2)->willReturn(3);`);
    expect(d?.withArity).toBe(2);
    expect(d?.returnExpr).toBe('3');
  });

  it('reads willReturnMap and willReturnCallback', async () => {
    const [map] = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturnMap([[1, 2, 3]]);`);
    expect(map?.targetSymbol).toBe('Gateway');
    const [cb] = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturnCallback(fn() => 1);`);
    expect(cb?.targetSymbol).toBe('Gateway');
  });

  it('records each configured method separately', async () => {
    const found = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturn(1);
    $m->method('refund')->willReturn(2);`);
    expect(found.flatMap(methodsOf).sort()).toEqual(['charge', 'refund']);
  });

  it('accepts a class named as a string', async () => {
    const [d] = await doubles(`    $m = $this->createMock('App\\\\Gateway');
    $m->method('charge')->willReturn(1);`);
    expect(d?.targetSymbol).toContain('Gateway');
  });
});

describe('Mockery and Pest doubles', () => {
  it('reads Mockery::mock with shouldReceive', async () => {
    const [d] = await doubles(`    $m = Mockery::mock(Gateway::class);
    $m->shouldReceive('charge')->andReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
    expect(methodsOf(d!)).toEqual(['charge']);
  });

  it('reads arity from Mockery with()', async () => {
    const [d] = await doubles(`    $m = Mockery::mock(Gateway::class);
    $m->shouldReceive('charge')->with(1, 2)->andReturn(3);`);
    expect(d?.withArity).toBe(2);
  });

  it('reads a partial mock', async () => {
    // Regression: `makePartial()` sits between the factory and the variable,
    // and the chain was not unwrapped past it.
    const [d] = await doubles(`    $m = Mockery::mock(Gateway::class)->makePartial();
    $m->shouldReceive('charge')->andReturn(1);`);
    expect(d?.targetSymbol).toBe('Gateway');
  });

  it('reads a mock configured to allow protected methods', async () => {
    const [d] = await doubles(
      `    $m = Mockery::mock(Gateway::class)->shouldAllowMockingProtectedMethods();
    $m->shouldReceive('charge')->andReturn(1);`,
    );
    expect(d?.targetSymbol).toBe('Gateway');
  });

  it('reads andReturnUsing', async () => {
    const [d] = await doubles(`    $m = Mockery::mock(Gateway::class);
    $m->shouldReceive('charge')->andReturnUsing(fn() => 1);`);
    expect(d?.targetSymbol).toBe('Gateway');
  });

  it('reads Pest mock() and spy()', async () => {
    const result = await extractPhpDoubles(
      'tests/GatewayTest.php',
      `<?php
it('charges', function () {
  $m = mock(Gateway::class);
  $m->shouldReceive('charge')->andReturn(1);
  $s = spy(Gateway::class);
  $s->shouldReceive('refund')->andReturn(2);
});`,
    );
    const found = Array.isArray(result) ? result : result.doubles;
    expect(found.map((d) => d.targetSymbol)).toEqual(['Gateway', 'Gateway']);
    expect(found.flatMap(methodsOf).sort()).toEqual(['charge', 'refund']);
  });
});

describe('things that are not doubles', () => {
  it('ignores an ordinary method call', async () => {
    expect(await doubles(`    $gateway->charge(1);`)).toEqual([]);
  });

  it('ignores a factory whose result is never configured', async () => {
    const found = await doubles(`    $m = $this->createMock(Gateway::class);`);
    expect(found.flatMap(methodsOf)).toEqual([]);
  });
});

describe('queued return values', () => {
  it('checks every value of willReturnOnConsecutiveCalls', async () => {
    // Only the first value was ever looked at, so a wrong type later in the
    // queue passed unnoticed.
    const found = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturnOnConsecutiveCalls(1, 'two', 3);`);
    expect(found.map((d) => d.returnExpr)).toEqual(['1', "'two'", '3']);
    expect(found.every((d) => methodsOf(d).includes('charge'))).toBe(true);
  });

  it('checks every value of a Mockery andReturn queue', async () => {
    const found = await doubles(`    $m = Mockery::mock(Gateway::class);
    $m->shouldReceive('charge')->andReturn(1, 2);`);
    expect(found.map((d) => d.returnExpr)).toEqual(['1', '2']);
  });

  it('counts arity once, not once per queued value', async () => {
    const found = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->with(1)->willReturnOnConsecutiveCalls(1, 2, 3);`);
    expect(found.map((d) => d.withArity)).toEqual([1, null, null]);
  });

  it('leaves a single willReturn alone', async () => {
    const found = await doubles(`    $m = $this->createMock(Gateway::class);
    $m->method('charge')->willReturn(7);`);
    expect(found).toHaveLength(1);
    expect(found[0]?.returnExpr).toBe('7');
  });
});

describe('partial mocks that name their members', () => {
  it('reads the method list of createPartialMock', async () => {
    const [d] = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->createPartialMock(Ledger::class, ['post', 'reconcile']);`,
    );
    expect(d?.targetSymbol).toBe('Ledger');
    expect(d?.methods.map((m) => m.name)).toEqual(['post', 'reconcile']);
  });

  it('reads onlyMethods and setMethods off a builder chain', async () => {
    const [only] = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->getMockBuilder(Ledger::class)->onlyMethods(['post'])->getMock();`,
    );
    expect(only?.methods.map((m) => m.name)).toEqual(['post']);
    const [set] = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->getMockBuilder(Ledger::class)->setMethods(['settle'])->getMock();`,
    );
    expect(set?.methods.map((m) => m.name)).toEqual(['settle']);
  });

  it('leaves addMethods alone', async () => {
    // `addMethods` exists to add members the class does not declare, so
    // reporting them as missing would be backwards.
    const doubles = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->getMockBuilder(Ledger::class)->addMethods(['brandNew'])->getMock();`,
    );
    expect(doubles).toEqual([]);
  });

  it('skips a name built at runtime', async () => {
    const doubles = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->createPartialMock(Ledger::class, [$dynamic]);`,
    );
    expect(doubles).toEqual([]);
  });

  it("reads Mockery's bracketed partial and drops the brackets from the target", async () => {
    const [d] = await extractPhpDoubles(
      'T.php',
      `<?php $m = Mockery::mock('App\\Ledger[post,settle]');`,
    );
    expect(d?.targetSymbol).toBe('App\\Ledger');
    expect(d?.methods.map((m) => m.name)).toEqual(['post', 'settle']);
  });
});

describe('magic methods', () => {
  it('records __call as a declared member so the analyzer can see it', async () => {
    const [d] = await extractPhpDoubles(
      'T.php',
      `<?php $m = Mockery::mock(Bag::class); $m->shouldReceive('anything')->andReturn(1);`,
    );
    expect(d?.framework).toBe('Mockery');
    expect(d?.methods.map((m) => m.name)).toEqual(['anything']);
  });
});

describe('a configured mock', () => {
  it('names a member per key and pins its return value', async () => {
    const doubles = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->createConfiguredMock(Ledger::class, ['post' => true, 'balance' => 0]);`,
    );
    expect(doubles.map((d) => [d.method, d.returnExpr])).toEqual([
      ['post', 'true'],
      ['balance', '0'],
    ]);
  });

  it('skips a key built at runtime', async () => {
    const doubles = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->createConfiguredMock(Ledger::class, [$dynamic => true]);`,
    );
    expect(doubles).toEqual([]);
  });

  it('recognises the abstract and trait factories too', async () => {
    const [abstract] = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->getMockForAbstractClass(Ledger::class); $m->method('post')->willReturn(true);`,
    );
    expect(abstract?.targetSymbol).toBe('Ledger');
    const [trait] = await extractPhpDoubles(
      'T.php',
      `<?php $m = $this->getMockForTrait(Countable::class); $m->method('count')->willReturn(1);`,
    );
    expect(trait?.targetSymbol).toBe('Countable');
  });
});
